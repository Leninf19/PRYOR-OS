// PRYOR OS login redesign (UI/UX pass only) -- regression test proving the
// visual rewrite of dashboard/src/components/Login.jsx did not change any
// authentication behavior: same endpoint, same request body shape, same
// success/failure contract, no invented fields (no "remember me" -- the
// backend has never accepted one), and the register/access-code
// affordances are plain navigation links (real routes as of Multi-Tenant
// Phase 4Q.1), never a fetch() fired directly from this screen.
//
// Google Sign-In (PRYOR login identity) update: this file's own frozen
// "no Google/OAuth login option" invariant was a deliberate CHOICE at the
// time, not a permanent architectural rule -- it recorded that GBP
// connection must never be confused with login, never that PRYOR could
// never offer its OWN separate "Continue with Google" identity option. Now
// that this feature exists, testGoogleLoginOptionIsPresentAndSafelyWired()
// below proves the opposite half of the SAME concern that motivated the
// original assertion: a real Google option is present, but it points at
// PRYOR's own login-identity endpoint (google-login-start), is a plain
// navigation (never a fetch/XHR), and NEVER touches
// google/[action].js's GBP auth()/callback() routes.
//
// Plain source-text regex assertions, matching this project's established
// convention for a file with no React render-test harness (see
// test_onboarding_ui.js).
//
// Run directly: node tests/test_login_ui_redesign.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONTENT_PATH = path.resolve(__dirname, '..', 'dashboard', 'src', 'components', 'Login.jsx')
const content = readFileSync(CONTENT_PATH, 'utf-8')

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

function testPostsToTheSameLoginEndpointWithOnlyEmailAndPassword() {
  assert(/fetch\('\/api\/session\/login'/.test(content), 'must still POST to /api/session/login')
  assert(/method:\s*'POST'/.test(content), 'must still use POST')
  assert(/JSON\.stringify\(\{\s*email,\s*password\s*\}\)/.test(content),
    'the request body must be exactly { email, password } -- no rememberMe or any other invented field')
}

function testNeverSendsARememberMeField() {
  // The word itself may appear in an explanatory comment (why it's
  // deliberately absent) -- what must never exist is an actual checkbox/
  // state/request-body field for it.
  assert(!/type="checkbox"/.test(content), 'no checkbox input of any kind -- there is nothing to remember-me a session with')
  assert(!/rememberMe/.test(content), 'no rememberMe state, prop, or request-body field anywhere')
}

function testCallsOnSuccessWithTheAccountOnlyOn200() {
  assert(/onSuccess\(data\.account\)/.test(content), 'must call onSuccess(data.account) on a successful login, unchanged')
  assert(/if \(!res\.ok\)/.test(content), 'must still branch on res.ok exactly as before')
}

function testPreservesTheThreeRealServerMessagePaths() {
  assert(/data\.message \|\| 'Invalid email or password\.'/.test(content),
    'non-ok responses must still fall back to the exact same generic message the server itself uses')
  assert(/'Could not reach the server\. Please try again\.'/.test(content),
    'the network-failure catch branch message must be unchanged')
}

function testForgotPasswordLinkUnchanged() {
  assert(/href="\/forgot-password"/.test(content), 'the Forgot password link must still point to /forgot-password')
}

function testGoogleLoginOptionIsPresentAndSafelyWired() {
  assert(/GoogleButton/.test(content), 'must render the shared GoogleButton "Continue with Google" affordance')
  assert(/\/api\/session\/google-login-start/.test(content), 'the Google option must navigate to PRYOR\'s own login-identity endpoint')
  // Never the GBP connection endpoint -- the two OAuth systems must never
  // be wireable from the same control.
  assert(!/\/api\/google\/auth/.test(content), 'must never point the login Google button at the GBP connect endpoint')
  assert(!/GOOGLE_CLIENT_ID|business\.manage/.test(content), 'must never reference the GBP OAuth client or its scope')
}

function testPasswordVisibilityToggleExists() {
  assert(/showPassword/.test(content), 'must support a password show/hide control')
  assert(/type=\{showPassword \? 'text' : 'password'\}/.test(content), 'the password input type must toggle between text and password')
}

function testRegisterAndAccessCodeLinksAreRealNavigationNotFetchCalls() {
  // Multi-Tenant Phase 4Q.1: /register and /access-code are now real,
  // public routes (see AuthGate.jsx's PUBLIC_PATHS) -- these must be plain
  // navigation links, exactly like the existing Forgot password link,
  // never a fetch() call fired directly from the login screen itself (all
  // real registration/redemption logic lives in the new page components).
  assert(/Create an account/.test(content) && /Enter code/.test(content),
    'both the "create an account" and "access code" affordances must be present')
  assert(/href="\/register"/.test(content), 'the "create an account" affordance must link to the real /register route')
  assert(/href="\/access-code"/.test(content), 'the "access code" affordance must link to the real /access-code route')
  assert(!/fetch\(['"`]\/api\/(session\/)?(register|signup|redeem-access-code)/i.test(content),
    'the login screen itself must never fire a register/redeem network call directly -- that logic belongs to the dedicated pages')
}

function testStillUsesTheCorrectAutocompleteHints() {
  assert(/autoComplete="username"/.test(content), 'email field must keep autoComplete="username"')
  assert(/autoComplete="current-password"/.test(content), 'password field must keep autoComplete="current-password"')
}

const tests = [
  ['still POSTs to /api/session/login with only { email, password }', testPostsToTheSameLoginEndpointWithOnlyEmailAndPassword],
  ['never sends a "remember me" field', testNeverSendsARememberMeField],
  ['still calls onSuccess(data.account) only on a 200', testCallsOnSuccessWithTheAccountOnlyOn200],
  ['preserves the three real server-message fallback paths', testPreservesTheThreeRealServerMessagePaths],
  ['Forgot password link is unchanged', testForgotPasswordLinkUnchanged],
  ['Google login option is present and safely wired', testGoogleLoginOptionIsPresentAndSafelyWired],
  ['password show/hide toggle exists', testPasswordVisibilityToggleExists],
  ['register/access-code links are real navigation, not fetch calls', testRegisterAndAccessCodeLinksAreRealNavigationNotFetchCalls],
  ['autocomplete hints are unchanged', testStillUsesTheCorrectAutocompleteHints],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
