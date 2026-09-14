// Phase B.10 -- confirms the Stripe SDK + billing store foundation
// coexists safely with what already existed: paymentProvider.js's stub
// stays fail-closed/unconfigured (select-plan must NOT start performing
// Stripe operations in B.10), the Pricing.jsx stale-price bug is fixed,
// and nothing in this phase touches LTA or tenant_config directly.
//
// Run directly: node tests/test_billing_foundation_compat.js

import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createCheckoutSession, verifyPayment, PaymentNotConfiguredError } from '../dashboard/api/_lib/paymentProvider.js'

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

async function testCreateCheckoutSessionStillFailsClosed() {
  let threw = null
  try { await createCheckoutSession({ id: 'core' }, 'someone@example.com') } catch (err) { threw = err }
  assert(threw instanceof PaymentNotConfiguredError, 'createCheckoutSession() must remain a fail-closed stub -- B.10 must not accidentally make a currently-dead payment button start charging users')
}

async function testVerifyPaymentStillFailsClosed() {
  let threw = null
  try { await verifyPayment('sess_whatever') } catch (err) { threw = err }
  assert(threw instanceof PaymentNotConfiguredError)
}

function testSessionActionFileDoesNotYetImportStripeSdk() {
  const source = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', 'session', '[action].js'), 'utf-8')
  assert(!/from ['"]stripe['"]/.test(source), 'session/[action].js must not import the Stripe SDK directly in B.10 -- select-plan stays wired through paymentProvider.js\'s stub until B.11 explicitly rewires it')
  assert(source.includes("import { createCheckoutSession, PaymentNotConfiguredError } from '../_lib/paymentProvider.js'"), 'select-plan must still be wired through the existing paymentProvider.js seam')
}

function testNoApiEndpointImportsTheStripeSdkYet() {
  // Only stripeClient.js itself may import the 'stripe' package in B.10 --
  // no endpoint file calls Stripe directly yet (no webhook, no checkout
  // endpoint exists).
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
  assert(offenders.length === 0, `only stripeClient.js may import the Stripe SDK in B.10: ${offenders.join(', ')}`)
}

function testPricingPageShowsCorrectGrowthPrice() {
  const source = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'src', 'components', 'Pricing.jsx'), 'utf-8')
  assert(/growth.*\n.*price: '\$249'/.test(source) || source.includes("{ id: 'growth', name: 'Growth', price: '$249'"),
    'Pricing.jsx must display the canonical Growth price ($249), matching plans.js, not the stale pre-Phase-B $349')
  assert(!/price: '\$349'/.test(source), 'the stale $349 displayed-price entry must be gone (a comment mentioning the old value for context is fine)')
}

function testBillingModulesNeverReferenceLtaOrBootstrap() {
  const files = ['billingStore.js', 'stripeClient.js', 'billingStatusProjection.js', 'stripePriceMap.js', 'billingPortalPolicy.js']
  for (const file of files) {
    const source = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', '_lib', file), 'utf-8')
    assert(!/Los Tres Amigos/i.test(source), `${file} must never reference LTA`)
    assert(!/BOOTSTRAP_TENANT_ID/.test(source), `${file} must never reference the LTA bootstrap tenant constant`)
  }
}

function testBillingModulesNeverCreateOrWriteTenantConfig() {
  const files = ['billingStore.js', 'stripeClient.js', 'billingStatusProjection.js', 'stripePriceMap.js']
  for (const file of files) {
    const source = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', '_lib', file), 'utf-8')
    const importLines = source.split('\n').filter(line => /^\s*import\b/.test(line))
    assert(!importLines.some(line => line.includes('tenantConfigStore.js')),
      `${file} must never import tenantConfigStore.js -- projecting into tenant_config.commercial is explicitly out of scope for B.10`)
  }
}

const tests = [
  ['createCheckoutSession() remains a fail-closed stub', testCreateCheckoutSessionStillFailsClosed],
  ['verifyPayment() remains a fail-closed stub', testVerifyPaymentStillFailsClosed],
  ['session/[action].js does not yet import the Stripe SDK', testSessionActionFileDoesNotYetImportStripeSdk],
  ['no API endpoint other than stripeClient.js imports the Stripe SDK', testNoApiEndpointImportsTheStripeSdkYet],
  ['Pricing.jsx now shows the correct $249 Growth price', testPricingPageShowsCorrectGrowthPrice],
  ['new billing modules never reference LTA/bootstrap', testBillingModulesNeverReferenceLtaOrBootstrap],
  ['new billing modules never write tenant_config', testBillingModulesNeverCreateOrWriteTenantConfig],
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
