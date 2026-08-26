// Regression tests for the Phase 2 Milestone 2 authorization layer:
// dashboard/api/_lib/permissions.js (Permission registry, roleHasPermission)
// and the composable helpers added to dashboard/api/_lib/auth.js
// (requireLocationAccess, requireOwnership, requireScopedAuth).
//
// This milestone is purely additive -- these helpers are not yet called by
// any production endpoint, and requireAuth() itself must be unchanged. This
// file only tests the new surface; see test_auth.js for the unchanged
// requireAuth() regression coverage.
//
// Run directly: node tests/test_permissions.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { requireAuth, requireLocationAccess, requireOwnership, requireScopedAuth } from '../dashboard/api/_lib/auth.js'
import { Permission, ROLE_PERMISSIONS, roleHasPermission } from '../dashboard/api/_lib/permissions.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DASHBOARD_DIR = path.resolve(__dirname, '..', 'dashboard')

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

function fakeReqRes(cookieValue) {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  const req = { headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : {} }
  return { req, res }
}

async function buildDirectory() {
  const hash = await bcrypt.hash('correct-horse-battery-staple', 12)
  return {
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner' },
      { userId: 'usr_admin', email: 'admin@example.com', passwordHash: hash, role: 'admin', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Admin' },
      { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Marketing' },
      { userId: 'usr_lm', email: 'lm@example.com', passwordHash: hash, role: 'location_manager', locationIds: [3, 7, 12], sessionVersion: 1, disabled: false, displayName: 'Location Manager' },
      { userId: 'usr_ro', email: 'ro@example.com', passwordHash: hash, role: 'read_only', locationIds: [7], sessionVersion: 1, disabled: false, displayName: 'Read Only' },
    ],
  }
}

// --- Permission registry -----------------------------------------------

async function testPermissionRegistryIsFrozenAndComplete() {
  assert(Object.isFrozen(Permission), 'Permission must be frozen')
  const expected = [
    'VIEW_ALL', 'VIEW_ASSIGNED', 'REPLY', 'REPLY_ASSIGNED', 'EXPORT', 'EXPORT_ASSIGNED', 'CAMPAIGNS', 'ADMIN',
    // Phase 8 (Operational Settings Platform)
    'CONTACTS_VIEW', 'CONTACTS_MANAGE', 'EMAIL_VIEW', 'SETTINGS_ADMIN', 'AUDIT_VIEW',
    // Multi-Location Authentication & User Access System
    'USERS_MANAGE',
  ]
  for (const key of expected) {
    assert(typeof Permission[key] === 'string' && Permission[key].length > 0, `Permission.${key} must be a non-empty string`)
  }
  assert(Object.keys(Permission).length === expected.length, 'Permission must contain exactly the expected keys')
}

async function testRolePermissionsIsFrozen() {
  assert(Object.isFrozen(ROLE_PERMISSIONS), 'ROLE_PERMISSIONS must be frozen')
  for (const role of ['owner', 'admin', 'marketing', 'location_manager', 'read_only']) {
    assert(ROLE_PERMISSIONS[role] instanceof Set, `ROLE_PERMISSIONS.${role} must be a Set`)
  }
}

// Every role x every permission, matching the approved capability matrix
// exactly -- 'admin' added by the Multi-Location Authentication & User
// Access System milestone (same tier as owner except SETTINGS_ADMIN/ADMIN,
// which stay Owner-only-by-design; both roles get the new USERS_MANAGE).
// Written as an explicit table (not derived) so the expected grants are
// legible here without cross-referencing the architecture doc, and so any
// accidental drift in permissions.js shows up as a specific, named failure.
const EXPECTED_GRANTS = {
  owner: {
    VIEW_ALL: true, VIEW_ASSIGNED: true, REPLY: true, REPLY_ASSIGNED: false,
    EXPORT: true, EXPORT_ASSIGNED: false, CAMPAIGNS: true, ADMIN: true,
    CONTACTS_VIEW: true, CONTACTS_MANAGE: true, EMAIL_VIEW: true, SETTINGS_ADMIN: true, AUDIT_VIEW: true,
    USERS_MANAGE: true,
  },
  admin: {
    // Commit 1 scope only -- Contacts/Email/Audit grants land in the later
    // commit that reviews admin access for those endpoints. See
    // permissions.js's own comment on the admin role.
    VIEW_ALL: true, VIEW_ASSIGNED: true, REPLY: true, REPLY_ASSIGNED: false,
    EXPORT: true, EXPORT_ASSIGNED: false, CAMPAIGNS: true, ADMIN: false,
    CONTACTS_VIEW: false, CONTACTS_MANAGE: false, EMAIL_VIEW: false, SETTINGS_ADMIN: false, AUDIT_VIEW: false,
    USERS_MANAGE: true,
  },
  marketing: {
    VIEW_ALL: true, VIEW_ASSIGNED: true, REPLY: true, REPLY_ASSIGNED: false,
    EXPORT: true, EXPORT_ASSIGNED: false, CAMPAIGNS: true, ADMIN: false,
    CONTACTS_VIEW: true, CONTACTS_MANAGE: true, EMAIL_VIEW: true, SETTINGS_ADMIN: false, AUDIT_VIEW: false,
    USERS_MANAGE: false,
  },
  location_manager: {
    VIEW_ALL: false, VIEW_ASSIGNED: true, REPLY: false, REPLY_ASSIGNED: true,
    EXPORT: false, EXPORT_ASSIGNED: true, CAMPAIGNS: false, ADMIN: false,
    CONTACTS_VIEW: true, CONTACTS_MANAGE: false, EMAIL_VIEW: false, SETTINGS_ADMIN: false, AUDIT_VIEW: false,
    USERS_MANAGE: false,
  },
  read_only: {
    VIEW_ALL: false, VIEW_ASSIGNED: true, REPLY: false, REPLY_ASSIGNED: false,
    EXPORT: false, EXPORT_ASSIGNED: false, CAMPAIGNS: false, ADMIN: false,
    CONTACTS_VIEW: false, CONTACTS_MANAGE: false, EMAIL_VIEW: false, SETTINGS_ADMIN: false, AUDIT_VIEW: false,
    USERS_MANAGE: false,
  },
}

async function testRoleHasPermissionMatrix() {
  for (const [role, grants] of Object.entries(EXPECTED_GRANTS)) {
    for (const [permKey, expected] of Object.entries(grants)) {
      const permission = Permission[permKey]
      const actual = roleHasPermission(role, permission)
      assert(actual === expected, `${role} x ${permKey}: expected ${expected}, got ${actual}`)
    }
  }
}

async function testReadOnlyHasNoExportPermission() {
  // Called out explicitly because Revision 3's own test-matrix review caught
  // this exact distinction being accidentally merged with location_manager.
  assert(roleHasPermission('read_only', Permission.EXPORT) === false, 'read_only must not have EXPORT')
  assert(roleHasPermission('read_only', Permission.EXPORT_ASSIGNED) === false, 'read_only must not have EXPORT_ASSIGNED either')
  assert(roleHasPermission('location_manager', Permission.EXPORT_ASSIGNED) === true, 'location_manager must have EXPORT_ASSIGNED')
}

async function testRoleHasPermissionFailsClosedForUnknownInputs() {
  assert(roleHasPermission('superadmin', Permission.VIEW_ALL) === false, 'unknown role must not have any permission')
  assert(roleHasPermission('owner', 'not_a_real_permission') === false, 'unknown permission must never be granted')
  assert(roleHasPermission(undefined, Permission.VIEW_ALL) === false, 'undefined role must fail closed')
  assert(roleHasPermission('owner', undefined) === false, 'undefined permission must fail closed')
}

// --- requireLocationAccess / requireOwnership ---------------------------

async function testWildcardLocationAccessGrantsAnyLocation() {
  const account = { locationIds: '*' }
  for (const locationId of [1, 7, 12, 9999]) {
    assert(requireLocationAccess(account, locationId) === true, `wildcard account must access location ${locationId}`)
  }
}

async function testExplicitArrayLocationAccessPositive() {
  const account = { locationIds: [3, 7, 12] }
  for (const locationId of [3, 7, 12]) {
    assert(requireLocationAccess(account, locationId) === true, `account with [3,7,12] must access location ${locationId}`)
  }
}

async function testExplicitArrayLocationAccessNegative() {
  const account = { locationIds: [3, 7, 12] }
  for (const locationId of [1, 99, 0]) {
    assert(requireLocationAccess(account, locationId) === false, `account with [3,7,12] must NOT access location ${locationId}`)
  }
}

async function testRequireOwnershipMatchesRequireLocationAccess() {
  const wildcard = { locationIds: '*' }
  const scoped = { locationIds: [7] }
  assert(requireOwnership(wildcard, 42) === true, 'requireOwnership must allow wildcard accounts any location')
  assert(requireOwnership(scoped, 7) === true, 'requireOwnership positive case: location in grant')
  assert(requireOwnership(scoped, 8) === false, 'requireOwnership negative case: location not in grant')
}

// --- requireScopedAuth ---------------------------------------------------

async function tokenFor(userId, role, locationIds) {
  return signSession({ userId, email: `${userId}@example.com`, role, locationIds, sessionVersion: 1 })
}

async function testRequireScopedAuthUnauthenticated() {
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify(await buildDirectory())
  const { req, res } = fakeReqRes(null)
  const result = await requireScopedAuth(req, res, {
    permission: Permission.VIEW_ASSIGNED,
    resolveLocationId: async () => 7,
  })
  assert(result === null, 'no cookie -> null result')
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testRequireScopedAuthPermissionDenied() {
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify(await buildDirectory())
  const token = await tokenFor('usr_ro', 'read_only', [7])
  const { req, res } = fakeReqRes(token)
  // read_only has no EXPORT permission at all.
  const result = await requireScopedAuth(req, res, {
    permission: Permission.EXPORT,
    resolveLocationId: async () => 7,
  })
  assert(result === null, 'missing permission -> null result')
  assert(res.statusCode === 403, `expected 403, got ${res.statusCode}`)
  assert(res.body.error === 'forbidden', res.body.error)
}

async function testRequireScopedAuthLocationOutOfScopeReturns404() {
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify(await buildDirectory())
  const token = await tokenFor('usr_lm', 'location_manager', [3, 7, 12])
  const { req, res } = fakeReqRes(token)
  const result = await requireScopedAuth(req, res, {
    permission: Permission.VIEW_ASSIGNED,
    resolveLocationId: async () => 99, // not in this account's grant
  })
  assert(result === null, 'out-of-scope location -> null result')
  assert(res.statusCode === 404, `expected 404 (not 403, to avoid existence disclosure), got ${res.statusCode}`)
  assert(res.body.error === 'not_found', res.body.error)
}

async function testRequireScopedAuthSucceedsInScope() {
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify(await buildDirectory())
  const token = await tokenFor('usr_lm', 'location_manager', [3, 7, 12])
  const { req, res } = fakeReqRes(token)
  const result = await requireScopedAuth(req, res, {
    permission: Permission.VIEW_ASSIGNED,
    resolveLocationId: async () => 7,
  })
  assert(result !== null, 'in-scope location with granted permission must succeed')
  assert(result.account.role === 'location_manager', 'returned account has current role')
  assert(result.locationId === 7, 'returned locationId matches resolved id')
  assert(res.statusCode === null, 'no response should be written on success')
}

async function testRequireScopedAuthSucceedsWithNoLocationScope() {
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify(await buildDirectory())
  const token = await tokenFor('usr_owner', 'owner', '*')
  const { req, res } = fakeReqRes(token)
  const result = await requireScopedAuth(req, res, {
    permission: Permission.VIEW_ALL,
    resolveLocationId: async () => null, // company-wide request, not location-scoped
  })
  assert(result !== null, 'a request with no specific location must succeed once permission is granted')
  assert(result.locationId === null, 'locationId passes through as null')
}

// requireScopedAuth's `permission` param accepts an array (ANY-of) as well
// as a single constant -- added for the unrestricted/_ASSIGNED permission
// pairs (owner/marketing hold REPLY, location_manager holds REPLY_ASSIGNED,
// both must reach the same endpoint).
async function testRequireScopedAuthAcceptsAnArrayOfPermissions() {
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify(await buildDirectory())

  const lmToken = await tokenFor('usr_lm', 'location_manager', [3, 7, 12])
  const { req: lmReq, res: lmRes } = fakeReqRes(lmToken)
  const lmResult = await requireScopedAuth(lmReq, lmRes, {
    permission: [Permission.REPLY, Permission.REPLY_ASSIGNED],
    resolveLocationId: async () => 7,
  })
  assert(lmResult !== null, 'location_manager (holds only REPLY_ASSIGNED) must pass an ANY-of [REPLY, REPLY_ASSIGNED] check')

  const roToken = await tokenFor('usr_ro', 'read_only', [7])
  const { req: roReq, res: roRes } = fakeReqRes(roToken)
  const roResult = await requireScopedAuth(roReq, roRes, {
    permission: [Permission.REPLY, Permission.REPLY_ASSIGNED],
    resolveLocationId: async () => 7,
  })
  assert(roResult === null && roRes.statusCode === 403, `read_only holds neither REPLY nor REPLY_ASSIGNED, expected 403, got ${roRes.statusCode}`)
}

// Phase 2 Milestone 2: static source checks confirming the new helpers
// remain unused by production code and requireAuth() itself is untouched.
async function testRequireAuthSourceUnchanged() {
  const authSrc = readFileSync(path.join(DASHBOARD_DIR, 'api', '_lib', 'auth.js'), 'utf-8')
  const fnMatch = authSrc.match(/export async function requireAuth\(req, res, allowedRoles\) \{[\s\S]*?\n\}/)
  assert(fnMatch, 'requireAuth function body must still be present and match the expected signature')
  const body = fnMatch[0]
  assert(body.includes(`res.status(403).json({ error: 'forbidden', message: 'You do not have permission to perform this action.' })`), 'requireAuth forbidden branch unchanged')
  assert(body.includes(`res.status(401).json({ error: 'session_expired', message: 'Your session is no longer valid. Please sign in again.' })`), 'requireAuth session_expired branch unchanged')
  assert(body.includes(`res.status(401).json({ error: 'unauthenticated', message: 'Sign in required.' })`), 'requireAuth unauthenticated branch unchanged')
}

// Phase 8, Milestone 8.3 is the first production endpoint to actually call
// requireScopedAuth (Restaurant Contacts' Manager-scoped single-location
// read/write) -- these helpers were built in Milestone 2 and sat unused
// until now. This test's job going forward is narrower than its original
// "used by nobody" assertion: confirm the helpers are used ONLY by the
// endpoint(s) that are supposed to use them, not accidentally picked up
// elsewhere.
const EXPECTED_SCOPED_AUTH_CALLERS = new Set([
  path.join(DASHBOARD_DIR, 'api', 'settings', '[action].js'),
  // Multi-Location Authentication & User Access System, Commit 4:
  // publish()/publishBridge() location-scope every per-review action.
  path.join(DASHBOARD_DIR, 'api', 'google', '[action].js'),
  path.join(DASHBOARD_DIR, 'api', 'actions', '[action].js'),
  path.join(DASHBOARD_DIR, 'api', 'rewrite.js'),
  path.join(DASHBOARD_DIR, 'api', 'data.js'), // calls requireLocationAccess directly, not requireScopedAuth
  // Notification Center Audit & Fix: calls requireLocationAccess directly
  // (per-review-and-per-notification-key checks), same pattern as data.js.
  path.join(DASHBOARD_DIR, 'api', 'notifications', '[action].js'),
])

async function testNewHelpersAreUsedOnlyByExpectedEndpoints() {
  const apiDir = path.join(DASHBOARD_DIR, 'api')
  const offenders = []

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '_lib') continue // the helpers' own home
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.js')) continue
      if (EXPECTED_SCOPED_AUTH_CALLERS.has(full)) continue
      const src = readFileSync(full, 'utf-8')
      if (/\brequireScopedAuth\b|\brequireOwnership\b|\brequireLocationAccess\b/.test(src)) {
        offenders.push(full)
      }
    }
  }
  walk(apiDir)
  assert(offenders.length === 0, `only ${[...EXPECTED_SCOPED_AUTH_CALLERS].join(', ')} may call these helpers so far, found unexpected use in: ${offenders.join(', ')}`)
}

async function main() {
  await run('Permission registry is frozen and contains exactly the expected constants', testPermissionRegistryIsFrozenAndComplete)
  await run('ROLE_PERMISSIONS is frozen and every role maps to a Set', testRolePermissionsIsFrozen)
  await run('roleHasPermission: every role x every permission matches the approved matrix', testRoleHasPermissionMatrix)
  await run('read_only has no export permission (distinct from location_manager)', testReadOnlyHasNoExportPermission)
  await run('roleHasPermission fails closed for unknown role/permission/undefined inputs', testRoleHasPermissionFailsClosedForUnknownInputs)
  await run('requireLocationAccess: wildcard locationIds grants any location', testWildcardLocationAccessGrantsAnyLocation)
  await run('requireLocationAccess: explicit array, positive cases', testExplicitArrayLocationAccessPositive)
  await run('requireLocationAccess: explicit array, negative cases', testExplicitArrayLocationAccessNegative)
  await run('requireOwnership mirrors requireLocationAccess (positive and negative)', testRequireOwnershipMatchesRequireLocationAccess)
  await run('requireScopedAuth: unauthenticated -> 401', testRequireScopedAuthUnauthenticated)
  await run('requireScopedAuth: permission denied -> 403 forbidden', testRequireScopedAuthPermissionDenied)
  await run('requireScopedAuth: location out of scope -> 404 not_found (never 403)', testRequireScopedAuthLocationOutOfScopeReturns404)
  await run('requireScopedAuth: in-scope location + granted permission -> succeeds', testRequireScopedAuthSucceedsInScope)
  await run('requireScopedAuth: no location scope (company-wide) -> succeeds', testRequireScopedAuthSucceedsWithNoLocationScope)
  await run('requireScopedAuth: permission param accepts an array (ANY-of)', testRequireScopedAuthAcceptsAnArrayOfPermissions)
  await run('requireAuth() source is byte-level unchanged from before Milestone 2', testRequireAuthSourceUnchanged)
  await run('requireScopedAuth/requireOwnership/requireLocationAccess are used only by the expected endpoint(s)', testNewHelpersAreUsedOnlyByExpectedEndpoints)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
