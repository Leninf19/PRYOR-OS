// Multi-Tenant Phase 4P -- regression test proving
// dashboard/src/hooks/useIntelligence.js's per-location detail prefetch
// hooks consume the canonical, collision-safe slug the backend already
// computed (db.canonical_location_slugs(), exposed via location-stats.json/
// meta.json's own "slug" field) rather than re-deriving one from `name`
// independently. Two locations that legitimately share a display name get
// DISTINCT slugs server-side (disambiguated by locationId) -- a frontend
// that re-slugifies `name` on its own would silently collide them back
// onto the same intelligence/locations/*.json file, exactly the bug this
// phase fixes.
//
// Plain source-text regex assertions, matching this project's established
// convention for files with no React render-test harness (see
// test_executive_intelligence_prefetch.js).
//
// Run directly: node tests/test_intelligence_canonical_slug.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONTENT_PATH = path.resolve(__dirname, '..', 'dashboard', 'src', 'hooks', 'useIntelligence.js')
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

function extractFunctionBody(fnName) {
  const match = new RegExp(`function ${fnName}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(content)
  assert(match, `sanity: could not locate function ${fnName}() -- update this test if it was renamed`)
  return match[0]
}

function testUsePrefetchLocationDetailsConsumesCanonicalSlug() {
  const body = extractFunctionBody('usePrefetchLocationDetails')
  assert(/const slug = loc\.slug\b/.test(body),
    'usePrefetchLocationDetails() must read the canonical slug field (loc.slug), not re-derive one')
  assert(!/loc\.name\.toLowerCase\(\)/.test(body),
    'usePrefetchLocationDetails() must never re-derive a slug from loc.name independently')
}

function testUseAllLocationDetailsConsumesCanonicalSlug() {
  const body = extractFunctionBody('useAllLocationDetails')
  assert(/\.map\(s => s\.slug\)/.test(body),
    'useAllLocationDetails() must read the canonical slug field (s.slug) off each stat entry, not re-derive one')
  assert(!/s\.name\.toLowerCase\(\)/.test(body),
    'useAllLocationDetails() must never re-derive a slug from s.name independently')
}

function testNoRemainingIndependentSlugifyLogicInThisFile() {
  // The naive inline pattern this phase removed -- must not reappear
  // anywhere in the file (not just the two functions above), since any
  // reintroduction would silently reopen the same collision bug.
  assert(!/\.toLowerCase\(\)\.replace\(\/\[\^a-z0-9\]/.test(content),
    'no inline slugify-from-name regex may exist anywhere in useIntelligence.js -- the canonical slug always comes from exported metadata')
}

const tests = [
  ['usePrefetchLocationDetails() consumes the canonical slug field', testUsePrefetchLocationDetailsConsumesCanonicalSlug],
  ['useAllLocationDetails() consumes the canonical slug field', testUseAllLocationDetailsConsumesCanonicalSlug],
  ['no independent slugify-from-name logic remains in this file', testNoRemainingIndependentSlugifyLogicInThisFile],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
