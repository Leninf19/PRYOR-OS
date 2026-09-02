// Multi-Tenant Phase 4J -- source-content regression tests for
// dashboard/src/pages/Onboarding.jsx. No React component-render test
// framework exists in this repo (see test_google_business_profile_ui.js's
// own header) -- these are plain-text/regex source-content assertions,
// matching this project's established convention exactly.
//
// Run directly: node tests/test_onboarding_ui.js

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

const content = read('pages/Onboarding.jsx')

function testImportsTheRealHooksNotAnInventedState() {
  assert(/from '\.\.\/hooks\/useTenantStatus\.js'/.test(content), 'must read tenant lifecycle status from the real useTenantStatus() hook')
  assert(/useDiscoverLocations/.test(content) && /useApproveLocations/.test(content), 'must use the real discover/approve mutations, not invented local state')
  assert(/from '\.\.\/hooks\/useGoogleOAuthStatus\.js'/.test(content), 'must read Google connection state from the real useGoogleOAuthStatus() hook')
}

function testRendersBasedOnBackendStatusNotLocalState() {
  // Every branch renders off tenantStatus.status (destructured as `status`)
  // -- there must be no local boolean like `onboardingComplete`/`isDone`
  // driving the Ready step.
  assert(/const status = tenantStatus\.status/.test(content), 'must derive the rendered step directly from the backend\'s own tenantStatus.status')
  assert(!/useState\(false\)[\s\S]{0,80}(complete|done|finished|active)/i.test(content), 'must never track onboarding completion as invented local component state')
  for (const s of ['onboarding', 'locations_approved', 'provisioning', 'provisioning_failed', 'provisioned', 'initial_sync', 'initial_sync_failed', 'active', 'suspended']) {
    assert(content.includes(`'${s}'`), `must render a distinct branch for backend status '${s}'`)
  }
}

function testOAuthSuccessAloneDoesNotShowOnboardingComplete() {
  // ReadyStep (onboarding complete) must be reachable ONLY from
  // status === 'active', never from gbpStatus/isConnected alone.
  const readyReturnLines = content.split('\n').filter(l => /return <ReadyStep/.test(l))
  assert(readyReturnLines.length === 1, `expected exactly one <ReadyStep/> render, found ${readyReturnLines.length}`)
  assert(/if \(status === 'active'\) return <ReadyStep \/>/.test(content), 'ReadyStep must be gated on status === \'active\', never on Google connection state')
  // isConnected only ever gates the Connect vs Discover/Approve branch,
  // never anything resembling "onboarding complete."
  assert(/const isConnected = gbpStatus\?\.state === 'connected'/.test(content), 'isConnected must be derived from gbpStatus, not conflated with tenant status')
  assert(!/isConnected[\s\S]{0,40}<ReadyStep/.test(content), 'isConnected must never directly gate rendering ReadyStep')
}

function testLocationSelectionIsBuiltOnlyFromDiscoveredLocations() {
  assert(/discovery\.locations\.map\(loc =>/.test(content), 'the choose-locations checkbox list must be built by mapping over discovery.locations')
  assert(/setSelected\(new Set\(\(data\.locations \?\? \[\]\)\.map\(l => l\.googleLocationId\)\)\)/.test(content),
    'the initial selection must be seeded only from the discovery response\'s own locations, never a hardcoded or externally-supplied list')
  assert(/selectedGoogleLocationIds: \[\.\.\.selected\]/.test(content), 'submission must send only the ids that came from discovery/selection state')
}

function testNoLocationsDiscoveredIsADistinctState() {
  assert(/No locations found/.test(content), 'must have a distinct "no locations discovered" state')
  assert(/\(discovery\.locations \?\? \[\]\)\.length === 0/.test(content), 'the empty-discovery state must be checked explicitly, not treated as a generic error')
}

function testFailureStatesAreVisibleAndRetryableWithoutASelfServiceTrigger() {
  assert(/provisioning_failed/.test(content) && /FailedStep/.test(content), 'provisioning_failed must render a distinct, visible failure step')
  assert(/initial_sync_failed/.test(content) && /FailedStep/.test(content), 'initial_sync_failed must render a distinct, visible failure step')
  assert(/onRefresh=\{refetch\}/.test(content), 'failure/waiting steps must offer a status re-check (refetch), never a silent dead end')
  // "Retryable" here means re-checking status, never re-triggering
  // provisioning/sync directly -- Phase 4H.1's GitHub-Actions-only dispatch
  // boundary must never be bypassed by a tenant-facing control. Checks for
  // an actual fetch/call, not documentation prose that merely NAMES the
  // workflow file while explaining why no trigger exists here.
  assert(!/['"`]\/api\/[^'"`]*(trigger-sync|trigger-import)/i.test(content),
    'must never expose a tenant-facing trigger for provisioning/Initial Sync -- that remains the platform operator\'s GitHub Actions dispatch')
}

function testSuspendedRendersADistinctScreenNeverTheDashboard() {
  assert(/status === 'suspended'/.test(content) && /SuspendedStep/.test(content), 'a suspended tenant must render a distinct SuspendedStep, never fall through to the normal flow')
}

function testNeverCallsThePlatformAdminEntitlementEndpoint() {
  assert(!/tenant-entitlements/.test(content), 'the Owner-facing onboarding UI must never reference the platform-admin-only entitlement mutation endpoint')
}

function testNonOwnerSeesANoticeInsteadOfInteractiveControls() {
  assert(/isOwner/.test(content), 'must distinguish Owner from non-Owner accounts')
  assert(/NotOwnerNotice/.test(content), 'a non-Owner account mid-onboarding must see an explanatory notice, not the interactive connect/discover/approve controls')
}

run('imports the real hooks, never invented state', testImportsTheRealHooksNotAnInventedState)
run('renders based on backend status, not local state', testRendersBasedOnBackendStatusNotLocalState)
run('OAuth success alone does not show onboarding complete', testOAuthSuccessAloneDoesNotShowOnboardingComplete)
run('location selection is built only from discovered locations', testLocationSelectionIsBuiltOnlyFromDiscoveredLocations)
run('no locations discovered is a distinct state', testNoLocationsDiscoveredIsADistinctState)
run('failures are visible/retryable without a self-service trigger', testFailureStatesAreVisibleAndRetryableWithoutASelfServiceTrigger)
run('suspended renders a distinct screen, never the dashboard', testSuspendedRendersADistinctScreenNeverTheDashboard)
run('never calls the platform-admin entitlement endpoint', testNeverCallsThePlatformAdminEntitlementEndpoint)
run('a non-Owner sees a notice instead of interactive controls', testNonOwnerSeesANoticeInsteadOfInteractiveControls)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
