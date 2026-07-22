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

function testAppRegistersTheNewRouteAdditively() {
  const content = read('App.jsx')
  assert(/const ExecutiveIntelligenceCenter = lazy\(\(\) => import\(['"]\.\/pages\/ExecutiveIntelligenceCenter\.jsx['"]\)\)/.test(content),
    'App.jsx must lazily import ExecutiveIntelligenceCenter.jsx like every other page')
  assert(/<Route path="executive-intelligence" element={<ExecutiveIntelligenceCenter \/>} \/>/.test(content),
    'App.jsx must register the new /executive-intelligence route')
  // Must not be added to NO_FILTER_PATHS -- the page needs filtered/
  // prevFiltered from the global filter bar, exactly like What Changed.
  const noFilterBlock = content.match(/const NO_FILTER_PATHS = \[([\s\S]*?)\]/)
  assert(noFilterBlock, 'could not find NO_FILTER_PATHS in App.jsx -- has its shape changed?')
  assert(!noFilterBlock[1].includes('executive-intelligence'),
    'the Executive Intelligence Center must use the global filter bar, so it must not be in NO_FILTER_PATHS')
}

function testAppStillRegistersEveryPreviouslyExistingRoute() {
  const content = read('App.jsx')
  const mustStillExist = [
    '<Route index                    element={<Navigate to="/overview" replace />} />',
    '<Route path="overview"          element={<ROverview />} />',
    '<Route path="action-center"     element={<ActionCenter />} />',
    '<Route path="operations-impact" element={<OperationsImpact />} />',
    '<Route path="what-changed"      element={<WhatChanged />} />',
    '<Route path="scraper-status"    element={<RScraper />} />',
  ]
  mustStillExist.forEach(line => {
    assert(content.includes(line), `existing route line must be unchanged: ${line}`)
  })
}

function testLayoutAddsNavEntryAdditively() {
  const content = read('components/Layout.jsx')
  assert(/execintel:\s*<svg/.test(content), 'Layout.jsx must define a new execintel icon')
  assert(/id: 'executive-intelligence', path: '\/executive-intelligence', label: 'Executive Intelligence'/.test(content),
    'Layout.jsx must add the Executive Intelligence nav entry')
}

function testLayoutStillHasEveryPreviouslyExistingNavEntry() {
  const content = read('components/Layout.jsx')
  const mustStillExist = [
    "{ id: 'overview',   path: '/overview',   label: 'Command Center', icon: I.overview   }",
    "{ id: 'action-center', path: '/action-center', label: 'Action Center', icon: I.actioncenter }",
    "{ id: 'operations-impact', path: '/operations-impact', label: 'Operations Impact', icon: I.opsimpact }",
    "{ id: 'what-changed', path: '/what-changed', label: 'What Changed?', icon: I.whatchanged }",
  ]
  mustStillExist.forEach(line => {
    assert(content.includes(line), `existing nav entry must be unchanged: ${line}`)
  })
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

const tests = [
  ['App.jsx registers the new route additively', testAppRegistersTheNewRouteAdditively],
  ['App.jsx still registers every previously-existing route', testAppStillRegistersEveryPreviouslyExistingRoute],
  ['Layout.jsx adds the new nav entry additively', testLayoutAddsNavEntryAdditively],
  ['Layout.jsx still has every previously-existing nav entry', testLayoutStillHasEveryPreviouslyExistingNavEntry],
  ['usePriorityDigest.js only composes existing hooks/utils', testHookExistsAndOnlyComposesExistingHooksAndUtils],
  ['the page renders all five sections in Problems->Wins->Changes->Narrative order', testPageRendersAllFiveSectionsAndLinksOutward],
  ['the page uses the pure digest hook and makes no new backend call', testPageUsesThePureDigestHookAndNoNewBackendCall],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
