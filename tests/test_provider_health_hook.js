// Regression test for Phase 3 Milestone 5's useProviderHealth.js hook.
// No React hook-render test framework exists in this repo -- this is a
// plain-text source-content assertion, mirroring how useScraperStatus.js
// (the hook this one deliberately copies) would be checked the same way.
//
// Run directly: node tests/test_provider_health_hook.js

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

function testHookFetchesTheCorrectFile() {
  const content = readFileSync(path.join(SRC_DIR, 'hooks', 'useProviderHealth.js'), 'utf-8')
  assert(/fetchJSON\(\s*['"]provider-health\.json['"]\s*\)/.test(content),
    'useProviderHealth.js must fetch provider-health.json via the shared fetchJSON() helper')
  assert(/queryKey:\s*\[\s*['"]provider-health['"]\s*\]/.test(content),
    'useProviderHealth.js must use a distinct React Query key')
  assert(/from ['"]\.\.\/lib\/dataClient\.js['"]/.test(content),
    'useProviderHealth.js must reuse dataClient.js like every other hook, not a bespoke fetch()')
}

run("useProviderHealth.js fetches provider-health.json via the shared client", testHookFetchesTheCorrectFile)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
