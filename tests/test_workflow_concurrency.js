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

run('all 5 reviews.db-writing workflows share the reviews-db-writer concurrency group', testEachWriterHasSharedConcurrencyGroup)
run('no workflow retains the reset-and-recommit retry pattern', testNoResetAndRecommitAnywhere)
run('every writer runs the DB integrity check before its commit step', testEachWriterRunsIntegrityCheckBeforeCommit)
run('non-DB-writing workflows were left out of the concurrency group', testNonWriterWorkflowsUntouched)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
