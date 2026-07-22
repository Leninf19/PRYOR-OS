// Regression tests for propagating the authenticated account down through
// the React tree (Action Center Accountability milestone). No React
// component-render test framework exists in this repo -- these are plain
// text/regex source-content assertions, the same style
// test_executive_intelligence_center_ui.js/test_provider_health_ui.js use.
//
// Run directly: node tests/test_account_context.js

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

function testAuthGateDefinesAccountContext() {
  const content = read('components/AuthGate.jsx')
  assert(/const AccountContext = createContext\(null\)/.test(content), 'AuthGate.jsx must define AccountContext')
  assert(/export function useAccount\(\)/.test(content), 'AuthGate.jsx must export a useAccount() hook')
}

function testAuthGateProvidesTheRealSessionAccount() {
  const content = read('components/AuthGate.jsx')
  assert(/const \{ status, account, login \} = useSession\(\)/.test(content),
    'AuthGate.jsx must destructure account (not just status/login) from useSession()')
  assert(/<AccountContext\.Provider value={account}>{children}<\/AccountContext\.Provider>/.test(content),
    'AuthGate.jsx must provide the real session account, not a placeholder, to children')
}

function testAuthGateStillGatesOnLoadingAndUnauthenticated() {
  const content = read('components/AuthGate.jsx')
  assert(/status === 'loading'/.test(content), 'the loading gate must be unchanged')
  assert(/status === 'unauthenticated'/.test(content), 'the unauthenticated gate must be unchanged')
  assert(/<Login onSuccess={login} \/>/.test(content), 'the login screen must still be rendered on unauthenticated, unchanged')
}

function testAppConsumesAccountAndAddsItToOutletContext() {
  const content = read('App.jsx')
  assert(/import { useAccount }\s+from '\.\/components\/AuthGate\.jsx'/.test(content),
    'App.jsx must import useAccount from AuthGate.jsx')
  assert(/const account = useAccount\(\)/.test(content), 'RootLayout must call useAccount()')
  assert(/<Outlet context={{ allReviews, filtered, prevFiltered, filters, account }} \/>/.test(content),
    'App.jsx must add account to the existing Outlet context object without removing any existing field')
}

function testUseSessionStillReturnsAccount() {
  const content = read('hooks/useSession.js')
  assert(/setState\({ status: 'authenticated', account: data\.account }\)/.test(content),
    'useSession must still populate account from GET /api/session/whoami on load')
  assert(/const login = useCallback\(\(account\) => {/.test(content),
    'useSession.login must still accept and store the account passed from Login.jsx')
}

const tests = [
  ['AuthGate.jsx defines AccountContext + useAccount', testAuthGateDefinesAccountContext],
  ['AuthGate.jsx provides the real session account, not a placeholder', testAuthGateProvidesTheRealSessionAccount],
  ['AuthGate.jsx still gates on loading/unauthenticated exactly as before', testAuthGateStillGatesOnLoadingAndUnauthenticated],
  ['App.jsx consumes useAccount() and adds account to the Outlet context additively', testAppConsumesAccountAndAddsItToOutletContext],
  ['useSession.js still returns/accepts the real account (regression)', testUseSessionStillReturnsAccount],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
