// Phase B.10/B.11 -- confirms the Stripe billing foundation coexists
// safely with everything around it: the Pricing.jsx stale-price bug stays
// fixed, no LTA/tenant_config leakage from any billing module, and (as of
// B.11) the now-real select-plan/stripe-webhook actions still respect the
// Stripe-SDK-import boundary (only stripeClient.js imports the raw
// 'stripe' package -- every other file goes through it).
//
// paymentProvider.js (the B.10-era fail-closed stub select-plan used to be
// wired through) was deleted in B.11 once selectPlan() was rewritten to
// perform a real Stripe Setup-mode Checkout -- it became fully dead code
// (nothing else ever imported it). This file's own B.10-era tests for that
// stub are removed accordingly; see test_select_plan_endpoint.js and
// test_stripe_webhook.js for the new, real-flow coverage.
//
// Run directly: node tests/test_billing_foundation_compat.js

import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

function testPaymentProviderStubWasIntentionallyRemoved() {
  const p = path.resolve(__dirname, '..', 'dashboard', 'api', '_lib', 'paymentProvider.js')
  assert(!existsSync(p), 'paymentProvider.js should have been deleted once selectPlan() no longer references it -- if this fails, either the file was resurrected or something still imports it')
}

function testSessionActionFileNeverImportsRawStripeSdk() {
  const source = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', 'session', '[action].js'), 'utf-8')
  assert(!/from ['"]stripe['"]/.test(source), 'session/[action].js must never import the raw Stripe SDK directly -- it must go through stripeClient.js\'s getStripeClient()')
  assert(source.includes("from '../_lib/stripeClient.js'"), 'selectPlan()/stripeWebhookAction() must be wired through stripeClient.js')
  assert(source.includes("from '../_lib/billingCustomer.js'"), 'selectPlan() must be wired through billingCustomer.js\'s ensureStripeCustomerForTenant()/createSetupCheckoutSession()')
}

function testNoApiEndpointImportsTheRawStripeSdkExceptStripeClient() {
  // Only stripeClient.js itself may import the 'stripe' package -- every
  // other file (including the new stripe-webhook action inside
  // session/[action].js) must go through getStripeClient().
  const apiDir = path.resolve(__dirname, '..', 'dashboard', 'api')
  const offenders = []
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full)
      else if (/\.js$/.test(entry) && full !== path.resolve(apiDir, '_lib', 'stripeClient.js')) {
        const content = readFileSync(full, 'utf-8')
        if (/from ['"]stripe['"]/.test(content)) offenders.push(path.relative(apiDir, full))
      }
    }
  }
  walk(apiDir)
  assert(offenders.length === 0, `only stripeClient.js may import the raw Stripe SDK: ${offenders.join(', ')}`)
}

function testPricingPageShowsCorrectGrowthPrice() {
  const source = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'src', 'components', 'Pricing.jsx'), 'utf-8')
  assert(source.includes("price: '$249'"), 'Pricing.jsx must display the canonical Growth price ($249), matching plans.js, not the stale pre-Phase-B $349')
  assert(!/\$349/.test(source), 'the stale $349 value must be gone entirely, including from comments')
}

function testBillingModulesNeverReferenceLtaOrBootstrap() {
  const files = ['billingStore.js', 'stripeClient.js', 'billingStatusProjection.js', 'stripePriceMap.js', 'billingPortalPolicy.js', 'billingCustomer.js', 'billingTerms.js']
  for (const file of files) {
    const source = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', '_lib', file), 'utf-8')
    assert(!/Los Tres Amigos/i.test(source), `${file} must never reference LTA`)
    assert(!/BOOTSTRAP_TENANT_ID/.test(source), `${file} must never reference the LTA bootstrap tenant constant`)
  }
}

function testBillingModulesNeverCreateOrWriteTenantConfig() {
  const files = ['billingStore.js', 'stripeClient.js', 'billingStatusProjection.js', 'stripePriceMap.js', 'billingCustomer.js', 'billingTerms.js']
  for (const file of files) {
    const source = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', '_lib', file), 'utf-8')
    const importLines = source.split('\n').filter(line => /^\s*import\b/.test(line))
    assert(!importLines.some(line => line.includes('tenantConfigStore.js')),
      `${file} must never import tenantConfigStore.js -- projecting into tenant_config.commercial remains out of scope through B.11`)
  }
}

const tests = [
  ['paymentProvider.js stub was intentionally removed, not resurrected', testPaymentProviderStubWasIntentionallyRemoved],
  ['session/[action].js never imports the raw Stripe SDK directly', testSessionActionFileNeverImportsRawStripeSdk],
  ['no API endpoint other than stripeClient.js imports the raw Stripe SDK', testNoApiEndpointImportsTheRawStripeSdkExceptStripeClient],
  ['Pricing.jsx now shows the correct $249 Growth price', testPricingPageShowsCorrectGrowthPrice],
  ['billing modules never reference LTA/bootstrap', testBillingModulesNeverReferenceLtaOrBootstrap],
  ['billing modules never write tenant_config', testBillingModulesNeverCreateOrWriteTenantConfig],
]

async function main() {
  for (const [name, fn] of tests) await run(name, fn)
  const failed = results.filter(r => !r).length
  if (failed > 0) {
    console.log(`\n${failed} of ${tests.length} TESTS FAILED`)
    process.exit(1)
  }
  console.log(`\nALL ${tests.length} TESTS PASSED`)
}

main()
