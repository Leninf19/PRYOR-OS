// Regression tests for dashboard/api/_lib/rewriteEngine.js's
// isSeriousIssue()/enforceResponsePolicy() -- the live, on-demand mirror
// of ai_engine.py's classify_response_type()/enforce_response_policy()
// (see tests/test_response_policy.py's own header for the full root-cause
// story). Originally dashboard/api/rewrite.js (its own standalone route);
// the pure policy logic moved to this _lib helper when the route itself
// was merged into actions/[action].js's 'rewrite' action (PRYOR OS Vercel
// Serverless Function Count Reduction) -- byte-identical logic, only the
// file location changed. Tests the pure policy functions directly (both
// are named exports specifically for this) rather than the full HTTP
// handler, since neither touches auth/rate-limit/Anthropic -- see
// actions/[action].js's 'rewrite' case for those, unchanged by this
// milestone.
//
// Run directly: node tests/test_rewrite_policy.js

import { isSeriousIssue, enforceResponsePolicy, generateRewrite } from '../dashboard/api/_lib/rewriteEngine.js'

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

const CASA_TEQUILA_PRIME_REVIEW_TEXT =
  "We had a great experience! Loved the vibe and decor, and the drinks were awesome. " +
  "Food quality was excellent -- the Ribeye Tacos, Carne Asada Tacos, and Tequila Lime " +
  "Chicken were all fantastic. Two small notes: the spice level wasn't obvious on the " +
  "menu description, and the pickled onions weren't listed on the Ribeye Taco description. " +
  "These are small adjustments and it does not take away from the food quality at all -- " +
  "service, food, and vibes were good. We will definitely be back!"

function testCasaTequilaPrimeNeverSerious() {
  assert(!isSeriousIssue(CASA_TEQUILA_PRIME_REVIEW_TEXT),
    'an overwhelmingly positive review must never be flagged serious')
}

function testNoIssuesDoesNotTriggerSueKeyword() {
  assert(!isSeriousIssue("Everything was great, no issues at all, we'll be back!"),
    "'issues' must never match the 'sue' keyword via substring")
}

function testGrilledDoesNotTriggerIllKeyword() {
  assert(!isSeriousIssue("The steak was grilled to perfection, best meal we've had in a while."),
    "'grilled' must never match the 'ill' keyword via substring")
}

function testWholeWordSeriousKeywordStillMatches() {
  assert(isSeriousIssue("I got violently ill after eating here, had to go to the hospital."),
    "a genuine whole-word 'ill'/'hospital' mention must still be detected")
}

function testGuardStripsForbiddenCtaFromNonSeriousResponse() {
  const draft = 'Thank you so much for the kind words! Please contact us at ' +
    'advertising@l3amigos.com so we can make this right. We hope to see you again soon.'
  const cleaned = enforceResponsePolicy(draft, false)
  assert(!cleaned.includes('advertising@l3amigos.com'), 'email must be stripped')
  assert(!cleaned.toLowerCase().includes('make this right'), 'CTA phrase must be stripped')
  assert(cleaned.includes('Thank you') && cleaned.includes('hope to see you again'),
    'the guard must only remove the offending sentence, not the whole response')
}

function testGuardStripsBareEmail() {
  const draft = 'Thanks for visiting! Reach us anytime at manager@example.com. See you soon!'
  const cleaned = enforceResponsePolicy(draft, false)
  assert(!cleaned.includes('manager@example.com'))
}

function testGuardStripsPhoneNumber() {
  const draft = "We appreciate the feedback. Call us at (555) 123-4567 if you'd like to chat. Thanks again!"
  const cleaned = enforceResponsePolicy(draft, false)
  assert(!cleaned.includes('555') && !cleaned.includes('123-4567'))
}

function testGuardLeavesSeriousUntouched() {
  const draft = 'We are very sorry to hear this. Please contact us at advertising@l3amigos.com so we can make this right.'
  const cleaned = enforceResponsePolicy(draft, true)
  assert(cleaned === draft, 'serious responses are the one class allowed to keep the contact CTA')
}

function testGuardNeverReturnsEmpty() {
  const draft = 'Please contact us at advertising@l3amigos.com so we can make this right.'
  const cleaned = enforceResponsePolicy(draft, false)
  assert(cleaned && cleaned.length > 0, 'the guard must never leave the manager with an empty draft')
}

// --- "Cap AI input before Anthropic" hardening (Phase A4) -------------------

process.env.ANTHROPIC_API_KEY = 'fake-key-for-tests'

function installNeverCalledFetch() {
  globalThis.fetch = async (url) => { throw new Error(`Anthropic must not be called, but fetch was invoked for: ${url}`) }
}
function installSuccessFetch() {
  let calls = 0
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ content: [{ text: 'A generated reply.' }] }) } }
  return () => calls
}

async function testOversizedReviewTextRejectedNoFetch() {
  installNeverCalledFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'x'.repeat(5000) })
  assert(result.ok === false && result.status === 400, `expected a 400 rejection, got ${JSON.stringify(result)}`)
}

async function testOversizedCurrentDraftRejectedNoFetch() {
  installNeverCalledFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'fine', currentDraft: 'x'.repeat(5000) })
  assert(result.ok === false && result.status === 400, `expected a 400 rejection, got ${JSON.stringify(result)}`)
}

async function testOversizedReviewerNameRejectedNoFetch() {
  installNeverCalledFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewerName: 'x'.repeat(500) })
  assert(result.ok === false && result.status === 400, `expected a 400 rejection, got ${JSON.stringify(result)}`)
}

async function testOversizedLocationRejectedNoFetch() {
  installNeverCalledFetch()
  const result = await generateRewrite({ tone: 'friendly', location: 'x'.repeat(500) })
  assert(result.ok === false && result.status === 400, `expected a 400 rejection, got ${JSON.stringify(result)}`)
}

async function testWithinLimitsStillSucceeds() {
  const getCalls = installSuccessFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'A perfectly normal review.', currentDraft: 'A draft.', reviewerName: 'Jane', location: 'Casa Tequila' })
  assert(result.ok === true, `a normal-sized request must still succeed, got ${JSON.stringify(result)}`)
  assert(getCalls() === 1, 'exactly one upstream call must have been made')
}

const tests = [
  ['Casa Tequila Prime regression text is never flagged serious', testCasaTequilaPrimeNeverSerious],
  ["'no issues' does not trigger the 'sue' keyword (root cause)", testNoIssuesDoesNotTriggerSueKeyword],
  ["'grilled' does not trigger the 'ill' keyword (root cause)", testGrilledDoesNotTriggerIllKeyword],
  ['a genuine whole-word serious keyword still matches', testWholeWordSeriousKeywordStillMatches],
  ['guard strips forbidden CTA from a non-serious response', testGuardStripsForbiddenCtaFromNonSeriousResponse],
  ['guard strips a bare email even without a known phrase', testGuardStripsBareEmail],
  ['guard strips a phone number', testGuardStripsPhoneNumber],
  ['guard leaves serious responses untouched', testGuardLeavesSeriousUntouched],
  ['guard never returns an empty string', testGuardNeverReturnsEmpty],
  ['PHASE A4: oversized reviewText rejected (400), zero Anthropic calls', testOversizedReviewTextRejectedNoFetch],
  ['PHASE A4: oversized currentDraft rejected (400), zero Anthropic calls', testOversizedCurrentDraftRejectedNoFetch],
  ['PHASE A4: oversized reviewerName rejected (400), zero Anthropic calls', testOversizedReviewerNameRejectedNoFetch],
  ['PHASE A4: oversized location rejected (400), zero Anthropic calls', testOversizedLocationRejectedNoFetch],
  ['PHASE A4: a normal, within-limits request still succeeds', testWithinLimitsStillSucceeds],
]

for (const [name, fn] of tests) await run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
