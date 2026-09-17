// Phase B.11 -- regression tests for the redesigned
// dashboard/src/components/Pricing.jsx. Plain source-text regex
// assertions, matching this project's established convention for a file
// with no React render-test harness (see test_login_ui_redesign.js/
// test_onboarding_ui.js).
//
// Run directly: node tests/test_pricing_page_ui.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONTENT_PATH = path.resolve(__dirname, '..', 'dashboard', 'src', 'components', 'Pricing.jsx')
const content = readFileSync(CONTENT_PATH, 'utf-8')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
function run(name, fn) {
  try {
    fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  }
}

function testCoreShows149() {
  assert(content.includes("price: '$149'"), 'Core must display $149')
}

function testGrowthShows249() {
  assert(content.includes("price: '$249'"), 'Growth must display $249')
}

function testStale349IsAbsentEntirely() {
  assert(!/\$349/.test(content), 'the stale, pre-Phase-B $349 value must never appear, including in comments')
}

function testGrowthMarkedMostPopular() {
  assert(/badge: 'MOST POPULAR'/.test(content), 'Growth must carry the MOST POPULAR badge')
}

function testEnterpriseHasNoSelfServiceCheckout() {
  // Enterprise's CTA must be a plain mailto link, never a fetch()/POST to
  // any checkout-creation endpoint. Bounded to JUST the EnterpriseCard
  // function body (the next top-level `function`/`const` declaration after
  // it) -- otherwise the slice would run to end-of-file and inevitably
  // include the real select-plan fetch() used by Core/Growth elsewhere.
  const start = content.indexOf('function EnterpriseCard')
  const end = content.indexOf('function ConsentPanel', start)
  const enterpriseSection = content.slice(start, end)
  assert(enterpriseSection.includes('mailto:sales@futuremark.studio'), 'Enterprise must use the existing sales mailto CTA')
  assert(!enterpriseSection.includes('fetch('), 'Enterprise must never call select-plan / any self-service checkout endpoint')
}

function testCoreFeatureListMatchesApprovedCapabilities() {
  const requiredCoreFeatures = [
    '1 location', 'Up to 3 users', 'Review monitoring', 'Review replies', 'AI reply rewriting',
    'Basic dashboard', 'Review trends', 'Bad-review alerts', 'Basic tasks', 'Email digest',
    '500 MB content storage', 'Core AI allowance',
  ]
  for (const feature of requiredCoreFeatures) {
    assert(content.includes(feature), `Core feature list must include "${feature}"`)
  }
}

function testGrowthFeatureListMatchesApprovedCapabilities() {
  const requiredGrowthFeatures = [
    'Up to 5 locations', 'Up to 10 users', 'Everything in Core', 'Live Executive Brief',
    'Advanced Intelligence', 'Operations Impact', 'Marketing Intelligence', 'Advanced reporting',
    'Higher AI allowance', '1 GB content storage',
  ]
  for (const feature of requiredGrowthFeatures) {
    assert(content.includes(feature), `Growth feature list must include "${feature}"`)
  }
}

function testEnterpriseDoesNotClaimUnlimitedResources() {
  const enterpriseSection = content.slice(content.indexOf('ENTERPRISE_FEATURES'), content.indexOf('function PlanCard'))
  assert(!/unlimited/i.test(enterpriseSection), 'Enterprise copy must never claim unlimited resources')
  assert(enterpriseSection.includes('Custom finite location/user limits'), 'Enterprise must describe custom FINITE limits, not unlimited ones')
}

function testTrialMessagingIsPresent() {
  assert(content.includes('Start with 7 days of Growth'), 'the "start with 7 days of Growth" framing must be present')
  assert(content.includes('Your 7-day trial begins after your restaurant is connected and your first sync completes'), 'the sync-anchored trial-start disclosure must be present verbatim')
  assert(content.includes("Card required. You won't be charged when you enter your payment method."), 'the "card required, not charged yet" disclosure must be present verbatim')
}

function testPostTrialPlanClarityForBothSelections() {
  assert(/you'll continue on/.test(content), 'the post-trial plan continuation copy must be present')
  assert(content.includes('{plan.price}/month'), 'the post-trial monthly amount must be dynamically shown for whichever plan the customer picked (Core or Growth)')
}

function testConsentCheckboxIsUncheckedByDefault() {
  assert(content.includes('const [consentAccepted, setConsentAccepted] = useState(false)'), 'consent must default to false/unchecked -- never pre-checked')
  assert(content.includes('checked={accepted}'), 'the checkbox must be a real controlled input bound to the unchecked-by-default state')
}

function testConsentIsRequiredBeforeSubmission() {
  assert(/disabled=\{!accepted \|\| submitting\}/.test(content), 'the "Start 7-Day Trial" confirm button must stay disabled until consent is explicitly accepted')
}

function testConsentRequestSendsExplicitBooleanTrue() {
  assert(content.includes('recurringBillingAccepted: true'), 'the confirm action must send an explicit literal true, never inferred/defaulted')
}

function testSelectPlanEndpointAndShapeUnchanged() {
  assert(content.includes("fetch('/api/session/select-plan'"), 'must still POST to /api/session/select-plan')
  assert(/method:\s*'POST'/.test(content))
  assert(content.includes('JSON.stringify({ plan: selectedPlan, recurringBillingAccepted: true })'), 'the request body must be exactly { plan, recurringBillingAccepted } -- no invented fields')
}

function testSuccessRedirectsToServerProvidedCheckoutUrl() {
  assert(content.includes('window.location.href = data.checkoutUrl'), 'a successful response must redirect to the SERVER-provided checkoutUrl -- never a client-constructed Stripe URL')
}

function testAccessCodeLinkStillPresent() {
  assert(content.includes("href=\"/access-code\""), 'the existing access-code entry point must remain reachable from this page')
}

function testEmailVerificationWarningStillPresent() {
  assert(content.includes('get-started-status'), 'must still proactively check verification state via get-started-status, matching GetStarted.jsx\'s own pattern')
  assert(content.includes("'unverified'"), 'an unverified visitor must be routed to a distinct, honest state')
}

function testNoCardDataFieldsAnywhereInThisFile() {
  const forbidden = [/cardNumber/i, /\bcvc\b/i, /expiryDate/i, /card_number/i]
  for (const pattern of forbidden) {
    assert(!pattern.test(content), `Pricing.jsx must never reference raw card data fields (matched ${pattern})`)
  }
}

const tests = [
  ['Core shows $149', testCoreShows149],
  ['Growth shows $249', testGrowthShows249],
  ['the stale $349 is absent entirely', testStale349IsAbsentEntirely],
  ['Growth is marked Most Popular', testGrowthMarkedMostPopular],
  ['Enterprise has no self-service checkout', testEnterpriseHasNoSelfServiceCheckout],
  ['Core feature list matches approved capabilities', testCoreFeatureListMatchesApprovedCapabilities],
  ['Growth feature list matches approved capabilities', testGrowthFeatureListMatchesApprovedCapabilities],
  ['Enterprise does not claim unlimited resources', testEnterpriseDoesNotClaimUnlimitedResources],
  ['trial messaging is present', testTrialMessagingIsPresent],
  ['post-trial plan clarity is shown for both selections', testPostTrialPlanClarityForBothSelections],
  ['the consent checkbox is unchecked by default', testConsentCheckboxIsUncheckedByDefault],
  ['consent is required before submission is enabled', testConsentIsRequiredBeforeSubmission],
  ['the consent request sends an explicit boolean true', testConsentRequestSendsExplicitBooleanTrue],
  ['the select-plan endpoint/request shape is unchanged', testSelectPlanEndpointAndShapeUnchanged],
  ['success redirects to the server-provided checkoutUrl', testSuccessRedirectsToServerProvidedCheckoutUrl],
  ['the access-code entry point remains reachable', testAccessCodeLinkStillPresent],
  ['the email-verification warning path remains present', testEmailVerificationWarningStillPresent],
  ['no raw card data fields appear anywhere in this file', testNoCardDataFieldsAnywhereInThisFile],
]

for (const [name, fn] of tests) run(name, fn)
const failed = results.filter(r => !r).length
if (failed > 0) {
  console.log(`\n${failed} of ${tests.length} TESTS FAILED`)
  process.exit(1)
}
console.log(`\nALL ${tests.length} TESTS PASSED`)
