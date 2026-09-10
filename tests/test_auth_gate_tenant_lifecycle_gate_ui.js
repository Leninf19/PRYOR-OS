// Multi-Tenant Phase 4J -- source-content regression tests for
// AuthGate.jsx's new tenant-lifecycle gate. Same regex/source-content
// convention as test_account_context.js/test_google_business_profile_ui.js
// (no React render framework in this repo).
//
// Run directly: node tests/test_auth_gate_tenant_lifecycle_gate_ui.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.resolve(__dirname, '..', 'dashboard', 'src')

function read(relPath) {
  return readFileSync(path.join(SRC_DIR, relPath), 'utf-8')
}

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

const content = read('components/AuthGate.jsx')

function testImportsTenantStatusAndOnboarding() {
  assert(/from '\.\.\/hooks\/useTenantStatus\.js'/.test(content), 'must import useTenantStatus()')
  assert(/from '\.\.\/pages\/Onboarding\.jsx'/.test(content), 'must import the Onboarding page')
}

function testGateSitsAboveChildrenNotAsAChildRoute() {
  // The gate must wrap {children} (App), not be reachable only via one of
  // App's OWN child routes -- otherwise App's data hooks (useReviewsData
  // etc) would already have fired before the gate ever ran.
  assert(/function TenantLifecycleGate/.test(content), 'must define a TenantLifecycleGate component')
  assert(/<TenantLifecycleGate tenantStatusQuery={tenantStatusQuery}>{children}<\/TenantLifecycleGate>/.test(content),
    'TenantLifecycleGate must wrap children (App) directly, not be nested inside App\'s own routes')
}

function testGateFailsClosedToOnboardingNeverToChildren() {
  assert(/isError \|\| !data \|\| data\.status !== 'active'/.test(content),
    'the gate must render Onboarding for ANY non-active status, a missing response, or a read error -- never default to showing children')
  assert(/return <Onboarding \/>/.test(content), 'a non-active tenant (or an unreadable status) must render Onboarding, not App')
  assert(/return children/.test(content), 'only a confirmed status === \'active\' may render the real children')
}

function testTenantStatusQueryOnlyEnabledOnceAuthenticated() {
  assert(/useTenantStatus\({ enabled: status === 'authenticated' }\)/.test(content),
    'the tenant-status query must only run once the session itself is confirmed authenticated -- never for an unauthenticated/loading session')
}

function testLoadingTenantStatusNeverFlashesTheRealDashboard() {
  const gateBody = content.slice(content.indexOf('function TenantLifecycleGate'))
  assert(/if \(isLoading\)/.test(gateBody), 'must show a loading state while tenant status is still being fetched')
  // The loading branch must return BEFORE the children fallthrough.
  const loadingIdx = gateBody.indexOf('if (isLoading)')
  const childrenIdx = gateBody.indexOf('return children')
  assert(loadingIdx > -1 && childrenIdx > -1 && loadingIdx < childrenIdx, 'the loading check must be evaluated before children could ever render')
}

run('imports useTenantStatus and Onboarding', testImportsTenantStatusAndOnboarding)
run('the gate sits above children, not as a child route', testGateSitsAboveChildrenNotAsAChildRoute)
run('the gate fails closed to Onboarding, never defaults to children', testGateFailsClosedToOnboardingNeverToChildren)
run('the tenant-status query is only enabled once authenticated', testTenantStatusQueryOnlyEnabledOnceAuthenticated)
run('loading tenant status never flashes the real dashboard', testLoadingTenantStatusNeverFlashesTheRealDashboard)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
