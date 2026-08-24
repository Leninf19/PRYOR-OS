// Regression tests for the /accept-invite public page and its wiring into
// AuthGate.jsx -- Multi-Location Authentication & User Access System,
// Commit 2. Source-text assertions only, matching this repo's established
// convention for frontend logic (no React Testing Library/jsdom here) --
// see test_account_context.js/test_review_email_workflow_frontend.js for
// the same pattern.
//
// Run directly: node tests/test_accept_invite_ui.js

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

function testAuthGateBypassesLoginForAcceptInvitePath() {
  const src = readFileSync(path.join(SRC_DIR, 'components', 'AuthGate.jsx'), 'utf-8')
  assert(/import AcceptInvite from '\.\/AcceptInvite\.jsx'/.test(src), 'AuthGate.jsx must import AcceptInvite')
  assert(/'\/accept-invite':\s*AcceptInvite/.test(src), 'AuthGate.jsx must map /accept-invite to AcceptInvite in its public-path table')
  // The public-path check must happen BEFORE the loading/unauthenticated
  // gates -- an invitee has no session and must never be routed through
  // the Login screen, even momentarily.
  const publicCheckIdx = src.indexOf('PUBLIC_PATHS[location.pathname]')
  const loadingGateIdx = src.indexOf("status === 'loading'")
  assert(publicCheckIdx !== -1 && loadingGateIdx !== -1 && publicCheckIdx < loadingGateIdx,
    'the public-path check must run before the loading/unauthenticated gates')
}

function testAuthGateStillRendersRealChildrenWhenAuthenticated() {
  const src = readFileSync(path.join(SRC_DIR, 'components', 'AuthGate.jsx'), 'utf-8')
  assert(/<AccountContext\.Provider value={account}>{children}<\/AccountContext\.Provider>/.test(src),
    'the normal authenticated path (children under AccountContext) must be unchanged')
}

function testAcceptInviteUsesTheRealEndpointsAndNeverLogsThePassword() {
  const src = readFileSync(path.join(SRC_DIR, 'components', 'AcceptInvite.jsx'), 'utf-8')
  assert(/\/api\/session\/invite-status\?token=/.test(src), 'must call the non-consuming invite-status preview endpoint')
  assert(/\/api\/session\/accept-invite/.test(src), 'must submit to the real accept-invite endpoint')
  assert(!/console\.(log|error|warn)\([^)]*password/i.test(src), 'must never log the password to the console')
  assert(/MIN_PASSWORD_LENGTH = 10/.test(src), 'the client-side minimum length must match password.js\'s MIN_PASSWORD_LENGTH (10) -- keep these in sync if either changes')
}

function testAcceptInviteRedirectsFullPageOnSuccessRatherThanClientRouting() {
  const src = readFileSync(path.join(SRC_DIR, 'components', 'AcceptInvite.jsx'), 'utf-8')
  // Full navigation (window.location.href), not a client-side route change --
  // AuthGate's normal whoami-based flow must re-run from scratch to pick up
  // the fresh session cookie, matching LogoutButton.jsx's own established
  // full-reload-after-auth-change pattern.
  assert(/window\.location\.href = '\/'/.test(src), 'a successful accept-invite must do a full page navigation, not a client-side route change')
}

function testMinPasswordLengthMatchesServer() {
  const clientSrc = readFileSync(path.join(SRC_DIR, 'components', 'AcceptInvite.jsx'), 'utf-8')
  const serverSrc = readFileSync(path.join(__dirname, '..', 'dashboard', 'api', '_lib', 'password.js'), 'utf-8')
  const clientMatch = clientSrc.match(/MIN_PASSWORD_LENGTH = (\d+)/)
  const serverMatch = serverSrc.match(/MIN_PASSWORD_LENGTH = (\d+)/)
  assert(clientMatch && serverMatch, 'both files must define MIN_PASSWORD_LENGTH')
  assert(clientMatch[1] === serverMatch[1], `client (${clientMatch[1]}) and server (${serverMatch[1]}) MIN_PASSWORD_LENGTH must match -- the client-side hint is only a UX convenience, the server is authoritative, but a mismatch would be confusing`)
}

run('AuthGate.jsx routes /accept-invite to AcceptInvite BEFORE the login gate', testAuthGateBypassesLoginForAcceptInvitePath)
run('AuthGate.jsx still renders real authenticated children unchanged', testAuthGateStillRendersRealChildrenWhenAuthenticated)
run('AcceptInvite.jsx calls the real invite-status/accept-invite endpoints and never logs the password', testAcceptInviteUsesTheRealEndpointsAndNeverLogsThePassword)
run('a successful accept-invite does a full page navigation, not client-side routing', testAcceptInviteRedirectsFullPageOnSuccessRatherThanClientRouting)
run('client-side MIN_PASSWORD_LENGTH matches password.js', testMinPasswordLengthMatchesServer)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
