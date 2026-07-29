// Regression tests for the localStorage -> shared-API migration of
// dashboard/src/services/actionWorkspaceService.js and the small onSuccess
// adjustment in dashboard/src/hooks/useActionWorkspace.js this required.
// No React/browser test framework exists in this repo -- these are plain
// text/regex source-content assertions, the same style
// test_provider_health_hook.js uses for browser-dependent frontend code.
//
// Run directly: node tests/test_action_workspace_service.js

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
  return readFileSync(path.join(SRC_DIR, relPath), 'utf-8')
}

function testServiceNoLongerUsesLocalStorage() {
  const content = read('services/actionWorkspaceService.js')
  // The historical localStorage-only design is still mentioned in prose in
  // this file's header comment -- only actual localStorage.* usage matters.
  assert(!/localStorage\.(get|set)Item/.test(content), 'actionWorkspaceService.js must no longer read/write localStorage')
}

function testGetAllFetchesTheListEndpoint() {
  const content = read('services/actionWorkspaceService.js')
  assert(/fetch\('\/api\/actions\/list'\)/.test(content), 'getAll() must fetch /api/actions/list')
  assert(/const \{ actions \} = await res\.json\(\)/.test(content), 'getAll() must read the {actions} shape the endpoint returns')
}

function testSetRecordPostsToUpdateEndpointWithExpectedBody() {
  const content = read('services/actionWorkspaceService.js')
  assert(/fetch\('\/api\/actions\/update', \{/.test(content), 'setRecord() must POST to /api/actions/update')
  assert(/method: 'POST'/.test(content), 'setRecord() must use POST')
  assert(/body: JSON\.stringify\(\{ id, patch, logAction \}\)/.test(content),
    'setRecord() must send exactly { id, patch, logAction } -- no client-computed defaults/history any more')
  assert(/const \{ record \} = await res\.json\(\)/.test(content), 'setRecord() must read the {record} shape the endpoint returns')
}

function testServiceHandlesSessionExpiry() {
  const content = read('services/actionWorkspaceService.js')
  assert(/from '\.\.\/lib\/dataClient\.js'/.test(content), 'must reuse dataClient.js\'s SESSION_EXPIRED_EVENT constant, not invent a new one')
  assert(/res\.status === 401/.test(content), 'must detect a 401 the same way dataClient.js does')
  assert(/window\.dispatchEvent\(new Event\(SESSION_EXPIRED_EVENT\)\)/.test(content),
    'a 401 must dispatch SESSION_EXPIRED_EVENT so AuthGate drops back to the login screen, same as every other data fetch')
}

function testServicePreservesAsyncFunctionSignatures() {
  const content = read('services/actionWorkspaceService.js')
  assert(/export async function getAll\(\)/.test(content), 'getAll() signature must be unchanged')
  assert(/export async function setRecord\(id, patch, logAction\)/.test(content), 'setRecord() signature must be unchanged')
}

function testHookOnSuccessMergesSingleRecordNotWholeCache() {
  const content = read('hooks/useActionWorkspace.js')
  assert(/onSuccess: \(record, \{ id \}\) => \{/.test(content),
    'onSuccess must destructure the single returned record and the mutation id')
  assert(/qc\.setQueryData\(QK, \{ \.\.\.prev, \[id\]: record \}\)/.test(content),
    'onSuccess must merge the one updated record into the existing cache, not replace the whole cache with a single record')
}

function testHookPublicInterfaceUnchanged() {
  const content = read('hooks/useActionWorkspace.js')
  assert(/export function useActionWorkspace\(\)/.test(content), 'hook export name must be unchanged')
  assert(/queryFn: actionWorkspaceService\.getAll/.test(content), 'hook must still delegate reads to the service, not fetch directly')
  assert(/mutationFn: \(\{ id, patch, logAction \}\) => actionWorkspaceService\.setRecord\(id, patch, logAction\)/.test(content),
    'hook must still delegate writes to the service, not fetch directly')
  assert(/return \{ data: data \?\? \{\}, setRecord \}/.test(content), 'hook return shape must be unchanged -- ActionCenter.jsx needs no changes for this migration')
}

function testActionsNeverCallsFetchDirectly() {
  // M6: Actions.jsx is the live consumer of this service (ActionCenter.jsx
  // is an unrouted rollback artifact) -- the "service layer is the only
  // place responsible for persistence" guarantee must hold for the file
  // that actually ships.
  const content = read('pages/Actions.jsx')
  assert(!/fetch\(/.test(content), 'Actions.jsx must never call fetch() itself -- the service layer is the only place responsible for persistence')
}

function testActionCenterRollbackArtifactStillNeverCallsFetchDirectly() {
  // ActionCenter.jsx is kept on disk, unrouted, for rollback -- if it were
  // ever re-routed it must still hold the same guarantee.
  const content = read('pages/ActionCenter.jsx')
  assert(!/fetch\(/.test(content), 'ActionCenter.jsx (rollback artifact) must never call fetch() itself')
}

const tests = [
  ['service no longer uses localStorage', testServiceNoLongerUsesLocalStorage],
  ['getAll() fetches /api/actions/list', testGetAllFetchesTheListEndpoint],
  ['setRecord() posts to /api/actions/update with the expected body', testSetRecordPostsToUpdateEndpointWithExpectedBody],
  ['service reuses dataClient.js\'s session-expiry handling on 401', testServiceHandlesSessionExpiry],
  ['service function signatures are unchanged', testServicePreservesAsyncFunctionSignatures],
  ['hook onSuccess merges the single returned record, not the whole cache', testHookOnSuccessMergesSingleRecordNotWholeCache],
  ['hook public interface (export name, delegation, return shape) is unchanged', testHookPublicInterfaceUnchanged],
  ['Actions.jsx never calls fetch() directly', testActionsNeverCallsFetchDirectly],
  ['ActionCenter.jsx (rollback artifact) never calls fetch() directly', testActionCenterRollbackArtifactStillNeverCallsFetchDirectly],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
