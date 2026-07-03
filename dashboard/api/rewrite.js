// Vercel serverless function — AI tone rewrite for review responses
// Requires ANTHROPIC_API_KEY in Vercel environment variables.
// POST /api/rewrite  { tone, reviewText, currentDraft, reviewerName, location, stars }
// Returns           { rewritten: string }

const TONE_GUIDES = {
  friendly:     'Warm, conversational, and approachable. Like a friendly local business owner who genuinely cares.',
  professional: 'Formal, polished, and business-appropriate. Represent the brand with professionalism.',
  short:        'Very brief — 2 sentences maximum. Acknowledge and invite them back. Nothing more.',
  warm:         'Deeply empathetic and caring. Make them feel truly heard and that their experience matters.',
  apologetic:   'Lead with a sincere, specific apology. Own the experience fully and promise concrete improvement.',
  personal:     'Personal and human. Address them by name. Write as if you personally know this guest.',
  seo:          'Weave in natural keywords: restaurant name, city, Mexican food, hospitality, dining experience. No keyword stuffing.',
  spanish:      'Write entirely in Spanish. Warm and professional tone. Do not include any English.',
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

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

  const toneGuide = TONE_GUIDES[tone] ?? TONE_GUIDES.friendly

  const prompt = `You are the owner of Los Tres Amigos, a Mexican restaurant group with 21 locations. Write a response to this Google review.

TONE: ${toneGuide}

REVIEWER: ${reviewerName || 'A guest'}
STAR RATING: ${stars ?? 1} out of 5
LOCATION: ${location || 'our restaurant'}
REVIEW TEXT: ${reviewText || '(Rating only — no written review)'}

CURRENT DRAFT (for reference — improve and match the requested tone):
${currentDraft || '(No draft — write from scratch)'}

Write ONLY the response text. No quotes, no labels, no "Here is the response:" preamble. Sign off naturally. Maximum 4096 characters.`

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
        max_tokens: 400,
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

    return res.status(200).json({ rewritten })
  } catch (err) {
    return res.status(500).json({ error: err?.message ?? 'Unexpected server error' })
  }
}
