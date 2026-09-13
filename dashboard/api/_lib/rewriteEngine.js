// AI tone rewrite for review responses -- the business logic previously
// living directly in dashboard/api/rewrite.js (its own standalone Vercel
// function). Relocated here, verbatim, by the PRYOR OS Vercel Serverless
// Function Count Reduction phase: rewrite.js's authorization model
// (REWRITE_PERMISSIONS = [Permission.REPLY, Permission.REPLY_ASSIGNED],
// requireScopedAuth, resolveLocationIdForReviewOrDeny) is IDENTICAL to
// actions/[action].js's own REPLY_PERMISSIONS/requireScopedAuth pattern,
// so the endpoint itself was folded into actions/[action].js as a new
// 'rewrite' action -- see that file for the auth/rate-limit wrapper. This
// module is a pure `_lib` helper (no default export, never itself a
// route) holding only the actual prompt-building/Anthropic-call/response-
// policy logic, unchanged from the original file.
// Requires ANTHROPIC_API_KEY in Vercel environment variables.

import { resolveTenantEntitlements } from './entitlements.js'
import { getAiUsage, recordAiUsage, currentUsagePeriod, AiUsageStoreUnavailableError } from './aiUsageStore.js'
import { calculateAiUsageUnits, resolveTokenCounts } from './aiUsageUnits.js'

const REWRITE_MODEL = 'claude-haiku-4-5-20251001'
const REWRITE_MAX_TOKENS = 300

const CONTACT_EMAIL = 'advertising@l3amigos.com'

// Recovery Milestone 4 (Review Reply Inbox + AI Response Quality): mirrors
// ai_engine.py's _SERIOUS_KEYWORDS/_SERIOUS_RE fix exactly (kept as two
// independent implementations, Python backend vs. this Vercel function, the
// same way this file's keyword list was already a duplicate of ai_engine.py's
// before this change -- see that file's own comment). The previous list
// matched as a naive substring (`lower.includes(kw)`), which fires on
// innocent words containing a keyword -- 'sue' matches inside "no ISSUEs at
// all", 'ill' matches inside "the tacos were griILLed perfectly". Every
// entry is now matched with \b...\b word boundaries.
const SERIOUS_KEYWORDS = [
  'sick', 'ill', 'vomit', 'vomiting', 'food poisoning', 'diarrhea',
  'hospital', 'hospitalized', 'doctor', 'health department', 'health code',
  'cockroach', 'roach', 'rat', 'rats', 'mouse', 'mice', 'rodent', 'rodents',
  'insect', 'insects', 'pest', 'pests',
  'injury', 'injured', 'unsafe', 'accident',
  'discrimination', 'discriminated', 'racist', 'racism', 'harassment', 'harassed',
  'hostile', 'threatening', 'threatened',
  'lawsuit', 'lawyer', 'attorney', 'sue', 'sued', 'legal action',
  'police', 'assault', 'assaulted', 'stole', 'stolen', 'theft',
  'never coming back', 'health violation', 'shut down',
]
const SERIOUS_RE = new RegExp(
  '\\b(' + SERIOUS_KEYWORDS.map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
  'i'
)

// Deliberately NOT gated on star rating -- see ai_engine.py's
// _is_serious_escalation for the same reasoning (a 5-star review can still
// describe a serious unresolved incident; plenty of 1-star reviews are just
// "slow service", not a serious incident).
export function isSeriousIssue(reviewText) {
  if (!reviewText) return false
  return SERIOUS_RE.test(reviewText)
}

// Phase 3 hard safety guard, mirrors ai_engine.py's enforce_response_policy()
// exactly: for any non-serious response, strip any sentence containing
// forbidden recovery/escalation language rather than trusting the model not
// to have generated it. Applied to EVERY rewrite response before it's
// returned, regardless of tone requested.
const FORBIDDEN_RECOVERY_PATTERNS = [
  /contact us[^.!?]*so we can make this right/i,
  /make this right/i,
  /please contact us/i,
  /reach out to us/i,
  /reach out directly/i,
  /contact us at/i,
  new RegExp(CONTACT_EMAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/,      // any email address
  /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/, // any US-style phone number
  /sincerely apologi[sz]e/i,
  /deeply apologi[sz]e/i,
  /give us another chance/i,
]

export function enforceResponsePolicy(draftText, serious) {
  if (serious || !draftText) return draftText
  const sentences = draftText.trim().split(/(?<=[.!?])\s+/)
  const kept = sentences.filter(s => !FORBIDDEN_RECOVERY_PATTERNS.some(p => p.test(s)))
  const cleaned = kept.join(' ').trim()
  return cleaned || draftText.split('—')[0].trim() // never return empty; fall back to the pre-sign-off text
}

const TONE_GUIDES = {
  friendly:     'Warm, conversational, and approachable. Like a friendly local business owner who genuinely cares.',
  professional: 'Formal, polished, and business-appropriate. Represent the brand with professionalism.',
  short:        'Very brief — 2 sentences maximum. Acknowledge and invite them back. Nothing more.',
  warm:         'Deeply empathetic and caring. Make them feel truly heard and that their experience matters.',
  apologetic:   'Lead with a sincere, specific apology. Own the experience fully and promise concrete improvement.',
  personal:     'Personal and human. Address them by name. Write as if you personally know this guest.',
  seo:          'Weave in natural keywords: restaurant name, city, Mexican food, hospitality, dining experience. No keyword stuffing.',
  spanish:      'Warm and professional tone.',
}

// "Cap AI input before Anthropic" hardening (Phase A4, revenue-abuse
// containment audit -- ai-unbounded-prompt-input): every one of these
// fields is interpolated directly into the prompt below with no prior
// length check, so an authenticated caller could previously drive the
// billed input size arbitrarily high (a review or draft field sized to
// just under the model's context window, repeated at the rate limit).
// These ceilings are set generously above any real review/draft/name this
// product would ever produce -- rejected outright (400), never silently
// truncated, so a caller always knows their request was refused rather
// than quietly rewritten.
const MAX_REVIEW_TEXT_CHARS = 4000
const MAX_CURRENT_DRAFT_CHARS = 4000
const MAX_REVIEWER_NAME_CHARS = 200
const MAX_LOCATION_CHARS = 200

function fieldTooLong(value, max) {
  return typeof value === 'string' && value.length > max
}

// Structured, safe usage logging (Phase A4): tenantId/userId/endpoint/
// input+output character counts only -- NEVER the review text, draft, or
// generated reply itself. This is the one place spend-attribution logging
// for this endpoint happens; keep it that way rather than adding ad-hoc
// console.log calls elsewhere that might carry real content.
function logAiUsage({ tenantId, userId, endpoint, inputChars, outputChars }) {
  console.log(`[ai-usage] endpoint=${endpoint} tenantId=${JSON.stringify(tenantId ?? null)} userId=${JSON.stringify(userId ?? null)} inputChars=${inputChars} outputChars=${outputChars ?? 'n/a'}`)
}

// Runs the full rewrite: builds the prompt, calls Anthropic, applies the
// Phase 3 safety guard. Returns { ok: true, rewritten } on success, or
// { ok: false, status, error } (already shaped for the caller's
// res.status(x).json({ error })) on any failure -- the caller (actions/
// [action].js's rewrite action) never has to know Anthropic's response
// shape or this function's internal error handling, matching how every
// other action in this codebase separates auth/response wiring from
// business logic.
// `usage` (optional): { tenantId, userId } -- attached to the structured,
// content-free usage log line only; never required for the function to work.
export async function generateRewrite(body, usage = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { ok: false, status: 503, error: 'ANTHROPIC_API_KEY is not set in Vercel environment variables. Add it at vercel.com → Project → Settings → Environment Variables.' }
  }

  const { tone, reviewText, currentDraft, reviewerName, location, stars } = body ?? {}

  if (!tone) {
    return { ok: false, status: 400, error: 'Missing required field: tone' }
  }
  if (fieldTooLong(reviewText, MAX_REVIEW_TEXT_CHARS)) {
    return { ok: false, status: 400, error: `reviewText must be ${MAX_REVIEW_TEXT_CHARS} characters or fewer.` }
  }
  if (fieldTooLong(currentDraft, MAX_CURRENT_DRAFT_CHARS)) {
    return { ok: false, status: 400, error: `currentDraft must be ${MAX_CURRENT_DRAFT_CHARS} characters or fewer.` }
  }
  if (fieldTooLong(reviewerName, MAX_REVIEWER_NAME_CHARS)) {
    return { ok: false, status: 400, error: `reviewerName must be ${MAX_REVIEWER_NAME_CHARS} characters or fewer.` }
  }
  if (fieldTooLong(location, MAX_LOCATION_CHARS)) {
    return { ok: false, status: 400, error: `location must be ${MAX_LOCATION_CHARS} characters or fewer.` }
  }

  // Phase B.4 -- commercial AI usage quota. An ADDITIONAL layer on top of
  // the Phase A per-user/per-tenant rolling rate limits and the per-request
  // input-size caps above (actions/[action].js's rewrite action enforces
  // the rate limits before ever calling this function; the caps above are
  // unchanged) -- never a replacement for either. Entitlements are resolved
  // FRESH here, immediately before the quota decision and immediately
  // before the (billed) Anthropic call below, never a value captured
  // earlier in the request. `aiAllowanceMonthly.usageUnits === null` means
  // the commercial layer is deliberately UNENFORCED for this tenant
  // (legacy/bootstrap/grandfathered, matching every other null-limit
  // convention in this codebase) -- skip the check entirely. Any other
  // value, including 0 (a fail-closed/unconfigured resolution), is
  // enforced literally: 0 correctly rejects every request outright, never
  // interpreted as unlimited.
  const { tenantId } = usage
  const period = currentUsagePeriod()
  const entitlements = await resolveTenantEntitlements(tenantId)
  const monthlyLimit = entitlements.limits.aiAllowanceMonthly.usageUnits
  if (monthlyLimit !== null) {
    let currentUsage
    try {
      currentUsage = await getAiUsage(tenantId, period)
    } catch (err) {
      if (!(err instanceof AiUsageStoreUnavailableError)) throw err
      console.error(`[rewrite] AI usage store unavailable: ${err.message}`)
      return { ok: false, status: 503, error: 'service_unavailable' }
    }
    if (currentUsage.usageUnits >= monthlyLimit) {
      return { ok: false, status: 403, error: 'ai_quota_exhausted', current: currentUsage.usageUnits, limit: monthlyLimit }
    }
  }

  const toneGuide    = TONE_GUIDES[tone] ?? TONE_GUIDES.friendly
  const locationName = location || 'our restaurant'
  const serious      = isSeriousIssue(reviewText)
  const numStars     = Number(stars) || 3

  const langNote = tone === 'spanish'
    ? 'Language: Write entirely in Spanish. Do not include any English.'
    : 'Language: Write in English, regardless of the language of the current draft or the original review.'

  const lengthGuide = tone === 'short'
    ? 'Length: 2 sentences maximum.'
    : numStars >= 4
      ? 'Length: 1–2 sentences. Brief and grateful.'
      : numStars === 3
        ? 'Length: 2–3 sentences. Appreciative but acknowledge room to improve.'
        : serious
          ? 'Length: 3–4 sentences. Sincere and specific — this is a serious concern.'
          : 'Length: 2–3 sentences. Sincere and to the point.'

  const contactNote = serious
    ? `At the end (before the sign-off), invite them to reach out directly: "Please contact us at ${CONTACT_EMAIL} so we can make this right." Do not add anything after the sign-off.`
    : `Do not include any contact email, phone number, or "contact us" invitation — that language is reserved for serious unresolved incidents only, which this is not.`

  const prompt = `You are the manager of ${locationName}, a Mexican restaurant. Write a response to this Google review on behalf of ${locationName} only — do not reference or name any other restaurant or chain.

TONE: ${toneGuide}
${langNote}
${lengthGuide}
${contactNote}
REVIEWER: ${reviewerName || 'A guest'}
STAR RATING: ${numStars} out of 5
REVIEW TEXT: ${reviewText || '(Rating only — no written review)'}

CURRENT DRAFT (improve it to match the tone and length above):
${currentDraft || '(No draft — write from scratch)'}

Write ONLY the response text. No quotes, no labels, no preamble. Sign off as '— The ${locationName} Team'.`

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      REWRITE_MODEL,
        max_tokens: REWRITE_MAX_TOKENS,
        messages:   [{ role: 'user', content: prompt }],
      }),
    })

    if (!upstream.ok) {
      // Phase B.4: no AI usage is recorded here -- Anthropic did not
      // successfully generate anything, so nothing was actually billed/
      // consumed against this tenant's monthly allowance ("provider
      // failure does not record successful usage").
      const errBody = await upstream.text().catch(() => upstream.statusText)
      logAiUsage({ ...usage, endpoint: 'rewrite', inputChars: prompt.length })
      return { ok: false, status: 502, error: `Anthropic API error ${upstream.status}: ${errBody}` }
    }

    const data      = await upstream.json()
    const rewritten = data?.content?.[0]?.text?.trim() ?? ''

    // Phase B.4 final cost-metering correction: the upstream call itself
    // succeeded (upstream.ok), so Anthropic actually processed and billed
    // this request regardless of what text (if any) came back or whether
    // its OWN usage metadata is trustworthy -- a successful, already-billed
    // call must never be recorded as zero cost. resolveTokenCounts() falls
    // back to a conservative per-field estimate (never silently 0) whenever
    // input_tokens/output_tokens is missing, non-numeric, or negative; a
    // genuinely valid provider-reported 0 is accepted as-is, never
    // replaced. record usage here, unconditionally, BEFORE branching on
    // whether the extracted text was usable.
    const { inputTokens, outputTokens, inputEstimated, outputEstimated } = resolveTokenCounts({
      rawUsage: data?.usage, promptChars: prompt.length, maxTokens: REWRITE_MAX_TOKENS,
    })
    const usageUnits = calculateAiUsageUnits({ model: REWRITE_MODEL, inputTokens, outputTokens })
    const estimated = inputEstimated || outputEstimated
    if (estimated) {
      console.log(`[ai-usage] endpoint=rewrite tenantId=${JSON.stringify(tenantId ?? null)} usage metadata was incomplete/malformed -- recorded a conservative fallback estimate (inputEstimated=${inputEstimated} outputEstimated=${outputEstimated})`)
    }
    await recordAiUsage(tenantId, period, { inputTokens, outputTokens, usageUnits, estimated })

    if (!rewritten) {
      logAiUsage({ ...usage, endpoint: 'rewrite', inputChars: prompt.length, outputChars: 0 })
      return { ok: false, status: 502, error: 'Anthropic returned an empty response. Try again.' }
    }

    // Phase 3 hard safety guard -- applied regardless of what the model
    // actually returned, not just relied on via the prompt above.
    const finalRewrite = enforceResponsePolicy(rewritten, serious)
    logAiUsage({ ...usage, endpoint: 'rewrite', inputChars: prompt.length, outputChars: finalRewrite.length })
    return { ok: true, rewritten: finalRewrite }
  } catch (err) {
    return { ok: false, status: 500, error: err?.message ?? 'Unexpected server error' }
  }
}
