// Regression tests for the /forgot-password and /reset-password public
// pages and their wiring into AuthGate.jsx -- Multi-Location Authentication
// & User Access System, Commit 3. Source-text assertions, same convention
// as test_accept_invite_ui.js.
//
// Run directly: node tests/test_password_reset_ui.js

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

function testAuthGateRoutesBothPublicPaths() {
  const src = readFileSync(path.join(SRC_DIR, 'components', 'AuthGate.jsx'), 'utf-8')
  assert(/'\/forgot-password':\s*ForgotPassword/.test(src), 'AuthGate.jsx must map /forgot-password to ForgotPassword')
  assert(/'\/reset-password':\s*ResetPassword/.test(src), 'AuthGate.jsx must map /reset-password to ResetPassword')
}

function testLoginHasAForgotPasswordLink() {
  const src = readFileSync(path.join(SRC_DIR, 'components', 'Login.jsx'), 'utf-8')
  assert(/href="\/forgot-password"/.test(src), 'Login.jsx must link to /forgot-password')
}

function testForgotPasswordNeverShowsADistinguishableResultForUnknownEmails() {
  const src = readFileSync(path.join(SRC_DIR, 'components', 'ForgotPassword.jsx'), 'utf-8')
  assert(/\/api\/session\/forgot-password/.test(src), 'must call the real forgot-password endpoint')
  // Exactly one "submitted" confirmation branch -- no separate success/
  // failure UI state that could leak whether the email exists.
  assert(!/setError\(/.test(src), 'ForgotPassword.jsx must not have a distinguishable error state -- the confirmation message must always be the same')
}

function testResetPasswordUsesTheRealEndpointsAndNeverLogsThePassword() {
  const src = readFileSync(path.join(SRC_DIR, 'components', 'ResetPassword.jsx'), 'utf-8')
  assert(/\/api\/session\/reset-status\?token=/.test(src), 'must call the non-consuming reset-status preview endpoint')
  assert(/\/api\/session\/reset-password/.test(src), 'must submit to the real reset-password endpoint')
  assert(!/console\.(log|error|warn)\([^)]*password/i.test(src), 'must never log the password to the console')
  assert(/window\.location\.href = '\/'/.test(src), 'a successful reset must do a full page navigation, matching AcceptInvite\'s pattern')
}

run('AuthGate.jsx routes /forgot-password and /reset-password to their public pages', testAuthGateRoutesBothPublicPaths)
run('Login.jsx links to /forgot-password', testLoginHasAForgotPasswordLink)
run('ForgotPassword.jsx never shows a distinguishable result for an unknown email', testForgotPasswordNeverShowsADistinguishableResultForUnknownEmails)
run('ResetPassword.jsx calls the real endpoints, never logs the password, and redirects on success', testResetPasswordUsesTheRealEndpointsAndNeverLogsThePassword)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
