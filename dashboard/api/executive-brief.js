// Vercel serverless function — live executive briefing, generated on demand
// so it can actually reflect whatever date/location/brand filters are
// currently selected (the pipeline-generated company summary only updates
// every 6 hours and always covers a fixed trailing-30-day window).
// Requires ANTHROPIC_API_KEY in Vercel environment variables — same pattern
// as api/rewrite.js.
// POST /api/executive-brief  { periodLabel, prevPeriodLabel, totalReviews, avgRating,
//   avgRatingPrev, positivePct, negativePct, netSentiment, unanswered, topComplaint,
//   topComplaintCount, topPraise, topPraiseCount, bestLocation, bestLocationDelta,
//   worstLocation, worstLocationDelta }
// Returns { briefing: string }

import { requireAuth } from './_lib/auth.js'
import { enforceRateLimit } from './_lib/rateLimit.js'

// "Cap AI input before Anthropic" hardening (Phase A4, revenue-abuse
// containment audit -- ai-unbounded-prompt-input): every client-controlled
// string field below is interpolated directly into the prompt with no
// prior length check, and the metric/count fields are unbounded numbers --
// together they let an authenticated caller drive the billed Sonnet input
// size arbitrarily high. Ceilings set generously above any real label/
// theme/location name this product would ever produce; rejected outright
// (400) before any Anthropic call, never silently truncated.
const MAX_LABEL_CHARS = 120
const MAX_THEME_CHARS = 200
const MAX_LOCATION_NAME_CHARS = 200
// Backstop on the fully-assembled prompt itself, independent of the
// per-field caps above -- catches any future field added to this payload
// without its own explicit limit.
const MAX_PROMPT_CHARS = 6000

function fieldTooLong(value, max) {
  return typeof value === 'string' && value.length > max
}

// Structured, safe usage logging (Phase A4): tenantId/userId/endpoint/
// input+output character counts only -- NEVER the metrics payload or the
// generated briefing text itself.
function logAiUsage({ tenantId, userId, endpoint, inputChars, outputChars }) {
  console.log(`[ai-usage] endpoint=${endpoint} tenantId=${JSON.stringify(tenantId ?? null)} userId=${JSON.stringify(userId ?? null)} inputChars=${inputChars} outputChars=${outputChars ?? 'n/a'}`)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const account = await requireAuth(req, res, ['owner', 'marketing'])
  if (!account) return

  const allowed = await enforceRateLimit(req, res, `executive-brief:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  // "Tenant-level AI safety circuit breaker" hardening (final pre-deploy
  // review, item 1): the per-user limit above is trivially multiplied by
  // inviting more seats (settings/invite-user has no seat cap) -- this is
  // a genuinely SEPARATE bucket, keyed by tenantId, shared by every account
  // in the tenant regardless of who is calling. 30 requests / 10 minutes:
  // useExecutiveBrief.js (dashboard/src/hooks/useExecutiveBrief.js) fires
  // this endpoint on filter changes, debounced 800ms and memoized
  // per-payload for the life of the page -- a single user exploring
  // several distinct filter combinations in one sitting might reasonably
  // trigger 5-10 real calls; this budget comfortably covers 2-3 Owner/
  // Marketing users independently exploring filters in the same 10-minute
  // window, while still bounding a scripted caller to a finite rate no
  // matter how many accounts it uses. Sonnet is materially more expensive
  // per call than rewrite's Haiku (actions/[action].js's 'rewrite' action
  // gets a larger request-count budget over a shorter window, appropriate
  // for its cheaper model and higher call frequency) -- this endpoint's
  // own per-request input caps just above are the sibling defense against
  // a single oversized call. Platform safety circuit breaker, not a plan
  // entitlement.
  const tenantAllowed = await enforceRateLimit(req, res, `executive-brief-tenant:${account.tenantId}`, { requestsPerWindow: 30, windowSeconds: 600 })
  if (!tenantAllowed) {
    console.log(`[ai-tenant-limit] endpoint=executive-brief tenantId=${JSON.stringify(account.tenantId)}`)
    return
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(503).json({
      error: 'ANTHROPIC_API_KEY is not set in Vercel environment variables. Add it at vercel.com → Project → Settings → Environment Variables.',
    })
  }

  const {
    periodLabel, prevPeriodLabel, totalReviews, avgRating, avgRatingPrev,
    positivePct, negativePct, netSentiment, unanswered,
    topComplaint, topComplaintCount, topPraise, topPraiseCount,
    bestLocation, bestLocationDelta, worstLocation, worstLocationDelta,
  } = req.body ?? {}

  if (totalReviews == null) {
    return res.status(400).json({ error: 'Missing metrics payload' })
  }
  if (fieldTooLong(periodLabel, MAX_LABEL_CHARS) || fieldTooLong(prevPeriodLabel, MAX_LABEL_CHARS)) {
    return res.status(400).json({ error: `periodLabel/prevPeriodLabel must be ${MAX_LABEL_CHARS} characters or fewer.` })
  }
  if (fieldTooLong(topComplaint, MAX_THEME_CHARS) || fieldTooLong(topPraise, MAX_THEME_CHARS)) {
    return res.status(400).json({ error: `topComplaint/topPraise must be ${MAX_THEME_CHARS} characters or fewer.` })
  }
  if (fieldTooLong(bestLocation, MAX_LOCATION_NAME_CHARS) || fieldTooLong(worstLocation, MAX_LOCATION_NAME_CHARS)) {
    return res.status(400).json({ error: `bestLocation/worstLocation must be ${MAX_LOCATION_NAME_CHARS} characters or fewer.` })
  }

  const fmtStars = v => (v == null ? 'N/A' : `${v}★`)
  const fmtDelta = v => (v == null ? 'N/A' : `${v > 0 ? '+' : ''}${v}★`)

  const prompt = `You are an executive intelligence assistant for Los Tres Amigos, a Mexican restaurant group.

Write a 4-6 sentence plain-English executive briefing covering what happened this period, why it happened, and what should be prioritized next. Present tense, specific numbers, no bullet points, no headers, no markdown, no preamble.

Period: ${periodLabel || 'selected period'} (vs. ${prevPeriodLabel || 'prior period'})
- Reviews: ${totalReviews}
- Average rating: ${fmtStars(avgRating)} (prior period: ${fmtStars(avgRatingPrev)})
- Positive sentiment: ${positivePct ?? 'N/A'}% · Negative sentiment: ${negativePct ?? 'N/A'}%
- Net sentiment score: ${netSentiment ?? 'N/A'}
- Unanswered negative reviews: ${unanswered ?? 0}
- Top complaint theme: ${topComplaint || 'none identified'} (${topComplaintCount || 0} mentions)
- Top praise theme: ${topPraise || 'none identified'} (${topPraiseCount || 0} mentions)
- Best-improving location: ${bestLocation || 'none with enough data'} (${fmtDelta(bestLocationDelta)} vs prior period)
- Location needing attention: ${worstLocation || 'none with enough data'} (${fmtDelta(worstLocationDelta)} vs prior period)

Write the briefing now:`

  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({ error: 'This request is too large to process.' })
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 400,
        messages:   [{ role: 'user', content: prompt }],
      }),
    })

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => upstream.statusText)
      logAiUsage({ tenantId: account.tenantId, userId: account.userId, endpoint: 'executive-brief', inputChars: prompt.length })
      return res.status(502).json({ error: `Anthropic API error ${upstream.status}: ${errBody}` })
    }

    const data     = await upstream.json()
    const briefing = data?.content?.[0]?.text?.trim() ?? ''

    if (!briefing) {
      logAiUsage({ tenantId: account.tenantId, userId: account.userId, endpoint: 'executive-brief', inputChars: prompt.length, outputChars: 0 })
      return res.status(502).json({ error: 'Anthropic returned an empty response. Try again.' })
    }

    logAiUsage({ tenantId: account.tenantId, userId: account.userId, endpoint: 'executive-brief', inputChars: prompt.length, outputChars: briefing.length })
    return res.status(200).json({ briefing })
  } catch (err) {
    return res.status(500).json({ error: err?.message ?? 'Unexpected server error' })
  }
}
