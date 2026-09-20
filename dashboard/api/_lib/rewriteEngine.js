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
import { classifyReviewRisk, CATEGORY_GUIDANCE } from './reviewRiskClassifier.js'
import { classifyComplaintCategories, COMPLAINT_CATEGORY_GUIDANCE } from './complaintCategoryGuide.js'
import { resolveStyleProfile, buildSignOff, buildPhrasesToAvoidNote } from './responseStyleProfile.js'

const REWRITE_MODEL = 'claude-haiku-4-5-20251001'
const REWRITE_MAX_TOKENS = 300

const CONTACT_EMAIL = 'advertising@l3amigos.com'

// Recovery Milestone 4 (Review Reply Inbox + AI Response Quality) --
// re-exported for existing callers (replyState.js's frontend copy is
// separate by necessity; anything server-side should prefer
// reviewRiskClassifier.js's classifyReviewRisk() directly for the category
// list). Deliberately NOT gated on star rating -- a 5-star review can still
// describe a serious unresolved incident; plenty of 1-star reviews are just
// "slow service", not a serious incident.
export function isSeriousIssue(reviewText) {
  return classifyReviewRisk(reviewText).isHighRisk
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
  return cleaned || draftText.trim() // never return empty; fall back to the whole draft
}

// PART 23 -- a lightweight, deliberately approximate signal that the review
// text itself is written in Spanish: Spanish-only diacritics/punctuation, or
// a handful of very common Spanish words that essentially never appear in an
// English review. False negatives just fall back to English (safe); this is
// not meant to be a general-purpose language detector.
const SPANISH_HINT_RE = /[ñáéíóúü¿¡]|\b(gracias|comida|excelente|servicio|deliciosa|delicioso|atenci[oó]n|volveremos|recomendado|mesero|camarero|muy buena|buenísimo)\b/i

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

// PARTS 5-6 (no-text reviews): a review with NO written text carries zero
// information to respond to specifically -- the only way to guarantee zero
// hallucinated detail (never claiming the guest "enjoyed the tacos and
// margaritas" when they wrote nothing at all) is to never send it to the
// model in the first place. These are plain, pre-written, varied,
// deterministic-to-test human responses selected at random per rating tier
// -- no Anthropic call, no usage/cost, no fabrication risk whatsoever.
// Never applied to reviews that DO have text, however short.
const NO_TEXT_RESPONSES = Object.freeze({
  5: [
    'Thanks so much for the 5 stars! We really appreciate you stopping by and hope to see you again soon.',
    'Really appreciate the 5-star rating — thanks for supporting us!',
    "Thanks for the 5 stars! We're glad you had a great experience.",
    'We appreciate the great rating — thank you for taking the time!',
    'Thank you for the 5 stars! Hope to see you back again soon.',
  ],
  4: [
    'Thanks so much for the kind rating — we really appreciate it!',
    'Thank you for the 4 stars! We appreciate you stopping by.',
    'Really appreciate the rating, thank you!',
    'Thanks for taking the time to leave a rating — we appreciate it.',
  ],
  3: [
    'Thanks for taking the time to rate us — we appreciate it.',
    "Thank you for the rating. We'd love to hear more about your visit if you're willing to share.",
    "Appreciate you leaving a rating. Let us know if there's anything we could have done better.",
  ],
  2: [
    "Thanks for the rating. It sounds like your visit didn't go the way we'd want — we'd appreciate hearing more if you're willing to share.",
    "Sorry to see this rating. We'd like to understand what happened — feel free to reach out with more details.",
  ],
  1: [
    "Sorry to see this rating. Something clearly didn't go right, and we'd like to know more if you're willing to share the details.",
    "This isn't the experience we want for anyone. We'd appreciate the chance to hear more about what happened.",
  ],
})

function pickNoTextResponse(numStars) {
  const tier = NO_TEXT_RESPONSES[numStars] ?? NO_TEXT_RESPONSES[3]
  return tier[Math.floor(Math.random() * tier.length)]
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

  const numStars = Number(stars) || 3

  // PARTS 5-6 -- a review with no written text (null/empty/whitespace-only)
  // NEVER reaches the model at all: see NO_TEXT_RESPONSES's own header for
  // why this is the only way to fully guarantee zero fabricated detail.
  // No API key required, no usage quota consumed, no Anthropic call made.
  if (!reviewText || !String(reviewText).trim()) {
    const rewritten = pickNoTextResponse(numStars)
    logAiUsage({ ...usage, endpoint: 'rewrite', inputChars: 0, outputChars: rewritten.length })
    return { ok: true, rewritten, riskLevel: 'low_risk', riskCategories: [] }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { ok: false, status: 503, error: 'ANTHROPIC_API_KEY is not set in Vercel environment variables. Add it at vercel.com → Project → Settings → Environment Variables.' }
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
  const styleProfile = resolveStyleProfile()
  const { isHighRisk: serious, categories: riskCategories, isActiveEmergency } = classifyReviewRisk(reviewText)

  // PART 23 -- language follows the REVIEW's own language, not just the
  // manager's tone selection: a review clearly written in Spanish gets a
  // natural Spanish reply (never an awkward literal translation) unless the
  // manager explicitly picked the 'spanish' tone (which forces it either
  // way) or picked 'seo' (English keyword copy, kept English on purpose --
  // "Mexican food", the city name, etc. are meant to stay in English).
  const detectedSpanish = tone !== 'seo' && SPANISH_HINT_RE.test(reviewText || '')
  const langNote = tone === 'spanish' || detectedSpanish
    ? 'Language: This review is in Spanish (or the manager requested a Spanish reply). Respond entirely and naturally in Spanish, the way a native speaker actually writes -- never a stiff, literal translation. Do not include any English.'
    : 'Language: Write in English, regardless of the language of the current draft.'

  // PART 21 -- length targets by star tier / severity.
  const lengthGuide = tone === 'short'
    ? 'Length: 2 sentences maximum.'
    : numStars >= 4
      ? 'Length: 1–2 sentences. Brief and grateful.'
      : numStars === 3
        ? 'Length: 1–2 sentences. Neutral and brief.'
        : serious
          ? 'Length: 2–4 sentences. Sincere and specific — this is a serious concern. Only longer than 4 sentences if genuinely necessary.'
          : 'Length: 1–3 sentences. Sincere and to the point.'

  const contactNote = serious
    ? `At the end, invite them to reach out directly: "Please contact us at ${CONTACT_EMAIL} so we can make this right." Do not add anything after that.`
    : `Do not include any contact email, phone number, or "contact us" invitation — that language is reserved for serious unresolved incidents only, which this is not.`

  const emergencyNote = serious && isActiveEmergency
    ? ' The review describes what sounds like an ACTIVE or severe medical reaction (difficulty breathing, anaphylaxis, loss of consciousness) -- include this exact guidance once: "If you\'re currently experiencing difficulty breathing or another severe reaction, please seek emergency medical care immediately." Do not include this emergency language otherwise.'
    : ''

  // PARTS 9-19 -- category-specific policy guidance, only present when a
  // matching category was actually detected. Never a fixed template (see
  // reviewRiskClassifier.js's/complaintCategoryGuide.js's own headers) --
  // the model still writes naturally, constrained by this guidance.
  // High-risk categories (reviewRiskClassifier.js) and ordinary operational
  // complaint categories (complaintCategoryGuide.js) are mutually exclusive
  // by construction (PART 6) -- a review is only run through the second
  // classifier's guidance when it isn't already high-risk.
  const categoryGuidance = riskCategories
    .map(category => CATEGORY_GUIDANCE[category])
    .filter(Boolean)
    .join(' ')
  const complaintCategories = serious ? [] : classifyComplaintCategories(reviewText)
  const complaintGuidance = complaintCategories
    .map(category => COMPLAINT_CATEGORY_GUIDANCE[category])
    .filter(Boolean)
    .join(' ')

  // PART 2 -- natural, human, non-robotic voice. Every one of these notes
  // replaces what used to be a single generic "Write a response to this
  // Google review" opener with explicit anti-cliché/anti-repetition
  // guidance -- the actual behavior change this feature exists to make,
  // not just more prompt text piled onto the same weak instruction.
  const openingVarietyNote = 'Vary how you open the response naturally based on what THIS guest actually said -- never default to "Thank you for your review" or begin every response with "Thank you for..." Tone examples only, not a fixed list to choose from verbatim: positive openings like "Really glad you enjoyed everything" / "Thanks for coming in!" / "Love hearing this."; negative openings like "We\'re sorry this visit missed the mark." / "That\'s definitely not the experience we want for our guests."; serious openings like "We\'re concerned to hear about your experience." / "We take a report like this seriously." Open the way a real, attentive manager would actually start, based on what this specific guest wrote.'
  const voiceNote = 'Sound like a real, attentive restaurant owner or manager texting a genuine reply -- warm, professional, conversational, concise, confident, respectful, and specific to this review. Never robotic, never corporate, never legalistic, never defensive, never over-apologetic, and never obviously AI-generated.'
  const phrasesToAvoidNote = buildPhrasesToAvoidNote(styleProfile)
  const nameNote = reviewerName
    ? `You may use the guest's first name (${reviewerName.split(' ')[0]}) occasionally if it feels natural (e.g. "Thanks for coming in, ${reviewerName.split(' ')[0]}."), but do not force it into every response, and never use a letter-style salutation like "Dear ${reviewerName.split(' ')[0]},".`
    : ''
  const noRepeatNameNote = `Do not unnecessarily repeat "${locationName}" in the reply itself -- the public review page already shows which restaurant is responding.`
  const signOffLine = buildSignOff(styleProfile, locationName)
  const closingNote = signOffLine
    ? `End the response by signing off as '${signOffLine}'.`
    : 'Do not add a signature, name, or sign-off of any kind. Do not end with a dash and a name, "— Restaurant Team", "Sincerely,", "Best,", "Regards,", or "Warmly," -- these are Google review replies, not letters. Simply end the response after its final sentence.'

  const prompt = `You are writing on behalf of ${locationName}, a ${styleProfile.cuisineType} ${styleProfile.businessType}. ${voiceNote} ${openingVarietyNote} ${phrasesToAvoidNote}

Write on behalf of ${locationName} only — do not reference or name any other restaurant or chain. ${noRepeatNameNote}${nameNote ? ` ${nameNote}` : ''}

TONE: ${toneGuide}
${langNote}
${lengthGuide}
${contactNote}${emergencyNote}
${categoryGuidance ? `\nIMPORTANT — this review may involve a serious concern: ${categoryGuidance}\n` : ''}${complaintGuidance ? `\n${complaintGuidance}\n` : ''}
REVIEWER: ${reviewerName || 'A guest'}
STAR RATING: ${numStars} out of 5
REVIEW TEXT: ${reviewText}

CURRENT DRAFT (improve it to match the guidance above):
${currentDraft || '(No draft — write from scratch)'}

Write ONLY the response text. No quotes, no labels, no preamble. ${closingNote}`

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
    return { ok: true, rewritten: finalRewrite, riskLevel: serious ? 'high_risk' : 'normal', riskCategories }
  } catch (err) {
    return { ok: false, status: 500, error: err?.message ?? 'Unexpected server error' }
  }
}
