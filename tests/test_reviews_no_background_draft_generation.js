// Regression coverage for the removal of the Milestone 5 background/
// prewarm draft-generation worker from Reviews.jsx. That worker generated
// AI drafts for up to the next 5 actionable reviews the instant ANY review
// was selected -- including reviews the manager never opened -- silently
// moving them from Needs Reply to Draft just by being nearby in the queue.
// It has been removed outright, not replaced with another background/batch
// mechanism; the only remaining generation trigger is ResponseWorkspace's
// own on-open effect (unchanged) plus the existing manual Regenerate
// button. Follows this repo's established source-text-assertion convention
// for frontend code (no React Testing Library/jsdom here) -- see
// test_frontend_location_scoping.js/test_security_hardening.js.
//
// Run directly: node tests/test_reviews_no_background_draft_generation.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REVIEWS_JSX = path.resolve(__dirname, '..', 'dashboard', 'src', 'pages', 'Reviews.jsx')

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

const SRC = readFileSync(REVIEWS_JSX, 'utf-8')

// Slices out one top-level function's source by name, up to (but not
// including) the next top-level `function `/`export default function `
// declaration -- same technique test_security_hardening.js's
// extractFunctionSource() uses, generalized to accept either declaration form.
function extractTopLevelFunction(src, name) {
  const startMatch = src.match(new RegExp(`\\n(?:export default )?function ${name}\\(`))
  assert(startMatch, `could not locate top-level function ${name} in Reviews.jsx -- has it been renamed?`)
  const start = startMatch.index + 1
  const rest = src.slice(start + 1)
  const nextMatch = rest.match(/\n(?:export default )?function \w+\(/)
  return nextMatch ? src.slice(start, start + 1 + nextMatch.index) : src.slice(start)
}

// --- No trace of the removed prewarm worker survives anywhere -------------

function testNoPrewarmIdentifiersRemain() {
  // Prose mentions of "prewarm" are fine (e.g. a comment explaining why the
  // worker was removed) -- what must not survive is the actual removed
  // code: its constants, refs, and loop.
  const removedSymbols = ['PREWARM_COUNT', 'PREWARM_IDLE_POLL_MS', 'prewarmedRef', 'prewarmLiveRef']
  for (const symbol of removedSymbols) {
    assert(!SRC.includes(symbol), `"${symbol}" must not remain in Reviews.jsx -- the background prewarm worker must be fully removed, not just disabled`)
  }
}

// --- The page-level component never generates a draft merely by rendering -

function testPageBodyNeverCallsRewriteOutsideResponseWorkspace() {
  const pageBody = extractTopLevelFunction(SRC, 'Reviews')
  // ResponseWorkspace is defined earlier in the file and only *referenced*
  // (as a JSX element) inside the page body/ReviewDetailContent -- it must
  // never itself be inlined into the page-level component, and the page
  // body must never call callRewrite directly.
  assert(!/callRewrite\(/.test(pageBody), 'the page-level Reviews component must never call callRewrite() itself -- only an intentionally opened review\'s ResponseWorkspace instance may')
  assert(!/\bwhile\s*\(/.test(pageBody), 'no unbounded loop construct may exist in the page-level component -- that is exactly the shape the removed prewarm worker had')
  assert(!/setInterval\(/.test(pageBody), 'no polling/interval construct may exist in the page-level component -- a replacement background mechanism is explicitly disallowed')
}

// --- ResponseWorkspace still has exactly one on-open auto-generate effect,
//     correctly guarded against regenerating an already-drafted review ----

function testResponseWorkspaceHasExactlyOneGuardedAutoGenerateEffect() {
  const rw = extractTopLevelFunction(SRC, 'ResponseWorkspace')
  const rewriteCalls = [...rw.matchAll(/callRewrite\(/g)]
  assert(rewriteCalls.length === 2, `expected exactly 2 callRewrite() call sites inside ResponseWorkspace (on-open auto-generate + manual Regenerate), found ${rewriteCalls.length}`)

  // The auto-generate effect must run once per mount (empty dep array) --
  // ResponseWorkspace is remounted per opened review (see
  // testReviewDetailContentIsKeyedByReviewId below), so an empty dep array
  // here means "once per review actually opened," not "once ever."
  const effectMatch = rw.match(/useEffect\(\(\) => \{\s*\n\s*if \(hasAnyDraft \|\| isDone \|\| autoGenerateAttempted\.current\) return[\s\S]*?\n {2}\}, \[\]\)/)
  assert(effectMatch, 'ResponseWorkspace must have exactly one useEffect, keyed on an empty dependency array, that bails out early when hasAnyDraft/isDone/autoGenerateAttempted -- this is what makes "reopen a persisted draft -> no regeneration" and "generate only for the intentionally opened review" hold')

  // hasAnyDraft must be derived from a persisted draft/edit -- an existing
  // draft (scheduled export OR a previously-generated/edited workspace
  // entry) must short-circuit the effect before any network call.
  assert(/const hasAnyDraft = Boolean\(draft\?\.draft\) \|\| Boolean\(wsEntry\?\.editedDraft\)/.test(rw), 'hasAnyDraft must be true whenever a draft already exists anywhere (batch export or workspace) -- otherwise reopening an already-drafted review would regenerate it')
}

// --- ResponseWorkspace (via ReviewDetailContent) is remounted per review --
//     opened, so its once-per-mount effect can never fire for a review that
//     was never selected, and rapid selection changes can't leak generation
//     state from one review into another.

function testReviewDetailContentIsKeyedByReviewId() {
  const keyedInstances = [...SRC.matchAll(/<ReviewDetailContent key=\{reviewId\(r\)\}/g)]
  assert(keyedInstances.length === 2, `expected ReviewDetailContent to be rendered with key={reviewId(r)} in both the desktop-persistent and mobile-overlay panels, found ${keyedInstances.length} such render sites`)
}

run('no "prewarm" identifier survives anywhere in Reviews.jsx', testNoPrewarmIdentifiersRemain)
run('the page-level component never calls /api/rewrite and contains no loop/interval construct', testPageBodyNeverCallsRewriteOutsideResponseWorkspace)
run('ResponseWorkspace has exactly one guarded on-open auto-generate effect, plus manual Regenerate', testResponseWorkspaceHasExactlyOneGuardedAutoGenerateEffect)
run('ReviewDetailContent is keyed by reviewId(r) in both render sites, so generation state never leaks across reviews', testReviewDetailContentIsKeyedByReviewId)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
