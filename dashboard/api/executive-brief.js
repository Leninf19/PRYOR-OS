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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const account = await requireAuth(req, res, ['owner', 'marketing'])
  if (!account) return

  const allowed = await enforceRateLimit(req, res, `executive-brief:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

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
      return res.status(502).json({ error: `Anthropic API error ${upstream.status}: ${errBody}` })
    }

    const data     = await upstream.json()
    const briefing = data?.content?.[0]?.text?.trim() ?? ''

    if (!briefing) {
      return res.status(502).json({ error: 'Anthropic returned an empty response. Try again.' })
    }

    return res.status(200).json({ briefing })
  } catch (err) {
    return res.status(500).json({ error: err?.message ?? 'Unexpected server error' })
  }
}
