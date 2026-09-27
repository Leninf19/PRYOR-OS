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

import { isSeriousIssue, enforceResponsePolicy, generateRewrite, resolveReviewResponseContact } from '../dashboard/api/_lib/rewriteEngine.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'
import { _setRedisClientForTests, _resetRedisClientForTests } from '../dashboard/api/_lib/tenantConfigStore.js'

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
  // Tenant-Isolated Review Contact: a serious response is only trusted
  // verbatim when a REAL, resolved contact was actually offered -- the
  // third arg simulates what resolveReviewResponseContact() would have
  // returned for the tenant this draft was generated for.
  const draft = 'We are very sorry to hear this. Please contact us at advertising@l3amigos.com so we can make this right.'
  const cleaned = enforceResponsePolicy(draft, true, 'advertising@l3amigos.com')
  assert(cleaned === draft, 'a serious response with a real, configured contact keeps the contact CTA')
}

function testGuardStripsHallucinatedContactFromSeriousResponseWithNoConfiguredContact() {
  // The tenant has NO configured review contact (resolveReviewResponseContact()
  // returned no email/phone) -- even a serious response must never surface
  // a contact method nobody configured, whether hallucinated by the model
  // or (worse) leaked from another tenant's own address.
  const draft = 'We are very sorry to hear this. Please contact us at advertising@l3amigos.com so we can make this right.'
  const cleaned = enforceResponsePolicy(draft, true, null)
  assert(!cleaned.includes('advertising@l3amigos.com'), 'an unconfigured contact must never leak into a reply, even a serious one')
  assert(cleaned.toLowerCase().includes('sorry'), 'the sincere recovery language must survive -- only the contact-shaped text is stripped')
}

function testGuardKeepsGenericReachOutLanguageForSeriousResponseWithNoConfiguredContact() {
  const draft = 'We take this seriously. Please reach out to us directly so we can make this right.'
  const cleaned = enforceResponsePolicy(draft, true, null)
  assert(cleaned === draft, 'generic, contact-method-free recovery language must survive untouched when no contact is configured')
}

function testGuardNeverLeaksADifferentTenantsContactIntoASeriousResponse() {
  // Simulates the exact cross-tenant leak this feature exists to prevent:
  // the model (or a stale prompt) produced Los Tres Amigos's address for a
  // reply that was actually generated for a DIFFERENT tenant, whose own
  // resolved contact is something else entirely.
  const draft = 'So sorry about this. Please contact us at advertising@l3amigos.com so we can make this right.'
  const cleaned = enforceResponsePolicy(draft, true, 'owner@blueseafoodgrill.example')
  assert(!cleaned.includes('advertising@l3amigos.com'), "another tenant's address must never survive into this tenant's reply")
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
function installCapturingSuccessFetch() {
  let lastPrompt = null
  globalThis.fetch = async (url, opts) => {
    lastPrompt = JSON.parse(opts.body).messages[0].content
    return { ok: true, json: async () => ({ content: [{ text: 'A generated reply.' }] }) }
  }
  return () => lastPrompt
}

// --- Tenant-Isolated Review Contact: resolveReviewResponseContact() --------

const OTHER_TENANT_ID = 't_blue-seafood-grill-dldh5k'

function fakeTenantConfigRedis(records) {
  return {
    hget: async (_key, tenantId) => (records[tenantId] ? JSON.stringify(records[tenantId]) : null),
    hset: async () => {},
  }
}

async function testLtaGetsItsOwnAddressWhenUnconfigured() {
  _setRedisClientForTests(() => fakeTenantConfigRedis({}))
  try {
    const contact = await resolveReviewResponseContact(DEFAULT_TENANT_ID)
    assert(contact.email === 'advertising@l3amigos.com', `LTA must default to its own historical address, got ${JSON.stringify(contact)}`)
  } finally {
    _resetRedisClientForTests()
  }
}

async function testOtherTenantNeverInheritsLtasAddressWhenUnconfigured() {
  _setRedisClientForTests(() => fakeTenantConfigRedis({}))
  try {
    const contact = await resolveReviewResponseContact(OTHER_TENANT_ID)
    assert(contact.email === null && contact.phone === null,
      `an unconfigured non-LTA tenant must get no contact at all, never LTA's address, got ${JSON.stringify(contact)}`)
  } finally {
    _resetRedisClientForTests()
  }
}

async function testOtherTenantGetsItsOwnConfiguredContact() {
  _setRedisClientForTests(() => fakeTenantConfigRedis({
    [OTHER_TENANT_ID]: { reviewContact: { email: 'owner@blueseafoodgrill.example', phone: null } },
  }))
  try {
    const contact = await resolveReviewResponseContact(OTHER_TENANT_ID)
    assert(contact.email === 'owner@blueseafoodgrill.example', `expected the tenant's own configured contact, got ${JSON.stringify(contact)}`)
  } finally {
    _resetRedisClientForTests()
  }
}

async function testConfiguredContactOverridesLtasDefaultToo() {
  _setRedisClientForTests(() => fakeTenantConfigRedis({
    [DEFAULT_TENANT_ID]: { reviewContact: { email: 'newcontact@example.com', phone: null } },
  }))
  try {
    const contact = await resolveReviewResponseContact(DEFAULT_TENANT_ID)
    assert(contact.email === 'newcontact@example.com', 'an explicitly configured contact must win even for LTA itself')
  } finally {
    _resetRedisClientForTests()
  }
}

// --- End-to-end: generateRewrite() prompt reflects the resolved contact ---

async function testSeriousReplyForLtaPromptOffersLtasAddress() {
  _setRedisClientForTests(() => fakeTenantConfigRedis({}))
  try {
    const getPrompt = installCapturingSuccessFetch()
    const result = await generateRewrite(
      { tone: 'friendly', reviewText: 'I got food poisoning and ended up in the hospital.', stars: 1 },
      { tenantId: DEFAULT_TENANT_ID },
    )
    assert(result.ok === true)
    assert(getPrompt().includes('advertising@l3amigos.com'), 'LTA\'s serious-reply prompt must offer its own historical address')
  } finally {
    _resetRedisClientForTests()
  }
}

async function testSeriousReplyForAnotherTenantPromptOffersItsOwnContactNeverLtas() {
  _setRedisClientForTests(() => fakeTenantConfigRedis({
    [OTHER_TENANT_ID]: { reviewContact: { email: 'owner@blueseafoodgrill.example', phone: null } },
  }))
  try {
    const getPrompt = installCapturingSuccessFetch()
    const result = await generateRewrite(
      { tone: 'friendly', reviewText: 'I got food poisoning and ended up in the hospital.', stars: 1 },
      { tenantId: OTHER_TENANT_ID },
    )
    assert(result.ok === true)
    const prompt = getPrompt()
    assert(prompt.includes('owner@blueseafoodgrill.example'), "this tenant's own configured contact must appear in its prompt")
    assert(!prompt.includes('advertising@l3amigos.com'), "LTA's address must never appear in another tenant's prompt")
  } finally {
    _resetRedisClientForTests()
  }
}

async function testSeriousReplyForTenantWithNoConfiguredContactNeverInventsOne() {
  // A real tenant_config record exists (so entitlement resolution treats
  // this as a genuine, known tenant rather than failing closed on an
  // unknown one) -- it simply has no reviewContact set yet, the ordinary
  // "hasn't configured one" case this test is actually about.
  _setRedisClientForTests(() => fakeTenantConfigRedis({ [OTHER_TENANT_ID]: {} }))
  try {
    const getPrompt = installCapturingSuccessFetch()
    const result = await generateRewrite(
      { tone: 'friendly', reviewText: 'I got food poisoning and ended up in the hospital.', stars: 1 },
      { tenantId: OTHER_TENANT_ID },
    )
    assert(result.ok === true)
    const prompt = getPrompt()
    assert(!prompt.includes('advertising@l3amigos.com'), 'an unconfigured tenant must never see LTA\'s address in its own prompt')
    assert(prompt.toLowerCase().includes('do not state or invent any specific email'),
      'the model must be explicitly told not to invent a contact method when none is configured')
  } finally {
    _resetRedisClientForTests()
  }
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
  // Phase B.4: generateRewrite() now resolves commercial AI entitlements
  // before calling Anthropic -- tenantId: DEFAULT_TENANT_ID (Los Tres
  // Amigos' BOOTSTRAP tenant) short-circuits that resolution to the
  // legacy-unmanaged bundle with NO Redis read at all (see entitlements.js),
  // so this pure-policy test file still needs no fake Redis setup.
  const result = await generateRewrite(
    { tone: 'friendly', reviewText: 'A perfectly normal review.', currentDraft: 'A draft.', reviewerName: 'Jane', location: 'Casa Tequila' },
    { tenantId: DEFAULT_TENANT_ID },
  )
  assert(result.ok === true, `a normal-sized request must still succeed, got ${JSON.stringify(result)}`)
  assert(getCalls() === 1, 'exactly one upstream call must have been made')
}

// --- PARTS 5-6/24: no-text reviews -- deterministic, zero-fabrication -------
// A review with no text (null/empty/whitespace) must NEVER reach the model,
// so these assert both the returned shape AND (via installNeverCalledFetch)
// that no Anthropic call was made at all -- the structural guarantee against
// hallucinated detail, not just a hope that the prompt discourages it.

async function testFiveStarNoTextNeverCallsModelAndVaries() {
  installNeverCalledFetch()
  const seen = new Set()
  for (let i = 0; i < 30; i++) {
    const result = await generateRewrite({ tone: 'friendly', reviewText: '', stars: 5 })
    assert(result.ok === true, `no-text 5-star must succeed without an API key/fetch, got ${JSON.stringify(result)}`)
    assert(typeof result.rewritten === 'string' && result.rewritten.length > 0)
    assert(result.riskLevel === 'low_risk' && Array.isArray(result.riskCategories) && result.riskCategories.length === 0)
    seen.add(result.rewritten)
  }
  assert(seen.size > 1, 'a no-text 5-star review must not always produce the identical sentence (PART 5 variation requirement)')
}

async function testWhitespaceOnlyReviewTextTreatedAsNoText() {
  installNeverCalledFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: '   \n\t  ', stars: 5 })
  assert(result.ok === true, 'whitespace-only text must be treated identically to genuinely empty text (no Anthropic call, no error)')
  assert(typeof result.rewritten === 'string' && result.rewritten.length > 0)
}

async function testFourStarNoTextNeverInventsAProblem() {
  installNeverCalledFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: null, stars: 4 })
  assert(result.ok === true)
  assert(!/sorry|apologize|improve|issue|problem/i.test(result.rewritten),
    'a no-text 4-star response must never invent a problem or apologize for one')
}

async function testThreeStarNoTextAcknowledgesNeutrallyWithoutInventing() {
  installNeverCalledFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: undefined, stars: 3 })
  assert(result.ok === true)
  assert(!/tacos|margaritas|specific|the dish|your order/i.test(result.rewritten),
    'a no-text 3-star response must never fabricate specific menu/order details')
}

async function testOneStarNoTextInvitesDetailWithoutInventing() {
  installNeverCalledFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: '', stars: 1 })
  assert(result.ok === true)
  assert(/more|details|happened|share/i.test(result.rewritten),
    'a no-text 1-star response should invite the guest to share what happened, not guess at it')
}

async function testUnknownStarRatingFallsBackToThreeStarTier() {
  installNeverCalledFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: '', stars: 999 })
  assert(result.ok === true, `an out-of-range star value must still resolve to some no-text tier, got ${JSON.stringify(result)}`)
}

// --- PART 24: riskLevel/riskCategories are surfaced on a real (non-empty)
// generation too, driving the publish-time gate and the UI badge --------

async function testHighRiskReviewSurfacesRiskLevelAndCategories() {
  installSuccessFetch()
  const result = await generateRewrite(
    { tone: 'friendly', reviewText: 'I found glass in my food and got injured.', stars: 1 },
    { tenantId: DEFAULT_TENANT_ID },
  )
  assert(result.ok === true)
  assert(result.riskLevel === 'high_risk', `expected high_risk, got ${result.riskLevel}`)
  assert(result.riskCategories.includes('foreign_object') && result.riskCategories.includes('injury'),
    `expected both foreign_object and injury categories, got ${JSON.stringify(result.riskCategories)}`)
}

async function testOrdinaryNegativeReviewIsNormalRiskNotHighRisk() {
  installSuccessFetch()
  const result = await generateRewrite(
    { tone: 'friendly', reviewText: 'The wait was too long and the food came out cold.', stars: 2 },
    { tenantId: DEFAULT_TENANT_ID },
  )
  assert(result.ok === true)
  assert(result.riskLevel === 'normal', `an ordinary negative review must classify as normal, not high_risk, got ${result.riskLevel}`)
  assert(result.riskCategories.length === 0)
}

const tests = [
  ['Casa Tequila Prime regression text is never flagged serious', testCasaTequilaPrimeNeverSerious],
  ["'no issues' does not trigger the 'sue' keyword (root cause)", testNoIssuesDoesNotTriggerSueKeyword],
  ["'grilled' does not trigger the 'ill' keyword (root cause)", testGrilledDoesNotTriggerIllKeyword],
  ['a genuine whole-word serious keyword still matches', testWholeWordSeriousKeywordStillMatches],
  ['guard strips forbidden CTA from a non-serious response', testGuardStripsForbiddenCtaFromNonSeriousResponse],
  ['guard strips a bare email even without a known phrase', testGuardStripsBareEmail],
  ['guard strips a phone number', testGuardStripsPhoneNumber],
  ['guard leaves serious responses untouched when a real contact was offered', testGuardLeavesSeriousUntouched],
  ['guard strips a hallucinated/leaked contact from a serious response with no configured contact', testGuardStripsHallucinatedContactFromSeriousResponseWithNoConfiguredContact],
  ['guard keeps generic reach-out language for a serious response with no configured contact', testGuardKeepsGenericReachOutLanguageForSeriousResponseWithNoConfiguredContact],
  ["guard never lets a different tenant's contact leak into a serious response", testGuardNeverLeaksADifferentTenantsContactIntoASeriousResponse],
  ['guard never returns an empty string', testGuardNeverReturnsEmpty],
  ['Tenant-Isolated Review Contact: LTA gets its own address when unconfigured', testLtaGetsItsOwnAddressWhenUnconfigured],
  ["Tenant-Isolated Review Contact: another tenant never inherits LTA's address when unconfigured", testOtherTenantNeverInheritsLtasAddressWhenUnconfigured],
  ['Tenant-Isolated Review Contact: another tenant gets its own configured contact', testOtherTenantGetsItsOwnConfiguredContact],
  ["Tenant-Isolated Review Contact: an explicit configured contact overrides LTA's own default too", testConfiguredContactOverridesLtasDefaultToo],
  ["Tenant-Isolated Review Contact: LTA's serious-reply prompt offers its own address", testSeriousReplyForLtaPromptOffersLtasAddress],
  ["Tenant-Isolated Review Contact: another tenant's serious-reply prompt offers its own contact, never LTA's", testSeriousReplyForAnotherTenantPromptOffersItsOwnContactNeverLtas],
  ['Tenant-Isolated Review Contact: a tenant with no configured contact never has one invented', testSeriousReplyForTenantWithNoConfiguredContactNeverInventsOne],
  ['PHASE A4: oversized reviewText rejected (400), zero Anthropic calls', testOversizedReviewTextRejectedNoFetch],
  ['PHASE A4: oversized currentDraft rejected (400), zero Anthropic calls', testOversizedCurrentDraftRejectedNoFetch],
  ['PHASE A4: oversized reviewerName rejected (400), zero Anthropic calls', testOversizedReviewerNameRejectedNoFetch],
  ['PHASE A4: oversized location rejected (400), zero Anthropic calls', testOversizedLocationRejectedNoFetch],
  ['PHASE A4: a normal, within-limits request still succeeds', testWithinLimitsStillSucceeds],
  ['PARTS 5/24: no-text 5-star never calls the model and varies across calls', testFiveStarNoTextNeverCallsModelAndVaries],
  ['PARTS 5/6: whitespace-only reviewText is treated identically to empty text', testWhitespaceOnlyReviewTextTreatedAsNoText],
  ['PART 6: no-text 4-star never invents a problem', testFourStarNoTextNeverInventsAProblem],
  ['PART 6: no-text 3-star never fabricates specific details', testThreeStarNoTextAcknowledgesNeutrallyWithoutInventing],
  ['PART 6: no-text 1-star invites detail without inventing specifics', testOneStarNoTextInvitesDetailWithoutInventing],
  ['an out-of-range star value still resolves to a no-text tier rather than erroring', testUnknownStarRatingFallsBackToThreeStarTier],
  ['PART 24: a high-risk review surfaces riskLevel=high_risk and its categories', testHighRiskReviewSurfacesRiskLevelAndCategories],
  ['PART 24: an ordinary negative review surfaces riskLevel=normal, never high_risk', testOrdinaryNegativeReviewIsNormalRiskNotHighRisk],
]

for (const [name, fn] of tests) await run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
