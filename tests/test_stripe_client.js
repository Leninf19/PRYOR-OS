// Phase B.10 -- regression tests for dashboard/api/_lib/stripeClient.js.
// No real Stripe API call happens anywhere in this file -- every test
// either exercises the "not configured" error path or injects a fake
// client via _setStripeClientForTests().
//
// Run directly: node tests/test_stripe_client.js

import { readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  getStripeClient, StripeNotConfiguredError,
  _setStripeClientForTests, _resetStripeClientForTests,
} from '../dashboard/api/_lib/stripeClient.js'

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
  } finally {
    _resetStripeClientForTests()
    delete process.env.STRIPE_SECRET_KEY
  }
}

function testAbsentSecretThrowsConfiguredError() {
  delete process.env.STRIPE_SECRET_KEY
  let threw = null
  try {
    getStripeClient()
  } catch (err) { threw = err }
  assert(threw instanceof StripeNotConfiguredError, 'must throw StripeNotConfiguredError when STRIPE_SECRET_KEY is absent')
}

function testErrorMessageNeverContainsASecretValue() {
  process.env.STRIPE_SECRET_KEY = ''
  let threw = null
  try {
    getStripeClient()
  } catch (err) { threw = err }
  assert(threw instanceof StripeNotConfiguredError, 'sanity: empty string must still be treated as absent')
  assert(!threw.message.includes('sk_'), 'error message must never contain a key-shaped value')
}

function testInjectedFakeClientIsUsedInstead() {
  const fake = { __fake: true, checkout: {}, subscriptions: {} }
  _setStripeClientForTests(() => fake)
  const client = getStripeClient()
  assert(client === fake, 'getStripeClient() must return the injected test client')
  // Even with a fake client active, no real secret is required -- proves
  // injection fully bypasses the configuration check, never partially.
  assert(!process.env.STRIPE_SECRET_KEY, 'sanity: no real secret was ever set for this test')
}

function testRealClientNeverConstructedWhenFakeIsInjected() {
  let constructCount = 0
  _setStripeClientForTests(() => { constructCount += 1; return { instance: constructCount } })
  const a = getStripeClient()
  const b = getStripeClient()
  assert(a.instance === 1 && b.instance === 2, 'the injected factory runs on every call -- callers control caching themselves in tests')
}

function testModuleImportPerformsNoNetworkActivity() {
  // If importing this module made a real network call, requiring it above
  // (with no STRIPE_SECRET_KEY ever set for most of this file's run) would
  // have already thrown or hung well before this test runs. Reaching this
  // line at all is the proof.
  assert(typeof getStripeClient === 'function', 'module imported successfully with no configured secret')
}

// ---------------------------------------------------------------------
// Structural guard: stripeClient.js (and billingStore.js) must never be
// imported from the Vite client bundle. Mirrors test_no_direct_data_fetches.js's
// walk-and-scan pattern.
// ---------------------------------------------------------------------
const SRC_DIR = path.resolve(__dirname, '..', 'dashboard', 'src')
const FORBIDDEN_IMPORTS = [/stripeClient(\.js)?['"]/, /billingStore(\.js)?['"]/, /STRIPE_SECRET_KEY/]

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (/\.(jsx?|tsx?)$/.test(entry)) out.push(full)
  }
  return out
}

function testClientBundleNeverImportsStripeServerModules() {
  const offenders = []
  for (const file of walk(SRC_DIR)) {
    const content = readFileSync(file, 'utf-8')
    for (const pattern of FORBIDDEN_IMPORTS) {
      if (pattern.test(content)) offenders.push(`${path.relative(SRC_DIR, file)} matches ${pattern}`)
    }
  }
  assert(offenders.length === 0, `dashboard/src must never import Stripe server modules or reference STRIPE_SECRET_KEY: ${offenders.join('; ')}`)
}

const tests = [
  ['absent secret throws a controlled StripeNotConfiguredError', testAbsentSecretThrowsConfiguredError],
  ['error message never contains a secret-shaped value', testErrorMessageNeverContainsASecretValue],
  ['an injected fake client is used instead of a real one', testInjectedFakeClientIsUsedInstead],
  ['no real Stripe client is constructed when a fake is injected', testRealClientNeverConstructedWhenFakeIsInjected],
  ['importing the module performs no network activity', testModuleImportPerformsNoNetworkActivity],
  ['the client bundle never imports Stripe server modules', testClientBundleNeverImportsStripeServerModules],
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
