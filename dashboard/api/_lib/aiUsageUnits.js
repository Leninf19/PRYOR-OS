// Phase B.4 -- commercial AI usage metering. Centralized, versioned
// per-model usage-unit weighting for `aiAllowanceMonthly.usageUnits`
// (planEntitlements.js). `usageUnits` is a PROVISIONAL, INTERNAL, VERSIONED
// weighted cost unit -- never a raw token count, never surfaced to
// customers as one (see planEntitlements.js's own header comment on
// aiAllowanceMonthly). Every per-model multiplier lives HERE and only
// here -- no endpoint may compute its own weighting inline; that is
// exactly the "scattered magic multipliers" this module exists to avoid.

// Bump this whenever the weight table below changes in a way that would
// make historically-recorded usageUnits not directly comparable to newly
// recorded ones (aiUsageStore.js does not currently store this version
// per-record -- see that file's header for why raw token counts are kept
// alongside the weighted total: recalibration must be possible without
// having thrown away the inputs a new version would need).
export const AI_USAGE_UNIT_WEIGHTS_VERSION = 1

// Deliberately provisional launch-calibration ratios, not a precise mirror
// of Anthropic's real per-model list pricing -- the exact numbers are
// expected to be recalibrated once real production usage data exists.
// Sonnet's weights are intentionally several times Haiku's for both input
// and output, and output is weighted heavier than input for both models
// (generation is the more expensive half of a call) -- but the exact
// multipliers are not a pricing commitment.
const MODEL_WEIGHTS = Object.freeze({
  'claude-haiku-4-5-20251001': Object.freeze({ inputWeight: 1, outputWeight: 4 }),
  'claude-sonnet-4-6':         Object.freeze({ inputWeight: 5, outputWeight: 20 }),
})

// Fail-safe default for any model string not in the table above (a future
// model swap, a typo, a test double) -- deliberately the MOST expensive
// known weighting, never the cheapest and never zero. An unrecognized
// model must never be treated as free; that would silently defeat the
// whole quota.
const DEFAULT_WEIGHT = Object.freeze({ inputWeight: 5, outputWeight: 20 })

function weightsForModel(model) {
  return MODEL_WEIGHTS[model] ?? DEFAULT_WEIGHT
}

// calculateAiUsageUnits({ model, inputTokens, outputTokens }) -> integer.
// Pure function -- no I/O, no clamping to any allowance (that is the
// caller's job, comparing this against entitlements.limits.aiAllowanceMonthly).
// Non-finite/negative token counts are treated as 0 rather than thrown on,
// since callers pass values parsed from a third-party API response that
// this module must never trust blindly (see aiUsageStore.js callers'
// handling of a malformed/missing `usage` block).
export function calculateAiUsageUnits({ model, inputTokens, outputTokens }) {
  const { inputWeight, outputWeight } = weightsForModel(model)
  const safeInput = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0
  const safeOutput = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0
  return Math.round(safeInput * inputWeight + safeOutput * outputWeight)
}

// --- Phase B.4 final cost-metering correction -----------------------------
// ACCOUNTING-LEVEL INTEGRITY CONTRACT (distinct from calculateAiUsageUnits()'s
// own pure-helper safety above): calculateAiUsageUnits() safely mapping a
// malformed token count to 0 is correct AT THAT LEVEL, but a caller must
// NEVER let a genuinely SUCCESSFUL Anthropic response (PRYOR already paid
// for it) end up recording zero usage just because the provider's own
// `usage` metadata was missing or malformed. resolveTokenCounts() below is
// the one place that decision is made, so no endpoint computes its own
// fallback inline.
//
// A field is only ever estimated when it is genuinely UNUSABLE -- missing,
// non-numeric, or negative. A provider-reported, validly-zero value (e.g.
// `input_tokens: 0`) is accepted as-is and is NEVER replaced by an
// estimate; it is a real report, not a malformed one.

// Deliberately conservative (a SMALLER divisor than the commonly-cited
// ~4 chars/token) so an input estimate never UNDER-counts real provider
// cost -- err toward cost protection, never toward free usage. This is an
// estimate, not real precision; it exists only for the rare case where
// Anthropic's own accounting metadata cannot be trusted at all.
const CONSERVATIVE_CHARS_PER_INPUT_TOKEN = 3

function isUsableTokenCount(value) {
  return Number.isFinite(value) && value >= 0
}

// A character count is a value already known locally (the actual prompt
// this request sent) -- never derived from the model's response. Floors at
// 1 so a non-empty, successful call can never estimate to literally zero
// input tokens.
function estimateInputTokensFromChars(chars) {
  const safeChars = Number.isFinite(chars) && chars > 0 ? chars : 0
  return Math.max(1, Math.ceil(safeChars / CONSERVATIVE_CHARS_PER_INPUT_TOKEN))
}

// Resolves the token counts to actually RECORD for one completed
// (upstream.ok) Anthropic call, falling back to a conservative estimate
// PER FIELD independently when that field's provider-reported value is
// unusable:
//   - input fallback: estimated from the request's own prompt length
//     (promptChars) -- a real, already-known local value.
//   - output fallback: the request's own configured `max_tokens` ceiling
//     (maxTokens) -- a "bounded output reservation." Using the model's
//     OWN response-text length instead would still be a real value in
//     hand rather than a true estimate, but max_tokens is deliberately
//     used here as the single simplest, most conservative (never
//     under-counting) bound, and keeps this function's inputs limited to
//     values known BEFORE the response body is trusted at all.
// Returns { inputTokens, outputTokens, inputEstimated, outputEstimated } --
// the two boolean flags let a caller record (never storing any content)
// whether this call's accounting is genuine provider-reported data or a
// fallback estimate, for later reconciliation/recalibration.
export function resolveTokenCounts({ rawUsage, promptChars, maxTokens }) {
  const usage = rawUsage ?? {}
  const inputUsable = isUsableTokenCount(usage.input_tokens)
  const outputUsable = isUsableTokenCount(usage.output_tokens)
  const safeMaxTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0
  return {
    inputTokens: inputUsable ? usage.input_tokens : estimateInputTokensFromChars(promptChars),
    outputTokens: outputUsable ? usage.output_tokens : safeMaxTokens,
    inputEstimated: !inputUsable,
    outputEstimated: !outputUsable,
  }
}
