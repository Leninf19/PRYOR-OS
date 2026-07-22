// Regression tests for dashboard/src/services/reviewEmailService.js and
// dashboard/src/hooks/useReviewEmailWorkflow.js -- the frontend service/hook
// layer for the restaurant bad-review email workflow. No React/browser test
// framework exists in this repo -- these are plain text/regex
// source-content assertions, same style as test_action_workspace_service.js.
//
// Run directly: node tests/test_review_email_workflow_frontend.js

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

function testServiceHasNoRecipientOrCcParameter() {
  const content = read('services/reviewEmailService.js')
  // sendReviewEmail forwards whatever `payload` the caller builds -- the
  // structural guarantee is that ReviewExplorer.jsx (tested separately)
  // never constructs a payload with recipient/cc fields, and the backend
  // (test_send_review_email.js) ignores them even if present. Here we only
  // assert the service itself adds no recipient/cc logic of its own.
  assert(!/recipient\s*:/.test(content) && !/\bcc\s*:/.test(content), 'the service must not itself construct or default a recipient/cc field')
}

function testServiceHitsExpectedEndpoints() {
  const content = read('services/reviewEmailService.js')
  assert(/\/api\/actions\/preview-review-email/.test(content), 'must call the preview endpoint')
  assert(/\/api\/actions\/send-review-email/.test(content), 'must call the send endpoint')
  assert(/\/api\/actions\/update-email-status/.test(content), 'must call the update-email-status endpoint')
}

function testServiceHandlesSessionExpiry() {
  const content = read('services/reviewEmailService.js')
  assert(/from '\.\.\/lib\/dataClient\.js'/.test(content), 'must reuse dataClient.js\'s SESSION_EXPIRED_EVENT constant')
  assert(/res\.status === 401/.test(content))
  assert(/window\.dispatchEvent\(new Event\(SESSION_EXPIRED_EVENT\)\)/.test(content))
}

function testSendReviewEmailPreservesErrorCodeAndRecord() {
  const content = read('services/reviewEmailService.js')
  assert(/err\.code = body\.error/.test(content), 'a failed send must preserve the API error code (e.g. already_sent) for the caller to branch on')
  assert(/err\.record = body\.record/.test(content), 'a failed send must preserve any record the API returned, so the UI can show truthful current state')
}

function testHooksReuseActionWorkspaceCacheKey() {
  const content = read('hooks/useReviewEmailWorkflow.js')
  assert(/const WORKSPACE_QK = \['action-workspace'\]/.test(content),
    'must target the SAME query cache key useActionWorkspace.js uses, so a send is reflected in Action Center immediately')
}

function testPreviewHookIsLazy() {
  const content = read('hooks/useReviewEmailWorkflow.js')
  assert(/enabled: Boolean\(enabled && id && locationId\)/.test(content),
    'the preview query must be deferred until the caller explicitly enables it (panel opened), not fetched eagerly for every review row')
}

function testSendMutationUpdatesWorkspaceCacheOnSuccessAndFailure() {
  const content = read('hooks/useReviewEmailWorkflow.js')
  assert(/onSuccess: \(record, payload\) => \{/.test(content), 'onSuccess must merge the returned record into the workspace cache')
  assert(/onError: \(err, payload\) => \{/.test(content), 'onError must also reconcile the cache when the server returned a record (duplicate/failure)')
}

const tests = [
  ['the service adds no recipient/cc logic of its own', testServiceHasNoRecipientOrCcParameter],
  ['the service calls the three expected endpoints', testServiceHitsExpectedEndpoints],
  ['the service handles session expiry the same way as every other data fetch', testServiceHandlesSessionExpiry],
  ['a failed send preserves error code and record for the caller', testSendReviewEmailPreservesErrorCodeAndRecord],
  ['hooks reuse useActionWorkspace.js\'s exact cache key', testHooksReuseActionWorkspaceCacheKey],
  ['the preview hook is lazy (only enabled when the panel is open)', testPreviewHookIsLazy],
  ['the send mutation reconciles the workspace cache on both success and failure', testSendMutationUpdatesWorkspaceCacheOnSuccessAndFailure],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
