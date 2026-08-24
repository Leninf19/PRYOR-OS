// Vercel serverless function — AI tone rewrite for review responses
// Requires ANTHROPIC_API_KEY in Vercel environment variables.
// POST /api/rewrite  { tone, reviewText, currentDraft, reviewerName, location, stars }
// Returns           { rewritten: string }

import { requireScopedAuth } from './_lib/auth.js'
import { Permission } from './_lib/permissions.js'
import { resolveLocationIdForReviewOrDeny } from './_lib/reviewLocationIndex.js'
import { enforceRateLimit } from './_lib/rateLimit.js'

// Multi-Location Authentication & User Access System, Commit 4: gated by
// permission + per-review location (same REPLY/REPLY_ASSIGNED pair as
// publish()/actions' update()), not a flat role array. This endpoint's
// request body has no review identifier today -- `localReviewId` below is
// a new OPTIONAL field; owner/marketing/admin (company-wide) continue
// working unchanged without it, exactly as before. A location-scoped
// caller (location_manager, or a scoped Marketing account) REQUIRES it --
// functionally usable by them once the frontend starts sending it
// (dashboard/src/pages/Reviews.jsx's rewrite call, wired in the
// frontend-scoping commit of this same milestone); until then a scoped
// caller correctly gets 404 rather than an insecure default.
const REWRITE_PERMISSIONS = [Permission.REPLY, Permission.REPLY_ASSIGNED]

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
// to have generated it. Applied to EVERY /api/rewrite response before it's
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const scope = await requireScopedAuth(req, res, {
    permission: REWRITE_PERMISSIONS,
    resolveLocationId: async (req, account) => resolveLocationIdForReviewOrDeny(req.body?.localReviewId, account),
  })
  if (!scope) return
  const { account } = scope

  const allowed = await enforceRateLimit(req, res, `rewrite:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(503).json({
      error: 'ANTHROPIC_API_KEY is not set in Vercel environment variables. Add it at vercel.com → Project → Settings → Environment Variables.',
    })
  }

  const { tone, reviewText, currentDraft, reviewerName, location, stars } = req.body ?? {}

  if (!tone) {
    return res.status(400).json({ error: 'Missing required field: tone' })
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
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages:   [{ role: 'user', content: prompt }],
      }),
    })

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => upstream.statusText)
      return res.status(502).json({ error: `Anthropic API error ${upstream.status}: ${errBody}` })
    }

    const data      = await upstream.json()
    const rewritten = data?.content?.[0]?.text?.trim() ?? ''

    if (!rewritten) {
      return res.status(502).json({ error: 'Anthropic returned an empty response. Try again.' })
    }

    // Phase 3 hard safety guard -- applied regardless of what the model
    // actually returned, not just relied on via the prompt above.
    return res.status(200).json({ rewritten: enforceResponsePolicy(rewritten, serious) })
  } catch (err) {
    return res.status(500).json({ error: err?.message ?? 'Unexpected server error' })
  }
}
