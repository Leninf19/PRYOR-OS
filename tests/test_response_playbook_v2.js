// Review Response Playbook v2 -- PART 27 (test matrix) / PART 28 (signature
// regression). Asserts the actual PROMPT sent to Anthropic (captured via a
// fetch mock, never a real API call) correctly encodes this feature's
// policy: no automatic signature, category-specific guidance for high-risk
// and normal complaint categories, length targets, name/restaurant-name/
// language handling. Complements tests/test_rewrite_policy.js (which covers
// the pure isSeriousIssue()/enforceResponsePolicy() functions and the
// no-text response bank) without duplicating it.
//
// Run directly: node tests/test_response_playbook_v2.js

import { generateRewrite } from '../dashboard/api/_lib/rewriteEngine.js'
import { buildSignOff, DEFAULT_STYLE_PROFILE } from '../dashboard/api/_lib/responseStyleProfile.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

process.env.ANTHROPIC_API_KEY = 'fake-key-for-tests'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
async function run(name, fn) {
  try {
    await fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  }
}

// Captures the exact prompt text sent to Anthropic instead of making a real
// call -- lets these tests assert on POLICY (what the model was told),
// which is the only thing this feature can control deterministically.
function installCapturingFetch(responseText = 'A generated reply about this visit.') {
  let lastPrompt = null
  let calls = 0
  globalThis.fetch = async (url, opts) => {
    calls++
    const body = JSON.parse(opts.body)
    lastPrompt = body.messages[0].content
    return { ok: true, json: async () => ({ content: [{ text: responseText }] }) }
  }
  return { getPrompt: () => lastPrompt, getCalls: () => calls }
}

async function rewrite(fields) {
  return generateRewrite({ tone: 'friendly', ...fields }, { tenantId: DEFAULT_TENANT_ID })
}

const tests = []
function scenario(name, fn) { tests.push([name, fn]) }

// --- PART 1/2/28: no automatic signature under any circumstance -----------

scenario('signatureEnabled defaults to false and buildSignOff returns empty', () => {
  assert(DEFAULT_STYLE_PROFILE.signatureEnabled === false)
  assert(buildSignOff(DEFAULT_STYLE_PROFILE, 'Casa Tequila Prime') === '')
})

scenario('normal positive review prompt never instructs a sign-off/team signature', async () => {
  const { getPrompt } = installCapturingFetch()
  await rewrite({ reviewText: 'Great food and service, we loved it!', stars: 5, location: 'Casa Tequila Prime' })
  const prompt = getPrompt()
  assert(!/Sign off as/i.test(prompt), 'prompt must not instruct a sign-off')
  assert(!/The Casa Tequila Prime Team/i.test(prompt), 'prompt must not reference a team signature')
  assert(/Do not add a signature/i.test(prompt), 'prompt must explicitly forbid a signature')
})

scenario('serious review prompt also never instructs a sign-off/team signature', async () => {
  const { getPrompt } = installCapturingFetch()
  await rewrite({ reviewText: 'I got food poisoning after eating here and ended up in the hospital.', stars: 1, location: 'Casa Tequila Prime' })
  const prompt = getPrompt()
  assert(!/Sign off as/i.test(prompt))
  assert(!/The Casa Tequila Prime Team/i.test(prompt))
})

scenario('prompt explicitly forbids dash/letter-style closings (PART 2)', async () => {
  const { getPrompt } = installCapturingFetch()
  await rewrite({ reviewText: 'Food was cold and the wait was long.', stars: 2 })
  const prompt = getPrompt()
  assert(/Sincerely,/.test(prompt) && /Regards,/.test(prompt), 'prompt must name the forbidden letter-style closings')
})

// --- PART 4: generic corporate phrases discouraged -------------------------

scenario('prompt discourages the PART 4 phrase list', async () => {
  const { getPrompt } = installCapturingFetch()
  await rewrite({ reviewText: 'Service was slow.', stars: 2 })
  const prompt = getPrompt()
  assert(/Thank you for your valuable feedback/.test(prompt))
  assert(/We take all feedback very seriously/.test(prompt))
})

// --- PART 6/7-10: normal complaint categories get specific guidance --------

scenario('rude-staff complaint gets protect-both-parties guidance', async () => {
  const { getPrompt } = installCapturingFetch()
  await rewrite({ reviewText: 'Our server was so rude and dismissive to us the entire meal.', stars: 1 })
  const prompt = getPrompt()
  assert(/protect both the guest and the employee/i.test(prompt), prompt)
})

scenario('price/value complaint gets "do not argue about pricing" guidance', async () => {
  const { getPrompt } = installCapturingFetch()
  await rewrite({ reviewText: 'Way too expensive for what you get, not worth it.', stars: 2 })
  const prompt = getPrompt()
  assert(/Do not argue about pricing/i.test(prompt), prompt)
})

scenario('cleanliness complaint allows defending standards without calling it false', async () => {
  const { getPrompt } = installCapturingFetch()
  await rewrite({ reviewText: 'The table and floor were dirty, not clean at all.', stars: 2 })
  const prompt = getPrompt()
  assert(/cleanliness standards/i.test(prompt), prompt)
})

scenario('disputed-review complaint forbids calling the reviewer a liar', async () => {
  const { getPrompt } = installCapturingFetch()
  await rewrite({ reviewText: 'I never even went there, this must be the wrong location.', stars: 1 })
  const prompt = getPrompt()
  assert(/Do not call the reviewer a liar/i.test(prompt), prompt)
})

scenario('billing complaint forbids admitting an incorrect charge before verification', async () => {
  const { getPrompt } = installCapturingFetch()
  await rewrite({ reviewText: 'I was charged twice for my order, total billing error.', stars: 1 })
  const prompt = getPrompt()
  assert(/before it has been verified/i.test(prompt), prompt)
})

scenario('an ordinary negative review with no matching category still gets a normal (not high-risk) prompt', async () => {
  const { getPrompt } = installCapturingFetch()
  const result = await rewrite({ reviewText: 'Just not a great visit overall, wouldn\'t recommend.', stars: 1 })
  assert(result.riskLevel === 'normal')
  const prompt = getPrompt()
  assert(!/this review may involve a serious concern/i.test(prompt))
})

// --- PART 11/12: food poisoning neutral chronology, no HD absolutism -------

scenario('food-poisoning review gets neutral-chronology guidance, never causation language', async () => {
  const { getPrompt } = installCapturingFetch()
  const result = await rewrite({ reviewText: 'I got food poisoning after eating here last night.', stars: 1 })
  assert(result.riskLevel === 'high_risk')
  const prompt = getPrompt()
  assert(/neutral chronology/i.test(prompt), prompt)
  assert(/our food made you sick/i.test(prompt), prompt)
  assert(/established food-safety procedures and applicable health requirements/i.test(prompt), prompt)
})

// --- PART 13: raw/undercooked food treated as high-risk --------------------

scenario('raw chicken complaint is classified high-risk with unsafe_food guidance', async () => {
  const { getPrompt } = installCapturingFetch()
  const result = await rewrite({ reviewText: 'The chicken was raw chicken in the middle, undercooked.', stars: 1 })
  assert(result.riskLevel === 'high_risk')
  assert(result.riskCategories.includes('unsafe_food'))
  const prompt = getPrompt()
  assert(/do not call the guest dishonest/i.test(prompt), prompt)
})

// --- PART 14: foreign object -----------------------------------------------

scenario('foreign object complaint never states contamination as confirmed fact', async () => {
  const { getPrompt } = installCapturingFetch()
  const result = await rewrite({ reviewText: 'I found a piece of glass in my food.', stars: 1 })
  assert(result.riskLevel === 'high_risk')
  const prompt = getPrompt()
  assert(/could not have come from our kitchen/i.test(prompt), 'prompt must name the forbidden denial phrase')
})

// --- PART 15: allergy -- conditional emergency language only when active ---

scenario('past/resolved allergic reaction does NOT include emergency-care language', async () => {
  const { getPrompt } = installCapturingFetch()
  const result = await rewrite({ reviewText: 'I had an allergic reaction after eating here last week.', stars: 1 })
  assert(result.riskLevel === 'high_risk')
  const prompt = getPrompt()
  assert(!/seek emergency medical care immediately/i.test(prompt), 'must not include emergency language for a past/resolved reaction')
})

scenario('active/severe allergic reaction DOES include emergency-care language', async () => {
  const { getPrompt } = installCapturingFetch()
  const result = await rewrite({ reviewText: 'I am having an allergic reaction right now and having difficulty breathing.', stars: 1 })
  assert(result.riskLevel === 'high_risk')
  const prompt = getPrompt()
  assert(/seek emergency medical care immediately/i.test(prompt), 'must include emergency language for an active severe reaction')
})

// --- PART 19: discrimination/threats/legal ---------------------------------

scenario('discrimination allegation prompt is neutral, forbids legal conclusions', async () => {
  const { getPrompt } = installCapturingFetch()
  const result = await rewrite({ reviewText: 'I was discriminated against and the staff was hostile to me.', stars: 1 })
  assert(result.riskLevel === 'high_risk')
  const prompt = getPrompt()
  assert(/Do not make legal conclusions/i.test(prompt), prompt)
})

scenario('legal threat prompt forbids legal conclusions/admissions', async () => {
  const { getPrompt } = installCapturingFetch()
  const result = await rewrite({ reviewText: 'My lawyer will be in touch, considering legal action.', stars: 1 })
  assert(result.riskLevel === 'high_risk')
  const prompt = getPrompt()
  assert(/Do not make any legal conclusions or admissions/i.test(prompt), prompt)
})

// --- PART 21: length targets -----------------------------------------------

scenario('5-star review gets a 1-2 sentence length target', async () => {
  const { getPrompt } = installCapturingFetch()
  await rewrite({ reviewText: 'Amazing food and service!', stars: 5 })
  assert(/1–2 sentences/.test(getPrompt()))
})

scenario('3-star review gets a 1-2 sentence length target', async () => {
  const { getPrompt } = installCapturingFetch()
  await rewrite({ reviewText: 'It was fine, nothing special.', stars: 3 })
  assert(/1–2 sentences/.test(getPrompt()))
})

scenario('ordinary 1-star review gets a 1-3 sentence length target', async () => {
  const { getPrompt } = installCapturingFetch()
  await rewrite({ reviewText: 'Service was slow and food was cold.', stars: 1 })
  assert(/1–3 sentences/.test(getPrompt()))
})

scenario('serious review gets a 2-4 sentence length target', async () => {
  const { getPrompt } = installCapturingFetch()
  await rewrite({ reviewText: 'I got food poisoning after eating here.', stars: 1 })
  assert(/2–4 sentences/.test(getPrompt()))
})

// --- PART 22: name usage, not forced ----------------------------------------

scenario('reviewer name guidance says "occasionally", never forces salutation', async () => {
  const { getPrompt } = installCapturingFetch()
  await rewrite({ reviewText: 'Great meal!', stars: 5, reviewerName: 'John Smith' })
  const prompt = getPrompt()
  assert(/occasionally if it feels natural/i.test(prompt), prompt)
  assert(/never use a letter-style salutation like "Dear John,"/i.test(prompt), prompt)
})

// --- PART 23: language follows the review, not just the tone dropdown ------

scenario('a review written in Spanish gets a Spanish-language instruction even with the default tone', async () => {
  const { getPrompt } = installCapturingFetch()
  await rewrite({ reviewText: 'Excelente comida y muy buen servicio, gracias!', stars: 5, tone: 'friendly' })
  assert(/Respond entirely and naturally in Spanish/i.test(getPrompt()))
})

scenario('an English review stays English even when nothing forces Spanish', async () => {
  const { getPrompt } = installCapturingFetch()
  await rewrite({ reviewText: 'Great food and service, loved it!', stars: 5, tone: 'friendly' })
  assert(/Write in English/i.test(getPrompt()))
})

// --- PART 24: don't unnecessarily repeat the restaurant's own name --------

scenario('prompt explicitly discourages repeating the restaurant name in the reply', async () => {
  const { getPrompt } = installCapturingFetch()
  await rewrite({ reviewText: 'Great food!', stars: 5, location: 'Casa Tequila Prime' })
  assert(/Do not unnecessarily repeat "Casa Tequila Prime" in the reply itself/i.test(getPrompt()))
})

// --- PART 26: high-risk categories never admit unverified causation --------

scenario('sanitation/pest complaint never claims blanket Health Department compliance', async () => {
  const { getPrompt } = installCapturingFetch()
  const result = await rewrite({ reviewText: 'We saw a rat run across the dining room floor.', stars: 1 })
  assert(result.riskLevel === 'high_risk')
  const prompt = getPrompt()
  assert(/we follow all Health Department regulations/i.test(prompt), 'the forbidden absolute phrasing must be explicitly named so the model avoids it')
  assert(/established food-safety procedures and applicable health requirements/i.test(prompt))
})

for (const [name, fn] of tests) await run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
