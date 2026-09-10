// PRYOR OS Vercel Serverless Function Count Reduction -- a static
// deployment-budget guard. Vercel Hobby rejects a deployment outright
// ("No more than 12 Serverless Functions can be added to a Deployment on
// the Hobby plan") once dashboard/api/** produces more than 12 routable
// functions -- this happened for real on main at commit 6d876e863 (13
// functions: every top-level api/**/*.js file whose path has no "_lib"
// segment and which has a top-level `export default`, per Vercel's
// file-system routing convention for a non-Next.js "Other" framework
// project -- the exact same discovery rule tests/test_authorization_matrix.js's
// SECTION 6 scanner already uses and cross-checks against ENDPOINT_REGISTRY).
//
// This file exists so a FUTURE new top-level api/ route silently pushing
// the count back over budget fails a fast, local, no-network test instead
// of only being discovered by a failed Vercel deployment. HOBBY_LIMIT (12)
// and TARGET_MAX (10) are both explicit, named constants -- not guesses:
// 12 is Vercel's own documented Hobby-plan ceiling; 10 is this phase's own
// "prefer leaving headroom" target (2 functions of margin below the hard
// limit) recorded so a reviewer adding routes later knows there is
// intentional slack, not an arbitrary near-miss.
//
// Middleware (dashboard/middleware.js) is DELIBERATELY excluded from this
// count -- Vercel Edge Middleware is a distinct product from Serverless
// Functions, validated and billed separately; it is not affected by, and
// does not count toward, the Hobby plan's 12-Serverless-Function ceiling
// this test guards. (Empirically: the Preview deployment that hit this
// exact "12 Serverless Functions" error was a LATER deployment than the
// one that failed on middleware's Edge/crypto packaging -- two separate,
// sequential Vercel validation failures, not one combined count.)
//
// Run directly: node tests/test_vercel_function_budget.js

import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const API_DIR = path.resolve(__dirname, '..', 'dashboard', 'api')

const HOBBY_LIMIT = 12
const TARGET_MAX = 10

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

// Byte-for-byte the same discovery rule as
// tests/test_authorization_matrix.js's SECTION 6 scanner -- deliberately
// duplicated rather than imported (this file is meant to work as a
// completely standalone, single-purpose budget check; it does not depend
// on that file's ENDPOINT_REGISTRY or any other of its many fixtures).
function discoverEndpointFiles(dir, base = dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '_lib') continue
      found.push(...discoverEndpointFiles(full, base))
      continue
    }
    if (!entry.name.endsWith('.js')) continue
    const relPath = path.relative(base, full).split(path.sep).join('/')
    if (relPath.split('/').includes('_lib')) continue
    const source = readFileSync(full, 'utf-8')
    if (!/^export default /m.test(source)) continue
    found.push(relPath)
  }
  return found
}

function testFunctionCountWithinHobbyLimit() {
  const files = discoverEndpointFiles(API_DIR)
  assert(
    files.length <= HOBBY_LIMIT,
    `dashboard/api/** produces ${files.length} Serverless Function(s), exceeding Vercel Hobby's ${HOBBY_LIMIT}-function ceiling -- ` +
    `Vercel will reject every deployment until this is consolidated back down. Files: ${files.sort().join(', ')}`
  )
}

function testFunctionCountHasHeadroom() {
  const files = discoverEndpointFiles(API_DIR)
  assert(
    files.length <= TARGET_MAX,
    `dashboard/api/** produces ${files.length} Serverless Function(s) -- still deployable (<= ${HOBBY_LIMIT}), but above this phase's ` +
    `${TARGET_MAX}-function headroom target. Not a hard failure, but a signal to consider consolidating before the next new route ` +
    `pushes this over the Hobby ${HOBBY_LIMIT}-function ceiling. Files: ${files.sort().join(', ')}`
  )
}

function testNoOrphanedStandaloneRewriteOrTenantRoutes() {
  // Regression guard specifically for the three routes this phase merged
  // away -- if any of them reappears as its own standalone file (e.g. a
  // future revert, or someone re-adding rewrite.js "for convenience"), the
  // function count silently creeps back toward the Hobby ceiling. Checked
  // by exact path, not a broad pattern, so it never false-positives on an
  // unrelated future file.
  const files = new Set(discoverEndpointFiles(API_DIR))
  for (const orphan of ['rewrite.js', 'tenant-ops/[action].js', 'tenant-entitlements/[action].js']) {
    assert(!files.has(orphan), `${orphan} must not exist as its own standalone route -- it was merged into an existing router to stay under the Hobby function ceiling (see PRYOR OS Vercel Serverless Function Count Reduction)`)
  }
}

run(`Serverless Function count stays at or under Vercel Hobby's ${HOBBY_LIMIT}-function ceiling`, testFunctionCountWithinHobbyLimit)
run(`Serverless Function count stays at or under this phase's ${TARGET_MAX}-function headroom target`, testFunctionCountHasHeadroom)
run('the three merged-away routes have not silently reappeared as standalone functions', testNoOrphanedStandaloneRewriteOrTenantRoutes)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
