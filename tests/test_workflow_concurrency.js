// Static checks on the 5 GitHub Actions workflows that commit to
// dashboard/reviews.db: each must share the same concurrency group (so two
// writers can never run at once), and none may contain the old
// reset-and-recommit retry loop (which risked silently overwriting newer
// review data with an older run's copy -- the 2026-07-16 incident).
//
// Run directly: node tests/test_workflow_concurrency.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOWS_DIR = path.resolve(__dirname, '..', '.github', 'workflows')

const DB_WRITER_WORKFLOWS = [
  'update-reviews.yml',
  'critical-alert-check.yml',
  'nightly-digest.yml',
  'health-check.yml',
  'historical-import.yml',
]

const NON_WRITER_WORKFLOWS = ['weekly-report.yml', 'deploy-frontend.yml']

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

function testEachWriterHasSharedConcurrencyGroup() {
  for (const file of DB_WRITER_WORKFLOWS) {
    const content = readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8')
    assert(/group:\s*reviews-db-writer/.test(content), `${file} must declare concurrency group: reviews-db-writer`)
    assert(/cancel-in-progress:\s*false/.test(content), `${file} must set cancel-in-progress: false`)
  }
}

function testNoResetAndRecommitAnywhere() {
  for (const file of DB_WRITER_WORKFLOWS) {
    const content = readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8')
    assert(!content.includes('git reset --mixed'), `${file} must not contain the reset-and-recommit retry pattern`)
  }
}

function testEachWriterRunsIntegrityCheckBeforeCommit() {
  for (const file of DB_WRITER_WORKFLOWS) {
    const content = readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8')
    const checkIdx = content.indexOf('check_db_integrity.py')
    const commitIdx = content.indexOf('git commit')
    assert(checkIdx !== -1, `${file} must run check_db_integrity.py`)
    assert(checkIdx < commitIdx, `${file} must run the integrity check before committing`)
  }
}

function testNonWriterWorkflowsUntouched() {
  for (const file of NON_WRITER_WORKFLOWS) {
    const content = readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8')
    assert(!/group:\s*reviews-db-writer/.test(content), `${file} does not write reviews.db and must not join the concurrency group`)
  }
}

// deploy-frontend.yml must not assume some other workflow already populated
// analytics_cache before it runs export_chunks.py -- that hidden dependency
// silently broke export_chunks.py's location-analytics validation the first
// time a dashboard-only push landed on a commit whose db hadn't yet been
// through refresh_analytics.py (see the Phase 3 Milestone 2 root-cause
// investigation). It must independently refresh analytics first, without
// becoming a reviews.db writer itself (it never commits the db).
function testDeployFrontendRefreshesAnalyticsBeforeExport() {
  const content = readFileSync(path.join(WORKFLOWS_DIR, 'deploy-frontend.yml'), 'utf-8')
  // Match the actual `run:` invocation lines specifically, not any mention of
  // the script names (e.g. in an explanatory comment), so a maintainer's
  // prose referencing either script elsewhere in the file can't skew this.
  const refreshIdx = content.indexOf('run: python refresh_analytics.py')
  const exportIdx = content.indexOf('run: python export_chunks.py')
  assert(refreshIdx !== -1, 'deploy-frontend.yml must run refresh_analytics.py')
  assert(exportIdx !== -1, 'deploy-frontend.yml must still run export_chunks.py')
  assert(refreshIdx < exportIdx, 'deploy-frontend.yml must run refresh_analytics.py before export_chunks.py')

  // The ANTHROPIC_API_KEY env var must belong to the refresh step specifically,
  // not just appear anywhere in the file -- isolate the step's own YAML block
  // (from its "- name:" line up to the next "- name:"/"- uses:" line) and
  // check the key is declared inside it.
  const refreshStepMatch = content.match(/- name: Refresh analytics\n([\s\S]*?)(?=\n\s*- (?:name|uses):|\n*$)/)
  assert(refreshStepMatch, 'deploy-frontend.yml must have a named "Refresh analytics" step')
  assert(/ANTHROPIC_API_KEY:\s*\$\{\{\s*secrets\.ANTHROPIC_API_KEY\s*\}\}/.test(refreshStepMatch[1]),
    'the Refresh analytics step in deploy-frontend.yml must pass ANTHROPIC_API_KEY, matching update-reviews.yml')
}

function testDeployFrontendPreservesTriggerAndPathFilters() {
  const content = readFileSync(path.join(WORKFLOWS_DIR, 'deploy-frontend.yml'), 'utf-8')
  assert(/push:\s*\n\s*branches:\s*\[main\]/.test(content), 'deploy-frontend.yml must still trigger on push to main')
  assert(content.includes("'dashboard/**'"), 'deploy-frontend.yml must still be path-filtered to dashboard/**')
  assert(content.includes("'!dashboard/reviews.db'"), 'deploy-frontend.yml must still exclude dashboard/reviews.db from its path filter')
  assert(content.includes("'!dashboard/reviews.csv'"), 'deploy-frontend.yml must still exclude dashboard/reviews.csv from its path filter')
  assert(content.includes('workflow_dispatch:'), 'deploy-frontend.yml must still support manual dispatch')
}

function testUpdateReviewsStillPreservesFullPipelineOrder() {
  const content = readFileSync(path.join(WORKFLOWS_DIR, 'update-reviews.yml'), 'utf-8')
  const order = ['auto_update.py', 'refresh_analytics.py', 'export_chunks.py', 'check_db_integrity.py', 'git commit', 'vercel']
  const indices = order.map(marker => content.toLowerCase().indexOf(marker.toLowerCase()))
  indices.forEach((idx, i) => assert(idx !== -1, `update-reviews.yml must still contain "${order[i]}"`))
  for (let i = 1; i < indices.length; i++) {
    assert(indices[i - 1] < indices[i],
      `update-reviews.yml must preserve the order ${order[i - 1]} -> ${order[i]}, found at ${indices[i - 1]} and ${indices[i]}`)
  }
}

run('all 5 reviews.db-writing workflows share the reviews-db-writer concurrency group', testEachWriterHasSharedConcurrencyGroup)
run('no workflow retains the reset-and-recommit retry pattern', testNoResetAndRecommitAnywhere)
run('every writer runs the DB integrity check before its commit step', testEachWriterRunsIntegrityCheckBeforeCommit)
run('non-DB-writing workflows were left out of the concurrency group', testNonWriterWorkflowsUntouched)
run('deploy-frontend.yml refreshes analytics (with ANTHROPIC_API_KEY) before exporting data chunks', testDeployFrontendRefreshesAnalyticsBeforeExport)
run('deploy-frontend.yml preserves its existing trigger and path filters', testDeployFrontendPreservesTriggerAndPathFilters)
run('update-reviews.yml preserves scrape -> refresh -> export -> integrity -> commit -> deploy', testUpdateReviewsStillPreservesFullPipelineOrder)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
