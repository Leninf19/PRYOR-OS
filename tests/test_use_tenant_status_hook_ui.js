// Multi-Tenant Phase 4J -- source-content regression tests for
// dashboard/src/hooks/useTenantStatus.js. Same regex/source-content
// convention as this project's other *_ui.js tests (no React render
// framework in this repo).
//
// Run directly: node tests/test_use_tenant_status_hook_ui.js

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

const content = read('hooks/useTenantStatus.js')

function testFetchesTheRealReadEndpoint() {
  assert(/fetch\('\/api\/session\/tenant-status'\)/.test(content), 'useTenantStatus must call the real GET /api/session/tenant-status endpoint')
}

function testDiscoverAndApproveCallTheRealOwnerOnlyEndpoints() {
  assert(/fetch\('\/api\/google\/discover-locations'/.test(content), 'must call the real discover-locations endpoint')
  assert(/fetch\('\/api\/google\/approve-locations'/.test(content), 'must call the real approve-locations endpoint')
}

function testSessionExpiredHandledConsistentlyWithTheRestOfTheApp() {
  assert(/SESSION_EXPIRED_EVENT/.test(content), 'a 401 must dispatch the shared SESSION_EXPIRED_EVENT, matching useTenantOps.js\'s established convention')
}

function testNeverCallsAPlatformAdminOrDirectStatusMutationEndpoint() {
  assert(!/['"`]\/api\/tenant-entitlements/.test(content), 'must never call the platform-admin-only entitlement mutation endpoint')
  assert(!/['"`]\/api\/tenant-ops/.test(content), 'must never call the platform-admin-only tenant-ops endpoint')
}

run('fetches the real tenant-status read endpoint', testFetchesTheRealReadEndpoint)
run('discover/approve call the real Owner-only endpoints', testDiscoverAndApproveCallTheRealOwnerOnlyEndpoints)
run('a 401 is handled consistently with the rest of the app', testSessionExpiredHandledConsistentlyWithTheRestOfTheApp)
run('never calls a platform-admin or direct status-mutation endpoint', testNeverCallsAPlatformAdminOrDirectStatusMutationEndpoint)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
