// Regression tests for Settings -> Users & Access -- Multi-Location
// Authentication & User Access System, Commit 6. Source-text assertions,
// matching this repo's established convention for frontend logic (no React
// Testing Library/jsdom here) -- see test_restaurant_contacts_ui.js/
// test_audit_log_ui.js for the same pattern applied to sibling Settings
// sections.
//
// Run directly: node tests/test_users_access_ui.js

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

function src(relPath) {
  return readFileSync(path.join(SRC_DIR, relPath), 'utf-8')
}

function testRegisteredInSettingsSectionsForOwnerAndAdminOnly() {
  const s = src('pages/settings/settingsSections.js')
  assert(/id: 'users'/.test(s), 'settingsSections.js must register the users section')
  assert(/component: lazy\(\(\) => import\('\.\/UsersAccess\.jsx'\)\)/.test(s), 'must lazily import UsersAccess.jsx, matching every other section')
  const usersEntryMatch = s.match(/\{\s*id: 'users',[\s\S]*?\n\s*\},/)
  assert(usersEntryMatch, 'could not find the users section entry')
  assert(/requiredRoles: \['owner', 'admin'\]/.test(usersEntryMatch[0]), 'the Users & Access nav item must only be presented to owner/admin, matching USERS_MANAGE')
}

function testUsesTheRealServiceEndpointsNeverAdHocFetch() {
  const s = src('services/usersService.js')
  for (const action of ['users-list', 'invite-user', 'resend-invite', 'revoke-invite', 'generate-reset-link', 'update-user-role-locations', 'disable-user', 'enable-user']) {
    assert(s.includes(action), `usersService.js must call the real /api/settings/${action} endpoint`)
  }
  assert(/SESSION_EXPIRED_EVENT/.test(s), 'must dispatch the shared session-expiry event on 401, matching every other service file')
}

function testUsersListNeverExposesPasswordFields() {
  const backendSrc = readFileSync(path.join(__dirname, '..', 'dashboard', 'api', 'settings', '[action].js'), 'utf-8')
  const start = backendSrc.indexOf('async function usersListAction(')
  assert(start !== -1, 'could not find usersListAction')
  const fnSrc = backendSrc.slice(start, start + 1500)
  assert(!/passwordHash/.test(fnSrc), 'usersListAction must never include passwordHash in its response mapping')
}

function testDisableButtonIsDisabledForTheLastActiveOwner() {
  const s = src('pages/settings/UsersAccess.jsx')
  assert(/isLastActiveOwner/.test(s), 'the page must compute whether a given row is the last active Owner')
  assert(/disabled={isLastActiveOwner}/.test(s), 'the Disable button must be disabled client-side for the last active Owner (defense in depth -- the real enforcement is server-side assertNotLastActiveOwner)')
}

function testRoleSelectRestrictsOwnerOptionToActingOwners() {
  const s = src('pages/settings/UsersAccess.jsx')
  assert(/actingRole === 'owner' && <option value="owner">Owner<\/option>/.test(s), 'the Owner role option must only render in the select when the acting account is itself an Owner (defense in depth -- canAssignRole() is the real server-side enforcement)')
}

function testInviteFlowAlwaysShowsACopyableLink() {
  const s = src('pages/settings/UsersAccess.jsx')
  assert(/inviteResult\.inviteUrl/.test(s), 'the invite success view must display the raw invite link')
  assert(/navigator\.clipboard\?\.writeText\(inviteResult\.inviteUrl\)/.test(s), 'must offer a Copy Invitation Link action, independent of whether the email actually sent (Phase 16)')
}

function testNeverLogsOrDisplaysAPassword() {
  const s = src('pages/settings/UsersAccess.jsx')
  assert(!/console\.(log|error|warn)\([^)]*password/i.test(s), 'must never log a password to the console')
  assert(!/user\.password/i.test(s), 'must never reference a password field on a user record -- the owner/admin never sees it')
}

run('Users & Access is registered in settingsSections.js, owner/admin only', testRegisteredInSettingsSectionsForOwnerAndAdminOnly)
run('usersService.js calls every real backend action, uses the shared session-expiry pattern', testUsesTheRealServiceEndpointsNeverAdHocFetch)
run('users-list backend action never exposes passwordHash', testUsersListNeverExposesPasswordFields)
run('the Disable button is disabled client-side for the last active Owner', testDisableButtonIsDisabledForTheLastActiveOwner)
run('the Owner role option is only offered to an acting Owner', testRoleSelectRestrictsOwnerOptionToActingOwners)
run('the invite flow always shows a copyable link, independent of email delivery', testInviteFlowAlwaysShowsACopyableLink)
run('the page never logs or references a raw password', testNeverLogsOrDisplaysAPassword)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
