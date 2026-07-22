// Runs every Node regression test in tests/ and reports a pass/fail summary
// -- the Node-side counterpart to run_all.py.
//
// Run directly: node tests/run_all_node.js

import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TESTS = [
  'test_publish_reply.js',
  'test_auth.js',
  'test_permissions.js',
  'test_authorization_matrix.js',
  'test_rate_limit.js',
  'test_action_store.js',
  'test_actions_endpoint.js',
  'test_session_accounts.js',
  'test_login.js',
  'test_data_endpoint.js',
  'test_middleware.js',
  'test_endpoint_auth.js',
  'test_oauth_safety.js',
  'test_google_oauth_error_contract.js',
  'test_http_methods.js',
  'test_workflow_concurrency.js',
  'test_no_direct_data_fetches.js',
  'test_provider_health_hook.js',
  'test_provider_health_ui.js',
  'test_priority_digest.js',
  'test_executive_intelligence_center_ui.js',
  'test_executive_intelligence_prefetch.js',
]

const results = {}
for (const name of TESTS) {
  console.log(`=== ${name} ===`)
  const proc = spawnSync(process.execPath, [path.join(__dirname, name)], { stdio: 'inherit' })
  results[name] = proc.status === 0
  console.log()
}

console.log('=== Summary ===')
for (const [name, ok] of Object.entries(results)) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${name}`)
}

const failed = Object.entries(results).filter(([, ok]) => !ok).map(([n]) => n)
if (failed.length === 0) {
  console.log(`\nALL ${TESTS.length} TEST FILES PASSED`)
  process.exit(0)
}
console.log(`\n${failed.length} of ${TESTS.length} TEST FILES FAILED: ${failed.join(', ')}`)
process.exit(1)
