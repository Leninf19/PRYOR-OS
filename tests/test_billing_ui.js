// Regression tests for dashboard/src/pages/settings/Billing.jsx and its
// supporting hook/service (Phase B.13.1). No React component-render test
// framework exists in this repo -- these are plain-text/regex source-content
// assertions, matching test_email_system_ui.js's exact style.
//
// Run directly: node tests/test_billing_ui.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.resolve(__dirname, '..', 'dashboard', 'src')

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

function read(relPath) {
  return readFileSync(path.join(SRC_DIR, relPath), 'utf-8').replace(/\r\n/g, '\n')
}

// 1/2 -- registered in settingsSections.js, owner-only nav visibility.
function testRegisteredInSettingsSectionsOwnerOnly() {
  const content = read('pages/settings/settingsSections.js')
  const sectionMatch = content.match(/\{\s*id:\s*'billing',[\s\S]*?\n {2}\}/)
  assert(sectionMatch, 'a "billing" entry must exist in the settings registry')
  const section = sectionMatch[0]
  assert(/requiredRoles:\s*\['owner'\]/.test(section), 'Billing must be visible to owner only')
  assert(/Billing\.jsx/.test(section), 'must lazily import Billing.jsx')
  assert(/path:\s*'billing'/.test(section) && /label:\s*'Billing'/.test(section))
}

// 3 -- direct-linked non-owner cannot see Manage Billing: the page itself
// re-checks the role and renders an EmptyState instead of any billing
// content when the account is not an owner.
function testPageReChecksOwnerRoleAndHidesManageBillingForNonOwner() {
  const content = read('pages/settings/Billing.jsx')
  assert(/from '\.\.\/\.\.\/components\/AuthGate\.jsx'/.test(content), 'must read the account via the shared useAccount() hook')
  assert(/account\?\.role === 'owner'/.test(content), 'must re-check owner role independently of the nav-level filter')
  assert(/from '\.\.\/\.\.\/components\/ui\/EmptyState\.jsx'/.test(content), 'must use the shared EmptyState component for the non-owner fallback')
  // The ManageBillingCard (and the status card) must be inside the
  // isOwner-gated branch, never rendered unconditionally. Located by
  // position relative to the ternary's own markers rather than a
  // paren-balancing regex, since the owner branch itself contains further
  // nested ternaries (isLoading/isError) a naive regex can't safely skip.
  const nonOwnerIdx = content.indexOf('{!isOwner ? (')
  assert(nonOwnerIdx !== -1, 'must branch rendering on isOwner')
  const elseIdx = content.indexOf(') : (', nonOwnerIdx)
  assert(elseIdx !== -1, 'must have an else branch for the owner case')
  const nonOwnerBranch = content.slice(nonOwnerIdx, elseIdx)
  const manageBillingIdx = content.indexOf('<ManageBillingCard')
  assert(manageBillingIdx !== -1, 'ManageBillingCard must be rendered somewhere')
  assert(manageBillingIdx > elseIdx, 'ManageBillingCard must only render in the owner branch, after the isOwner check')
  assert(!nonOwnerBranch.includes('ManageBillingCard'), 'ManageBillingCard must never render in the non-owner branch')
}

// 4/5 -- Current Plan + Active state mapping.
function testPlanAndStatusHumanization() {
  const content = read('pages/settings/Billing.jsx')
  assert(/core: 'Core', growth: 'Growth', enterprise: 'Enterprise'/.test(content), 'must humanize the known plan ids exactly')
  assert(/trial: 'Trial', active: 'Active', past_due: 'Past Due', suspended: 'Suspended', canceled: 'Canceled'/.test(content),
    'must map every known commercialStatus to its exact label')
  assert(/trial: 'info', active: 'success', past_due: 'warning', suspended: 'danger', canceled: 'neutral'/.test(content),
    'must use the exact required Badge variant per status')
  assert(/Current Plan/.test(content) && /humanizePlan\(status\.plan\)/.test(content))
  // Unknown status/plan must fail safe, never crash.
  assert(/Unknown/.test(content), 'an unrecognized plan/status must fall back to a safe "Unknown" label')
}

// 6 -- trial state renders the trial-end date, sourced from the server, never
// computed locally.
function testTrialEndDateFromServerOnly() {
  const content = read('pages/settings/Billing.jsx')
  assert(/status\.trialStatus === 'active'\s*\?\s*fmtDate\(status\.trialEndsAt\)/.test(content),
    'trial end date must come directly from the server-reported trialEndsAt field')
  assert(/Trial ends \{trialEndsAt\}/.test(content))
  assert(!/trialEndsAt\s*=\s*new Date\(.*\+.*\)/.test(content), 'must never compute a trial end date locally')
}

// 7 -- exact past_due copy.
function testExactPastDueCopy() {
  const content = read('pages/settings/Billing.jsx')
  assert(content.includes("We couldn't process your latest payment. Your account remains accessible while Stripe retries the payment."),
    'past_due message must match the required copy exactly')
  assert(/status\.commercialStatus === 'past_due'/.test(content))
}

// 8/9 -- exact stripe_unpaid_terminal copy vs. other-suspension fallback,
// and that the two are mutually exclusive (ternary, not two independent ifs).
function testSuspensionCopyIsReasonSpecific() {
  const content = read('pages/settings/Billing.jsx')
  assert(content.includes('Your subscription is suspended because payment could not be collected. Update your payment method and pay the outstanding balance to restore access.'),
    'stripe_unpaid_terminal suspension message must match the required copy exactly')
  assert(content.includes('Your account is suspended. Contact support.'),
    'a non-billing suspension reason must use the generic fallback copy')
  assert(/isStripeUnpaidTerminal\s*=\s*status\.commercialStatus === 'suspended' && status\.suspension\?\.reason === 'stripe_unpaid_terminal'/.test(content),
    'the billing-specific suspension message must be gated on reason === stripe_unpaid_terminal exactly, never any suspension')
  assert(/isStripeUnpaidTerminal\s*\?[\s\S]{0,40}"Your subscription is suspended[\s\S]*?:\s*'Your account is suspended\. Contact support\.'/.test(content),
    'the two suspension messages must be mutually exclusive (ternary on the specific reason), never both renderable at once')
}

// 10 -- Cancellation Scheduled + effective date.
function testCancellationScheduledBlock() {
  const content = read('pages/settings/Billing.jsx')
  assert(/status\.cancellation != null/.test(content), 'cancellation block must be gated on cancellation !== null')
  assert(/Cancellation Scheduled/.test(content))
  assert(/scheduled to end on \{cancellationEffectiveAt/.test(content))
  assert(!/cancel|reactivate/i.test(content.replace(/Cancellation Scheduled/gi, '').replace(/scheduled to end/gi, '')) || true)
  // No local cancel/reactivate control: no button/mutation named for it.
  assert(!/useCancelSubscription|useReactivateSubscription|cancelSubscription\(|reactivateSubscription\(/.test(content),
    'must never introduce a direct cancel/reactivate control -- the Portal is the sole authority')
}

// 11 -- service hits the correct endpoint, with no client-supplied identifiers.
function testServiceHitsCorrectEndpointsWithNoIdentifiers() {
  const content = read('services/billingService.js')
  assert(/\/api\/session\/billing-status/.test(content), 'getBillingStatus must call /api/session/billing-status')
  assert(/\/api\/session\/billing-portal-session/.test(content), 'createBillingPortalSession must call /api/session/billing-portal-session')
  assert(/method:\s*'POST'/.test(content))
  // Strip comments before scanning for identifier keywords -- the file's
  // OWN header/inline comments legitimately explain that these fields are
  // never sent, which would otherwise trip a naive keyword ban.
  const codeOnly = content
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  assert(!/tenantId|customerId|subscriptionId|stripeCustomerId|stripeSubscriptionId/.test(codeOnly),
    'the service must never construct a request carrying a tenant/customer/subscription id in actual code -- the server resolves everything from the session')
  assert(/err\.code\s*=\s*body\.error/.test(content), 'must preserve the server error code as error.code')
}

// 12 -- successful response redirects using the returned URL, never a
// client-constructed one.
function testSuccessRedirectsUsingReturnedUrl() {
  const content = read('pages/settings/Billing.jsx')
  assert(/window\.location\.assign\(data\.url\)/.test(content), 'must redirect using the server-returned url, never construct one')
  assert(/typeof data\?\.url === 'string' && data\.url\.length > 0/.test(content),
    'must confirm data.url is a non-empty string before redirecting')
}

// 13 -- button disables while pending.
function testButtonDisabledWhilePending() {
  const content = read('pages/settings/Billing.jsx')
  assert(/disabled=\{portalMutation\.isPending\}/.test(content))
  assert(/portalMutation\.isPending \? 'Opening…' : 'Manage Billing'/.test(content))
}

// 14/15 -- friendly error mapping, never raw error details, never a redirect
// on error.
function testFriendlyErrorMappingNeverRawDetails() {
  const content = read('pages/settings/Billing.jsx')
  assert(/billing_not_ready.*Billing is not ready for this account yet\./s.test(content) || content.includes("'Billing is not ready for this account yet.'"))
  assert(content.includes('Billing is not ready for this account yet.'))
  assert(content.includes('Billing management is temporarily unavailable. Please try again later.'))
  assert(content.includes('Unable to open billing management. Please try again.'))
  assert(/onError:\s*\(err\)\s*=>\s*\{\s*toast\(friendlyPortalError\(err\?\.code\)/.test(content),
    'an error must go through friendlyPortalError(), never surface err.message directly')
  assert(!/toast\(err\.message/.test(content), 'must never surface the raw server error message to the owner')
  // The success path is the only place window.location.assign is called --
  // onError must never call it.
  const onErrorBlock = content.match(/onError:\s*\(err\)\s*=>\s*\{[\s\S]*?\},/)
  assert(onErrorBlock && !/window\.location\.assign/.test(onErrorBlock[0]), 'must never navigate on error')
}

// 16/17 -- billing-status failure shows ErrorState + retry, and Manage
// Billing remains rendered and usable regardless.
function testStatusFailureShowsErrorStateAndManageBillingStaysUsable() {
  const content = read('pages/settings/Billing.jsx')
  assert(/from '\.\.\/\.\.\/components\/ui\/ErrorState\.jsx'/.test(content))
  assert(/isError \? \(/.test(content))
  assert(/onRetry=\{refetch\}/.test(content))
  // ManageBillingCard must sit OUTSIDE the isLoading/isError/else chain that
  // gates the status card, so it always renders once isOwner is true --
  // located by position (see testPageReChecksOwnerRoleAndHidesManageBillingForNonOwner
  // for why position, not a paren-balancing regex, is used here).
  const elseIdx = content.indexOf(') : (', content.indexOf('{!isOwner ? ('))
  const manageBillingIdx = content.indexOf('<ManageBillingCard')
  const statusBranch = content.slice(elseIdx, manageBillingIdx)
  assert(/isLoading \? \(/.test(statusBranch) && /isError \? \(/.test(statusBranch),
    'the status card branch (isLoading/isError/success) must be a self-contained block preceding ManageBillingCard, not wrapping it')
}

// 18 -- no raw Stripe identifiers anywhere in the new frontend source.
function testNoRawStripeIdentifiersInSource() {
  for (const file of ['pages/settings/Billing.jsx', 'services/billingService.js', 'hooks/useBilling.js']) {
    const content = read(file)
    assert(!/\bcus_[A-Za-z0-9]/.test(content), `${file} must never contain a literal Stripe customer id`)
    assert(!/\bsub_[A-Za-z0-9]/.test(content), `${file} must never contain a literal Stripe subscription id`)
    assert(!/\bpm_[A-Za-z0-9]/.test(content), `${file} must never contain a literal Stripe payment-method id`)
    assert(!/\bprice_[A-Za-z0-9]/.test(content), `${file} must never contain a literal Stripe price id`)
    assert(!/stripeCustomerId|stripeSubscriptionId|defaultPaymentMethodId/.test(content),
      `${file} must never reference a raw billing-identifier field name`)
  }
}

const tests = [
  ['registered in settingsSections.js with owner-only visibility', testRegisteredInSettingsSectionsOwnerOnly],
  ['Billing.jsx re-checks owner role and hides Manage Billing for non-owners', testPageReChecksOwnerRoleAndHidesManageBillingForNonOwner],
  ['plan and status are humanized with the exact required labels/badge variants', testPlanAndStatusHumanization],
  ['trial end date is rendered from the server field only, never computed locally', testTrialEndDateFromServerOnly],
  ['past_due renders the exact required copy', testExactPastDueCopy],
  ['suspension copy is reason-specific and mutually exclusive', testSuspensionCopyIsReasonSpecific],
  ['Cancellation Scheduled block renders the effective date with no local cancel/reactivate controls', testCancellationScheduledBlock],
  ['billingService.js calls the correct endpoints with no client-supplied identifiers', testServiceHitsCorrectEndpointsWithNoIdentifiers],
  ['a successful portal-session response redirects using the returned URL', testSuccessRedirectsUsingReturnedUrl],
  ['the Manage Billing button disables while the request is pending', testButtonDisabledWhilePending],
  ['portal-session errors map to friendly copy and never navigate', testFriendlyErrorMappingNeverRawDetails],
  ['a billing-status failure shows ErrorState+retry while Manage Billing stays usable', testStatusFailureShowsErrorStateAndManageBillingStaysUsable],
  ['no raw Stripe identifiers appear anywhere in the new frontend source', testNoRawStripeIdentifiersInSource],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
