// Regression test for Phase 3 Milestone 6's useGlobalPrefetch() extension
// (Commit 3: prefetch the two data sources the Executive Intelligence
// Center's priority digest needs on first load, exactly like every other
// page's data already is).
//
// Run directly: node tests/test_executive_intelligence_prefetch.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONTENT_PATH = path.resolve(__dirname, '..', 'dashboard', 'src', 'hooks', 'useIntelligence.js')

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

function testGlobalPrefetchIncludesActionCenterAndOperationsImpact() {
  const content = readFileSync(CONTENT_PATH, 'utf-8')
  assert(/\['action-center',\s*'intelligence\/action-center\.json'\]/.test(content),
    'useGlobalPrefetch must prefetch action-center.json')
  assert(/\['operations-impact',\s*'intelligence\/operations-impact\.json'\]/.test(content),
    'useGlobalPrefetch must prefetch operations-impact.json')
}

function testGlobalPrefetchStillHasEveryPreviouslyExistingEntry() {
  const content = readFileSync(CONTENT_PATH, 'utf-8')
  const mustStillExist = [
    "['kpis',              'analytics/kpis.json']",
    "['monthly-trend',     'analytics/monthly-trend.json']",
    "['location-stats',    'analytics/location-stats.json']",
    "['rankings',          'analytics/rankings-30d.json']",
    "['complaint-intel',   'intelligence/complaint-intelligence.json']",
    "['department-performance', 'intelligence/department-performance.json']",
    "['company-summary',   'intelligence/company-summary.json']",
    "['predictive-alerts', 'intelligence/predictive-alerts.json']",
    "['response-drafts',   'intelligence/response-drafts.json']",
    "['competitor-intel',  'intelligence/competitive-intelligence.json']",
    "['action-items',      'action-items.json']",
    "['meta',              'meta.json']",
  ]
  mustStillExist.forEach(line => {
    assert(content.includes(line), `existing prefetch entry must be unchanged: ${line}`)
  })
}

function testQueryKeysMatchTheirCorrespondingHooks() {
  const content = readFileSync(CONTENT_PATH, 'utf-8')
  // useActionCenter()/useOperationsImpact() use queryKey 'action-center'/
  // 'operations-impact' -- the prefetch entries must use the identical
  // keys, or the prefetched cache entry would never be hit by the hook.
  assert(/export function useActionCenter\(\)\s*\{\s*return useQuery\(\{\s*queryKey:\s*\['action-center'\]/.test(content),
    "useActionCenter()'s queryKey must be 'action-center', matching the prefetch entry")
  assert(/export function useOperationsImpact\(\)\s*\{\s*return useQuery\(\{\s*queryKey:\s*\['operations-impact'\]/.test(content),
    "useOperationsImpact()'s queryKey must be 'operations-impact', matching the prefetch entry")
}

const tests = [
  ['useGlobalPrefetch includes action-center.json and operations-impact.json', testGlobalPrefetchIncludesActionCenterAndOperationsImpact],
  ['useGlobalPrefetch still has every previously-existing entry', testGlobalPrefetchStillHasEveryPreviouslyExistingEntry],
  ['the new prefetch query keys match their corresponding hooks exactly', testQueryKeysMatchTheirCorrespondingHooks],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
