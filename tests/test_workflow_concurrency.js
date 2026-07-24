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

// Normalize CRLF so \n-anchored regexes below match regardless of the
// checkout's line-ending style (Windows checkouts with core.autocrlf=true
// can rewrite these files to CRLF on any git-triggered checkout, e.g. a
// rebase -- matching every other source-content test in this suite).
function read(file) {
  return readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8').replace(/\r\n/g, '\n')
}

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
    const content = read(file)
    assert(/group:\s*reviews-db-writer/.test(content), `${file} must declare concurrency group: reviews-db-writer`)
    assert(/cancel-in-progress:\s*false/.test(content), `${file} must set cancel-in-progress: false`)
  }
}

function testNoResetAndRecommitAnywhere() {
  for (const file of DB_WRITER_WORKFLOWS) {
    const content = read(file)
    assert(!content.includes('git reset --mixed'), `${file} must not contain the reset-and-recommit retry pattern`)
  }
}

function testEachWriterRunsIntegrityCheckBeforeCommit() {
  for (const file of DB_WRITER_WORKFLOWS) {
    const content = read(file)
    const checkIdx = content.indexOf('check_db_integrity.py')
    // The actual `git commit` now lives inside the shared
    // .github/scripts/commit_and_push.sh helper (see
    // testAllWritersDelegateToSharedCommitScript below) -- every workflow's
    // own commit STEP still invokes it by name, which is the marker to look
    // for here now.
    const commitIdx = content.indexOf('commit_and_push.sh')
    assert(checkIdx !== -1, `${file} must run check_db_integrity.py`)
    assert(commitIdx !== -1, `${file} must invoke the shared commit_and_push.sh script`)
    assert(checkIdx < commitIdx, `${file} must run the integrity check before committing`)
  }
}

// Concurrency-safety audit (production incident: a critical-alert-check.yml
// run's git push was rejected -- "main -> main (fetch first)" -- after main
// advanced during the run). Every reviews.db-writing workflow's commit step
// now delegates to ONE shared, tested script rather than duplicating the
// git commit/push/retry logic five times -- exactly the kind of
// per-workflow drift that already caused the missing-cryptography-dependency
// incident earlier in this project's history.
function testAllWritersDelegateToSharedCommitScript() {
  for (const file of DB_WRITER_WORKFLOWS) {
    const content = read(file)
    assert(/bash \.github\/scripts\/commit_and_push\.sh/.test(content),
      `${file} must delegate its commit/push step to the shared .github/scripts/commit_and_push.sh script`)
    // The retry/rebase/conflict-safety logic must live in exactly one
    // place -- no workflow may re-inline its own git push/retry loop.
    assert(!/git push\s*\n/.test(content) && !content.includes('if ! git push'),
      `${file} must not re-inline its own git push logic -- it should delegate to the shared script instead`)
  }
}

function testSharedCommitScriptIsConcurrencySafe() {
  const script = readFileSync(path.join(__dirname, '..', '.github', 'scripts', 'commit_and_push.sh'), 'utf-8').replace(/\r\n/g, '\n')

  assert(/git fetch origin main/.test(script), 'the shared script must fetch origin/main on a rejected push')
  assert(/git rebase origin\/main/.test(script), 'the shared script must rebase onto the latest main on a rejected push')
  assert(/git push/.test(script), 'the shared script must retry the push')

  // The one property that must never regress: a genuine conflict (both this
  // run and a concurrent commit touching the same file) must never be
  // auto-resolved by picking a side -- that risks silently discarding review
  // data, which is exactly the 2026-07-16 incident this project already
  // suffered. It must abort and fail loudly instead.
  assert(/git rebase --abort/.test(script), 'a genuine rebase conflict must abort the rebase, never auto-resolve it')
  assert(!/git reset --hard origin/.test(script) && !/git reset --mixed/.test(script),
    'the script must never blindly reset onto the remote and recommit -- that is the exact pattern that caused the 2026-07-16 data-loss incident')
  assert(!/git push (--force|-f)\b/.test(script), 'the script must never force-push')

  // "No changes remain after rebasing" must be treated as success, not a
  // reason to keep retrying or to fail.
  assert(/git log origin\/main\.\.HEAD/.test(script), 'the script must check whether anything is actually left to push after rebasing')
}

function testNonWriterWorkflowsUntouched() {
  for (const file of NON_WRITER_WORKFLOWS) {
    const content = read(file)
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
  const content = read('deploy-frontend.yml')
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
  const content = read('deploy-frontend.yml')
  assert(/push:\s*\n\s*branches:\s*\[main\]/.test(content), 'deploy-frontend.yml must still trigger on push to main')
  assert(content.includes("'dashboard/**'"), 'deploy-frontend.yml must still be path-filtered to dashboard/**')
  assert(content.includes("'!dashboard/reviews.db'"), 'deploy-frontend.yml must still exclude dashboard/reviews.db from its path filter')
  assert(content.includes("'!dashboard/reviews.csv'"), 'deploy-frontend.yml must still exclude dashboard/reviews.csv from its path filter')
  assert(content.includes('workflow_dispatch:'), 'deploy-frontend.yml must still support manual dispatch')
}

function testUpdateReviewsStillPreservesFullPipelineOrder() {
  // Phase 3 Milestone 4b: the sync step's own command changed from
  // `auto_update.py` to `sync_reviews.py` (see testUpdateReviewsUsesGenericSyncEntrypoint
  // below for the explicit, dedicated assertions on that) -- this ordering
  // check is updated to use the new marker so it keeps proving the *rest*
  // of the pipeline's order is untouched, not weakened.
  const content = read('update-reviews.yml')
  const order = ['sync_reviews.py', 'refresh_analytics.py', 'export_chunks.py', 'check_db_integrity.py', 'commit_and_push.sh', 'vercel']
  const indices = order.map(marker => content.toLowerCase().indexOf(marker.toLowerCase()))
  indices.forEach((idx, i) => assert(idx !== -1, `update-reviews.yml must still contain "${order[i]}"`))
  for (let i = 1; i < indices.length; i++) {
    assert(indices[i - 1] < indices[i],
      `update-reviews.yml must preserve the order ${order[i - 1]} -> ${order[i]}, found at ${indices[i - 1]} and ${indices[i]}`)
  }
}

// Phase 3 Milestone 4b: update-reviews.yml now routes through the generic,
// provider-agnostic sync_reviews.py entrypoint (with REVIEW_PROVIDER=scraper,
// preserving today's exact active provider) instead of calling
// auto_update.py directly -- see the Milestone 4b design review. This is a
// deliberately narrow, isolated migration: only the one step's command/env
// changed; everything else (id, timeout, downstream output references,
// concurrency, commit fail-safe, deployment gating) must be provably
// untouched.
function testUpdateReviewsUsesGenericSyncEntrypoint() {
  const content = read('update-reviews.yml')

  assert(content.includes('run: python sync_reviews.py'),
    'update-reviews.yml must invoke python sync_reviews.py')
  assert(!content.includes('python auto_update.py'),
    'update-reviews.yml must no longer invoke auto_update.py directly')

  // Isolate the sync step's own YAML block (from its "- name:" line up to
  // the next "- name:"/"- uses:" line) so REVIEW_PROVIDER/id/timeout checks
  // are scoped to that step specifically, not just anywhere in the file.
  const syncStepMatch = content.match(/- name: Sync reviews \(scraper provider\)\n([\s\S]*?)(?=\n\s*- (?:name|uses):|\n*$)/)
  assert(syncStepMatch, 'update-reviews.yml must have a named "Sync reviews (scraper provider)" step')
  const syncStep = syncStepMatch[1]

  assert(/id:\s*scrape/.test(syncStep), 'the sync step must retain id: scrape')
  assert(/timeout-minutes:\s*30/.test(syncStep), 'the sync step must retain its 30-minute timeout')
  assert(/REVIEW_PROVIDER:\s*scraper/.test(syncStep),
    'the sync step must explicitly set REVIEW_PROVIDER: scraper')
  assert(/ANTHROPIC_API_KEY:\s*\$\{\{\s*secrets\.ANTHROPIC_API_KEY\s*\}\}/.test(syncStep),
    'the sync step must retain ANTHROPIC_API_KEY')
  assert(/PYTHONUNBUFFERED:\s*"1"/.test(syncStep), 'the sync step must retain PYTHONUNBUFFERED')
}

function testDownstreamScrapeOutputReferencesUnchanged() {
  const content = read('update-reviews.yml')
  assert(content.includes('steps.scrape.outputs.new_count'),
    'the commit step must still reference steps.scrape.outputs.new_count')
  assert(content.includes('steps.scrape.outputs.negative_count'),
    'the email-gate condition must still reference steps.scrape.outputs.negative_count')
  assert(content.includes('steps.scrape.outputs.email_html'),
    'the email body must still reference steps.scrape.outputs.email_html')
}

function testCommitStepStillGatedOnIntegritySuccess() {
  const content = read('update-reviews.yml')
  const commitStepMatch = content.match(/- name: Commit updated data\n([\s\S]*?)(?=\n\s*- name:)/)
  assert(commitStepMatch, 'update-reviews.yml must have a "Commit updated data" step')
  assert(/if:\s*always\(\)\s*&&\s*steps\.integrity\.outcome == 'success'/.test(commitStepMatch[0]),
    "the commit step must still run only when steps.integrity.outcome == 'success'")
}

// The original fail-safe (fail loudly, never auto-resolve a rejected push)
// used to live inline in update-reviews.yml as a one-off error string. It has
// been deliberately superseded: rather than just failing loudly, the commit
// step now fetches + rebases + retries automatically, and ONLY fails loudly
// when a genuine same-file conflict remains (see testSharedCommitScriptIsConcurrencySafe,
// which pins that guarantee against the shared script itself). This test
// proves the migration is complete on the workflow side: update-reviews.yml
// must delegate to the shared script rather than re-inlining its own
// (now-superseded, and easy to accidentally resurrect) ad hoc fail-safe text.
function testStalePushFailSafeMigratedToSharedScript() {
  const content = read('update-reviews.yml')
  assert(/bash \.github\/scripts\/commit_and_push\.sh/.test(content),
    'update-reviews.yml must delegate its commit/push step to the shared, concurrency-safe commit_and_push.sh script')
  assert(!content.includes('git reset --mixed'),
    'update-reviews.yml must not have regressed to the old reset-and-recommit pattern')
  assert(!content.includes('git push (--force|-f)'),
    'update-reviews.yml must not re-inline a force-push')
}

run('all 5 reviews.db-writing workflows share the reviews-db-writer concurrency group', testEachWriterHasSharedConcurrencyGroup)
run('no workflow retains the reset-and-recommit retry pattern', testNoResetAndRecommitAnywhere)
run('every writer runs the DB integrity check before its commit step', testEachWriterRunsIntegrityCheckBeforeCommit)
run('every writer delegates to the shared commit_and_push.sh script instead of re-inlining git push logic', testAllWritersDelegateToSharedCommitScript)
run('the shared commit_and_push.sh script fetches/rebases/retries but never auto-resolves a genuine conflict', testSharedCommitScriptIsConcurrencySafe)
run('non-DB-writing workflows were left out of the concurrency group', testNonWriterWorkflowsUntouched)
run('deploy-frontend.yml refreshes analytics (with ANTHROPIC_API_KEY) before exporting data chunks', testDeployFrontendRefreshesAnalyticsBeforeExport)
run('deploy-frontend.yml preserves its existing trigger and path filters', testDeployFrontendPreservesTriggerAndPathFilters)
run('update-reviews.yml preserves sync -> refresh -> export -> integrity -> commit -> deploy', testUpdateReviewsStillPreservesFullPipelineOrder)
run('update-reviews.yml routes through sync_reviews.py with REVIEW_PROVIDER=scraper, id/timeout/env retained, auto_update.py no longer invoked directly', testUpdateReviewsUsesGenericSyncEntrypoint)
run('downstream steps.scrape.outputs.* references are unchanged', testDownstreamScrapeOutputReferencesUnchanged)
run('the commit step still runs only when integrity succeeds', testCommitStepStillGatedOnIntegritySuccess)
run('the stale-push fail-safe has migrated to the shared concurrency-safe script', testStalePushFailSafeMigratedToSharedScript)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
