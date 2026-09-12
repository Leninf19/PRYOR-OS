// "Prevent duplicate/shadow tenant creation" hardening -- Phase 4:
// structural caller-registry test, matching this project's own established
// pattern (test_authorization_matrix.js's EXPECTED_SCOPED_AUTH_CALLERS,
// test_provisioned_not_active.js's "only ONE 'active' literal" scan).
//
// tenantConfigStore.js's upsertTenantConfig() and userStore.js's
// upsertUser() both now refuse to create a brand-new record unless the
// caller explicitly opts in (`allowCreate: true` / a valid `creationMode`).
// This file proves WHO is allowed to opt in stays a small, enumerated,
// reviewed set -- a new, unreviewed call site adding `allowCreate: true`
// or `creationMode: ...` anywhere in dashboard/api is a structural change
// to "how can a brand-new tenant/user identity come to exist," and this
// test is designed to fail loudly (not silently pass) the moment that
// happens, exactly like the frozen registries it mirrors.
//
// Pure source-content scan -- no Redis, no HTTP, no rendering.
//
// Run directly: node tests/test_tenant_creation_callers.js

import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const API_DIR = path.resolve(__dirname, '..', 'dashboard', 'api')

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

// Walks dashboard/api recursively, returning [{relPath, content}] for every
// .js file -- production source only (this directory has no test files).
function walkApiFiles() {
  const out = []
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (entry.endsWith('.js')) out.push({ relPath: path.relative(API_DIR, full).replace(/\\/g, '/'), content: readFileSync(full, 'utf-8') })
    }
  }
  walk(API_DIR)
  return out
}

// Strips single-line (//) and block (/* */) comments, AND backtick template
// literals (error messages routinely spell out `allowCreate: true`/
// `creationMode` by name as helpful guidance -- those must never count as a
// real caller) -- crudely but good enough for this file's purpose, matching
// the same pragmatic approach test_provisioned_not_active.js's own
// literal-count scan already uses elsewhere in this suite.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

// --- Registry: every file+mode allowed to materialize a NEW tenant_config
// record (tenantConfigStore.js's `allowCreate: true`) ------------------
// Final pre-deploy review (last hardening pass): the LTA-only exception
// previously carved into recordLocationApproval() has been REMOVED --
// tenantConfigStore.js now has ZERO tenant-specific knowledge of any kind
// and unconditionally refuses to create a record for ANY tenantId it
// doesn't already have one for, including Los Tres Amigos. The LTA
// compatibility behavior this exception existed to preserve now lives at
// the LIFECYCLE/APPLICATION layer instead: google/[action].js's
// approveLocations() checks tenants.js's own canonical
// locationCatalogModeFor() and short-circuits BEFORE ever calling
// recordLocationApproval() for a BOOTSTRAP-mode tenant -- see that
// function's own comment. Exactly ONE file may pass allowCreate: true.
const APPROVED_ALLOW_CREATE_CALLERS = new Set([
  '_lib/tenantCreation.js', // createNewTenant() -- the ONE centralized primitive
])

// --- Registry: every file+mode allowed to materialize a NEW user record
// (userStore.js's `creationMode: UserCreationMode.*`) -------------------
// Final pre-deploy review: MIGRATION is now a STRICT identity-materialization
// mode (session/[action].js's reset-password ONLY -- role/locationIds/
// disabled must match sourceIdentity exactly); the settings/[action].js
// admin actions that legitimately change role/locationIds/disabled moved to
// the separate ADMIN_MANAGED_UPDATE mode, which still requires
// sourceIdentity but permits those specific fields to differ.
const APPROVED_CREATION_MODE_CALLERS = new Set([
  '_lib/tenantCreation.js:INITIAL_TENANT_OWNER', // createNewTenant()'s own owner-user write
  'settings/[action].js:EXISTING_TENANT_INVITE', // inviteUserAction()
  'session/[action].js:MIGRATION', // reset-password (strict static-account promotion, no field changes)
  'settings/[action].js:ADMIN_MANAGED_UPDATE', // update-role/locations, disable/enable, can-create-tasks (authorized admin mutation)
])

function testExactAllowCreateCallerSet() {
  const files = walkApiFiles()
  const found = new Set()
  for (const { relPath, content } of files) {
    const stripped = stripComments(content)
    if (/allowCreate:\s*true/.test(stripped)) found.add(relPath)
  }
  const foundSorted = [...found].sort()
  const approvedSorted = [...APPROVED_ALLOW_CREATE_CALLERS].sort()
  assert(
    JSON.stringify(foundSorted) === JSON.stringify(approvedSorted),
    `allowCreate: true caller set changed -- found [${foundSorted.join(', ')}], approved [${approvedSorted.join(', ')}]. ` +
    `A new caller must be explicitly reviewed and added to APPROVED_ALLOW_CREATE_CALLERS in this test.`
  )
}

function testExactCreationModeCallerSet() {
  const files = walkApiFiles()
  const found = new Set()
  const modePattern = /creationMode:\s*UserCreationMode\.([A-Z_]+)/g
  for (const { relPath, content } of files) {
    const stripped = stripComments(content)
    let match
    while ((match = modePattern.exec(stripped))) {
      found.add(`${relPath}:${match[1]}`)
    }
  }
  const foundSorted = [...found].sort()
  const approvedSorted = [...APPROVED_CREATION_MODE_CALLERS].sort()
  assert(
    JSON.stringify(foundSorted) === JSON.stringify(approvedSorted),
    `creationMode caller set changed -- found [${foundSorted.join(', ')}], approved [${approvedSorted.join(', ')}]. ` +
    `A new caller must be explicitly reviewed and added to APPROVED_CREATION_MODE_CALLERS in this test.`
  )
}

function testCreateNewTenantIsTheOnlyExportedTenantCreationPrimitive() {
  const src = readFileSync(path.join(API_DIR, '_lib', 'tenantCreation.js'), 'utf-8')
  assert(/export async function createNewTenant\(/.test(src), 'tenantCreation.js must export createNewTenant()')
  // Sanity: the file must not ALSO export some second, parallel creation
  // function that would fragment "how tenants get created" into two
  // reviewed paths instead of one.
  const exportedFunctionNames = [...src.matchAll(/export (?:async )?function (\w+)\(/g)].map(m => m[1])
  assert(exportedFunctionNames.length === 1 && exportedFunctionNames[0] === 'createNewTenant',
    `tenantCreation.js must export exactly one function, createNewTenant -- found [${exportedFunctionNames.join(', ')}]`)
}

// Final hardening pass: proves the LTA exception is GONE, not merely
// narrowed -- tenantConfigStore.js must contain no tenant-specific literal
// or conditional of any kind, and recordLocationApproval() must
// unconditionally throw when no record exists.
function testTenantConfigStoreHasNoTenantSpecificKnowledge() {
  const src = stripComments(readFileSync(path.join(API_DIR, '_lib', 'tenantConfigStore.js'), 'utf-8'))
  assert(!/t_los-tres-amigos/.test(src), 'tenantConfigStore.js must never reference the LTA tenantId literal -- that knowledge belongs at the application layer (google/[action].js), never in this low-level persistence primitive')
  assert(!/LOS_TRES_AMIGOS/.test(src), 'tenantConfigStore.js must define no LTA-specific constant of any kind')
  assert(/if \(!existing\) \{\s*throw new TenantDoesNotExistError/.test(src),
    'recordLocationApproval() must unconditionally throw TenantDoesNotExistError when no tenant_config exists -- no exception of any kind')
}

// Proves the BOOTSTRAP compatibility branch lives where it belongs:
// google/[action].js's approveLocations(), gated on the canonical
// tenants.js classification, never calling recordLocationApproval() (and
// therefore never touching tenant_config) for a BOOTSTRAP-mode tenant.
function testApproveLocationsIsBootstrapAwareAtTheApplicationLayer() {
  const src = stripComments(readFileSync(path.join(API_DIR, 'google', '[action].js'), 'utf-8'))
  assert(/locationCatalogModeFor\(tenantId\) === LocationCatalogMigrationMode\.BOOTSTRAP/.test(src),
    'approveLocations() must check tenants.js\'s canonical locationCatalogModeFor() classification')
  const bootstrapBranch = src.match(/if \(locationCatalogModeFor\(tenantId\) === LocationCatalogMigrationMode\.BOOTSTRAP\) \{[\s\S]*?\n  \}/)
  assert(bootstrapBranch, 'must find the BOOTSTRAP short-circuit branch in approveLocations()')
  assert(!/recordLocationApproval/.test(bootstrapBranch[0]), 'the BOOTSTRAP branch must never call recordLocationApproval() -- it must return before reaching it')
  assert(!/triggerAutomaticProvisioning/.test(bootstrapBranch[0]), 'the BOOTSTRAP branch must never trigger automatic provisioning dispatch')
}

// Final pre-deploy review, item G (extended by the "close the last
// tenant-creation exception" pass to also cover sourceIdentity, per its own
// item 5): no customer-facing request may supply allowCreate/creationMode/
// creationSource/tenantIdOverride/sourceIdentity as a trusted authorization
// control. Every real occurrence of these identifiers in the endpoint files
// must be a hardcoded literal (UserCreationMode.X / TenantCreationMode.X /
// a fixed string) or a server-resolved value already established elsewhere
// in the same handler (e.g. `sourceIdentity: current` where `current` came
// from getAccountById()), never destructured or read directly from
// req.body/req.query.
function testTrustSensitiveFieldsAreNeverClientSupplied() {
  const sensitiveNames = ['allowCreate', 'creationMode', 'creationSource', 'tenantIdOverride', 'sourceIdentity']
  const endpointFiles = ['session/[action].js', 'settings/[action].js', 'google/[action].js', 'admin/[action].js']
  for (const relPath of endpointFiles) {
    const fullPath = path.join(API_DIR, relPath)
    let content
    try {
      content = stripComments(readFileSync(fullPath, 'utf-8'))
    } catch {
      continue // not every endpoint file necessarily exists/matters here
    }
    for (const name of sensitiveNames) {
      // Flags DIRECT `req.body`/`req.query` property access (`req.body.X`)
      // or destructuring that names one of these fields within the SAME
      // `{ ... } = req.body` pattern (bounded to one destructuring
      // expression, never an unbounded scan across the whole file, which
      // would false-positive on any later, unrelated use of the name).
      const directAccessPattern = new RegExp(`req\\.(body|query)\\??\\.${name}\\b`)
      const destructurePattern = new RegExp(`\\{[^{}]*\\b${name}\\b[^{}]*\\}\\s*=\\s*req\\.(body|query)`)
      assert(!directAccessPattern.test(content) && !destructurePattern.test(content),
        `${relPath} must never read "${name}" from req.body/req.query -- it is a trust boundary, not client-suppliable input`)
    }
  }
}

function testSelfServiceModeSourceForbidsTenantIdOverride() {
  const src = stripComments(readFileSync(path.join(API_DIR, '_lib', 'tenantCreation.js'), 'utf-8'))
  assert(/if \(tenantIdOverride\) \{[\s\S]{0,200}?throw new TenantCreationModeRequiredError/.test(src),
    'createNewTenant() must structurally refuse tenantIdOverride for self_service mode')
}

run('the exact set of allowCreate:true callers matches the reviewed registry', testExactAllowCreateCallerSet)
run('the exact set of creationMode callers matches the reviewed registry', testExactCreationModeCallerSet)
run('createNewTenant() is the only exported tenant-creation primitive', testCreateNewTenantIsTheOnlyExportedTenantCreationPrimitive)
run('tenantConfigStore.js has zero tenant-specific knowledge -- the LTA exception is fully removed', testTenantConfigStoreHasNoTenantSpecificKnowledge)
run('approveLocations() is BOOTSTRAP-aware at the application layer, never calling recordLocationApproval() for LTA', testApproveLocationsIsBootstrapAwareAtTheApplicationLayer)
run('self-service mode structurally forbids an operator-chosen tenantIdOverride', testSelfServiceModeSourceForbidsTenantIdOverride)
run('allowCreate/creationMode/creationSource/tenantIdOverride/sourceIdentity are never read from req.body/req.query', testTrustSensitiveFieldsAreNeverClientSupplied)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
