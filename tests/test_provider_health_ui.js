// Regression tests for Phase 3 Milestone 5 (Provider Health Center)'s tab
// wiring and presentational component. See test_provider_health_hook.js for
// the hook's own coverage. No React component-render test framework exists
// in this repo (confirmed: no other page/hook has one) -- these are plain-
// text/regex source-content assertions, the same style
// test_workflow_concurrency.js already uses for YAML, applied here instead.
//
// Run directly: node tests/test_provider_health_ui.js

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

function testScraperStatusStillHasBothExistingTabs() {
  const content = read('pages/ScraperStatus.jsx')
  assert(/id:\s*'runs'/.test(content), "the existing 'runs' subtab must still be present")
  assert(/id:\s*'validation'/.test(content), "the existing 'validation' subtab must still be present")
  assert(/tab === 'runs'\s*&&\s*<ScraperRuns/.test(content), "the 'runs' tab must still render <ScraperRuns />")
  assert(/tab === 'validation'\s*&&\s*<DataValidation/.test(content), "the 'validation' tab must still render <DataValidation />")
}

function testScraperStatusAddsHealthTabAdditively() {
  const content = read('pages/ScraperStatus.jsx')
  assert(/id:\s*'health'/.test(content), "a new 'health' subtab entry must be present")
  assert(/tab === 'health'\s*&&\s*<ProviderHealth/.test(content), "the 'health' tab must render <ProviderHealth />")
  assert(/import ProviderHealth from ['"]\.\/ProviderHealth\.jsx['"]/.test(content),
    'ScraperStatus.jsx must import the new ProviderHealth component')
}

function testProviderHealthComponentHandlesAllRequiredStates() {
  const content = read('pages/ProviderHealth.jsx')
  assert(/isLoading/.test(content), 'ProviderHealth.jsx must handle a loading state')
  assert(/isError/.test(content), 'ProviderHealth.jsx must handle an error state')
  assert(/entries\.length === 0/.test(content), 'ProviderHealth.jsx must handle an empty state')
  assert(/useProviderHealth\(\)/.test(content), 'ProviderHealth.jsx must consume the new hook, not compute health itself')
}

function testProviderHealthNeverComputesHealthClientSide() {
  const content = read('pages/ProviderHealth.jsx')
  // Guards against a future edit accidentally re-deriving state from
  // scraper_runs-shaped fields instead of just rendering the exported
  // `state`/`reason` -- this component must only ever read health.state
  // and health.reason from the payload, not compute a verdict itself.
  assert(!/locations_attempted|locations_failed|started_at/.test(content),
    'ProviderHealth.jsx must not reference raw scraper_runs fields -- it renders provider-health.json as-is')
}

run('ScraperStatus.jsx still renders both pre-existing subtabs unchanged', testScraperStatusStillHasBothExistingTabs)
run('ScraperStatus.jsx adds the Provider Health tab additively', testScraperStatusAddsHealthTabAdditively)
run('ProviderHealth.jsx handles loading/error/empty states and consumes the hook', testProviderHealthComponentHandlesAllRequiredStates)
run('ProviderHealth.jsx never computes health client-side', testProviderHealthNeverComputesHealthClientSide)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
