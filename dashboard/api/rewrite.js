// Vercel serverless function — AI tone rewrite for review responses
// Requires ANTHROPIC_API_KEY in Vercel environment variables.
// POST /api/rewrite  { tone, reviewText, currentDraft, reviewerName, location, stars }
// Returns           { rewritten: string }

const CONTACT_EMAIL = 'advertising@l3amigos.com'

const SERIOUS_KEYWORDS = [
  'sick', 'ill', 'vomit', 'threw up', 'food poison', 'diarrhea', 'stomach',
  'hospital', 'doctor', 'health department', 'health code',
  'cockroach', 'roach', 'rat', 'mouse', 'rodent', 'insect', 'bug', 'pest',
  'injury', 'injured', 'hurt', 'unsafe', 'accident',
  'discrimination', 'racist', 'racism', 'harassment', 'rude', 'hostile', 'threatening',
  'lawsuit', 'lawyer', 'attorney', 'sue', 'legal',
  'police', 'fight', 'assault', 'stole', 'stolen', 'theft',
  'never coming back', 'health violation', 'shut down', 'report',
]

function isSeriousIssue(reviewText, stars) {
  if (!reviewText) return false
  const lower = reviewText.toLowerCase()
  return SERIOUS_KEYWORDS.some(kw => lower.includes(kw)) || Number(stars) === 1
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
  const serious      = isSeriousIssue(reviewText, stars)
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
    : ''

  const prompt = `You are the manager of ${locationName}, a Mexican restaurant. Write a response to this Google review on behalf of ${locationName} only — do not reference or name any other restaurant or chain.

TONE: ${toneGuide}
${langNote}
${lengthGuide}
${contactNote ? contactNote + '\n' : ''}
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

    return res.status(200).json({ rewritten })
  } catch (err) {
    return res.status(500).json({ error: err?.message ?? 'Unexpected server error' })
  }
}
