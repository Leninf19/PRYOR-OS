// Regression tests for Phase 3 Milestone 6 (Executive Intelligence Center)'s
// route/navigation wiring. No React component-render test framework exists
// in this repo -- these are plain-text/regex source-content assertions,
// the same style Milestone 5's test_provider_health_ui.js already uses.
//
// Run directly: node tests/test_executive_intelligence_center_ui.js

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

// Baseline stabilization pass update: the tests in this section originally
// captured Milestone 6's snapshot, when ExecutiveIntelligenceCenter.jsx was
// directly routed at /executive-intelligence and Layout.jsx carried a
// dedicated nav entry for it. Two LATER, deliberate, documented milestones
// have since superseded that snapshot:
//   - "M3" (Navigation Specification v1.0): collapsed the nav down to a
//     flat, final 8-item structure (Layout.jsx's own header comment) --
//     Operations Impact/What Changed/Action Center lost their dedicated
//     nav entries (their pages/routes are untouched and still reachable,
//     just no longer surfaced as top-level nav items).
//   - "M4" (Today UX Simplification / Execution Master Plan v1.0): Today
//     merges Overview/Executive Dashboard/Executive Intelligence Center
//     content behind one /today route. ExecutiveIntelligenceCenter.jsx,
//     Overview.jsx, and usePriorityDigest.js all deliberately STAY ON DISK,
//     unmodified, as App.jsx's own comment states, "for the rollback path
//     the Execution Master Plan v1.0 describes" -- they are simply no
//     longer imported/routed. /overview, /executive-intelligence, and
//     /executive-dashboard are now redirects to /today.
// None of this is a regression -- it is two real, comment-documented
// architecture migrations this test file never tracked. The tests below
// are updated to check current, correct routing/nav wiring; the OTHER
// tests in this file (which verify the orphaned-but-preserved files'
// internal content/composition are still intact) are deliberately left
// unchanged, since that is still an accurate and useful rollback guarantee.

function testAppRegistersTheRetiredRouteAsARedirectForRollback() {
  const content = read('App.jsx')
  // The page file itself is still lazily reachable in principle (import
  // path exists in comments/rollback docs), but M4 explicitly stopped
  // importing it in App.jsx -- confirming that is the point of this test
  // now, not that it's still directly routed.
  assert(!/const ExecutiveIntelligenceCenter = lazy\(/.test(content),
    'ExecutiveIntelligenceCenter.jsx must no longer be lazy-imported by App.jsx (M4: Today supersedes it, kept on disk only for rollback)')
  assert(/<Route path="executive-intelligence" element={<Navigate to="\/today"\s+replace \/>} \/>/.test(content),
    'App.jsx must redirect the retired /executive-intelligence route to /today')
  assert(/const Today\s+= lazy\(\(\) => import\(['"]\.\/pages\/Today\.jsx['"]\)\)/.test(content),
    'App.jsx must lazily import the current Today.jsx page')
  assert(/<Route path="today"\s+element={<Today \/>} \/>/.test(content),
    'App.jsx must register /today as the live route')
}

function testAppStillRegistersEveryPreviouslyExistingRoute() {
  const content = read('App.jsx')
  const mustStillExist = [
    '<Route index                    element={<Navigate to="/overview" replace />} />',
    // M4: /overview now redirects to /today (Today.jsx merges its content)
    // rather than rendering the old ROverview component directly.
    '<Route path="overview"            element={<Navigate to="/today" replace />} />',
    // Operations Calendar + Content Library milestone: /action-center now
    // redirects to /calendar (Calendar.jsx's AI Suggestions section) rather
    // than rendering the old ActionCenter component directly.
    '<Route path="action-center"          element={<Navigate to="/calendar" replace />} />',
    '<Route path="operations-impact" element={<OperationsImpact />} />',
    '<Route path="what-changed"      element={<WhatChanged />} />',
    '<Route path="scraper-status"    element={<RScraper />} />',
  ]
  mustStillExist.forEach(line => {
    assert(content.includes(line), `existing route line must be unchanged: ${line}`)
  })
}

function testLayoutCarriesTheExecIntelIconForwardOntoToday() {
  const content = read('components/Layout.jsx')
  // The icon originally added for the Executive Intelligence nav entry
  // (execintel) is still defined and still in active use -- M4 repointed
  // it to the 'today' nav entry (Today.jsx effectively succeeds
  // ExecutiveIntelligenceCenter.jsx as the primary command-center view),
  // rather than retiring the icon along with the standalone nav entry.
  assert(/execintel:\s*<svg/.test(content), 'Layout.jsx must still define the execintel icon')
  assert(/id: 'today',\s+path: '\/today',\s+label: 'Today',\s+icon: I\.execintel/.test(content),
    "Layout.jsx's 'today' nav entry must use the execintel icon, carried forward from the retired Executive Intelligence nav entry")
}

function testLayoutNavReflectsTheFinalEightItemStructure() {
  const content = read('components/Layout.jsx')
  // Navigation Specification v1.0 ("M3") deliberately collapsed the nav to
  // a flat, final 8-item structure -- Operations Impact/What Changed/
  // Action Center no longer have their OWN dedicated top-level nav entry
  // (their pages/routes are untouched -- see testAppStillRegistersEvery
  // PreviouslyExistingRoute above -- they're just reached other ways now,
  // e.g. linked out from Today.jsx). This is a deliberate design decision,
  // documented in Layout.jsx's own header comment, not an omission.
  const mustStillExist = [
    "{ id: 'today',     path: '/today',     label: 'Today',     icon: I.execintel }",
    "{ id: 'reviews',   path: '/reviews',   label: 'Reviews',   icon: I.response, badge: 'unanswered' }",
    "{ id: 'calendar',  path: '/calendar',  label: 'Calendar',  icon: I.calendar }",
    "{ id: 'locations', path: '/locations', label: 'Locations', icon: I.locations }",
    "{ id: 'insights',  path: '/insights',  label: 'Insights',  icon: I.trends }",
    "{ id: 'studio',    path: '/studio',    label: 'Studio',    icon: I.marketing }",
    "{ id: 'content',   path: '/content',   label: 'Content',   icon: I.content }",
    "{ id: 'reports',   path: '/reports',   label: 'Reports',   icon: I.reports }",
    "{ id: 'settings',  path: '/settings',  label: 'Settings',  icon: I.settings }",
  ]
  mustStillExist.forEach(line => {
    assert(content.includes(line), `expected final-structure nav entry missing/changed: ${line}`)
  })
  for (const retiredId of ['overview', 'action-center', 'operations-impact', 'what-changed']) {
    assert(!new RegExp(`id: '${retiredId}'`).test(content),
      `'${retiredId}' must not reappear as its own top-level nav entry -- it was deliberately folded into the flat 8-item nav`)
  }
}

function testHookExistsAndOnlyComposesExistingHooksAndUtils() {
  const content = read('hooks/usePriorityDigest.js')
  assert(/from '\.\/useIntelligence\.js'/.test(content), 'usePriorityDigest.js must reuse existing hooks from useIntelligence.js')
  assert(/getLocationMomentum|getCategoryChanges/.test(content), 'usePriorityDigest.js must reuse existing dataUtils.js functions, not reimplement them')
  assert(/from '\.\.\/utils\/priorityDigest\.js'/.test(content), 'usePriorityDigest.js must delegate ranking to the pure priorityDigest() function')
  // No direct fetch/API call of its own -- it must be pure composition.
  assert(!/fetch\(/.test(content), 'usePriorityDigest.js must not perform its own fetch -- it must only compose existing hooks')
}

function testPageRendersAllFiveSectionsAndLinksOutward() {
  const content = read('pages/ExecutiveIntelligenceCenter.jsx')
  assert(/Today's Priorities/.test(content), "Section 1 (Today's Priorities) must be present")
  assert(/Recent Wins/.test(content), 'Section 2 (Recent Wins) must be present')
  assert(/What Changed/.test(content), 'Section 3 (What Changed) must be present')
  assert(/Biggest Mover/.test(content) && /Emerging Trend/.test(content) && /This Week's Focus/.test(content),
    'Section 3 must contain exactly the three named cards')
  assert(/AI Executive Summary/.test(content), 'Section 4 (AI Executive Summary) must be present')
  assert(/useExecutiveBrief/.test(content), 'Section 4 must reuse the existing useExecutiveBrief hook, not a new AI call')

  // Section ordering: Priorities/Wins/Changed must appear before the AI
  // summary in source order (Problems -> Wins -> Changes -> Narrative).
  const priIdx = content.indexOf('TodaysPriorities')
  const winsIdx = content.indexOf('RecentWins')
  const changedIdx = content.indexOf('WhatChangedStrip')
  const aiIdx = content.indexOf('AIExecutiveSummary')
  assert(priIdx > -1 && winsIdx > -1 && changedIdx > -1 && aiIdx > -1, 'all four section components must be used in the page')
  assert(priIdx < aiIdx && winsIdx < aiIdx && changedIdx < aiIdx,
    'the AI Executive Summary must be rendered after the actionable sections, not before')

  // Section 5: Quick Links to the specified five destinations.
  const quickLinks = ["'/action-center'", "'/operations-impact'", "'/what-changed'", "'/intelligence'", "'/executive-dashboard'"]
  quickLinks.forEach(p => assert(content.includes(p), `Quick Links must include ${p}`))
}

function testPageUsesThePureDigestHookAndNoNewBackendCall() {
  const content = read('pages/ExecutiveIntelligenceCenter.jsx')
  assert(/usePriorityDigest\(/.test(content), 'the page must consume usePriorityDigest()')
  assert(!/fetch\(/.test(content), 'the page must not perform its own fetch -- all data must come through existing hooks')
}

// Action Center Accountability milestone: the fifth priority source
// (overdue tasks assigned to the current user) is computed in the hook,
// not fetched anew and not computed inside priorityDigest.js itself.
function testHookComputesAssignedOverdueItemsFromExistingWorkspaceAndAccount() {
  const content = read('hooks/usePriorityDigest.js')
  assert(/from '\.\/useActionWorkspace\.js'/.test(content), 'must reuse the existing useActionWorkspace() hook, not a new fetch')
  assert(/from '\.\.\/components\/AuthGate\.jsx'/.test(content), 'must reuse useAccount() for the current user, not invent a new identity source')
  assert(/from '\.\.\/utils\/actionWorkspaceUtils\.js'/.test(content), 'must reuse the shared isOverdue() check, not redefine overdue logic')
  assert(/assignedOverdueItems/.test(content), 'must pass assignedOverdueItems into priorityDigest()')
  assert(!/fetch\(/.test(content), 'usePriorityDigest.js must still perform no fetch of its own')
}

// Recovery-audit milestone (restaurant bad-review email workflow): the
// sixth priority source (overdue restaurant follow-ups) is likewise
// computed in the hook, cross-referenced against allReviews for a
// display-friendly location name.
function testHookComputesEmailFollowUpItemsFromWorkspaceAndAllReviews() {
  const content = read('hooks/usePriorityDigest.js')
  assert(/isEmailFollowUpOverdue/.test(content), 'must reuse the shared isEmailFollowUpOverdue() check')
  assert(/export function usePriorityDigest\(filtered, prevFiltered, allReviews = \[\]\)/.test(content),
    'usePriorityDigest must accept allReviews to cross-reference email-thread review ids')
  assert(/emailFollowUpItems/.test(content), 'must pass emailFollowUpItems into priorityDigest()')
}

function testPagePassesAllReviewsToPriorityDigest() {
  const content = read('pages/ExecutiveIntelligenceCenter.jsx')
  assert(/const \{ allReviews = \[\], filtered = \[\], prevFiltered = \[\], filters = \{\} \} = useOutletContext\(\) \?\? \{\}/.test(content),
    'the page must destructure allReviews from the Outlet context')
  assert(/usePriorityDigest\(filtered, prevFiltered, allReviews\)/.test(content), 'the page must pass allReviews through to the hook')
}

const tests = [
  ['App.jsx redirects the retired /executive-intelligence route to /today for rollback', testAppRegistersTheRetiredRouteAsARedirectForRollback],
  ['App.jsx still registers every previously-existing route', testAppStillRegistersEveryPreviouslyExistingRoute],
  ["Layout.jsx carries the execintel icon forward onto Today's nav entry", testLayoutCarriesTheExecIntelIconForwardOntoToday],
  ['Layout.jsx nav reflects the final flat 8-item structure', testLayoutNavReflectsTheFinalEightItemStructure],
  ['usePriorityDigest.js only composes existing hooks/utils', testHookExistsAndOnlyComposesExistingHooksAndUtils],
  ['the page renders all five sections in Problems->Wins->Changes->Narrative order', testPageRendersAllFiveSectionsAndLinksOutward],
  ['the page uses the pure digest hook and makes no new backend call', testPageUsesThePureDigestHookAndNoNewBackendCall],
  ['the hook computes assigned-overdue items from existing workspace/account hooks, not a new fetch', testHookComputesAssignedOverdueItemsFromExistingWorkspaceAndAccount],
  ['the hook computes overdue restaurant follow-ups from the same workspace, cross-referenced against allReviews', testHookComputesEmailFollowUpItemsFromWorkspaceAndAllReviews],
  ['the page passes allReviews through to usePriorityDigest', testPagePassesAllReviewsToPriorityDigest],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
