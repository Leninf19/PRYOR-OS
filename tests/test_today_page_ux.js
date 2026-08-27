// Regression tests for the Today Page UX Simplification. No React
// component-render test framework exists in this repo -- these are
// plain-text/regex source-content assertions, the same style
// test_notification_bell_ui.js / test_executive_intelligence_center_ui.js
// already use.
//
// Run directly: node tests/test_today_page_ux.js

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

const TODAY = read('pages/Today.jsx')

// ── 1. No duplicate reviews-received metric ─────────────────────────────────

function testNoDuplicateReviewsReceivedMetricAdjacentToTheKPIRow() {
  const kpiIdx = TODAY.indexOf('<KPIGrid')
  const sentimentIdx = TODAY.indexOf('<SentimentBreakdown')
  assert(kpiIdx > -1 && sentimentIdx > -1, 'both KPIGrid and SentimentBreakdown must still be present')
  // They must no longer be immediate siblings -- Needs Attention/AI Brief/
  // What Changed must sit between the fixed-30d KPI row and the
  // selected-period Reviews Received card, so the two review counts are
  // never mistaken for the same number.
  const between = TODAY.slice(kpiIdx, sentimentIdx)
  assert(/NeedsAttention/.test(between), 'Needs Attention must render between the KPI row and Reviews Received')
  assert(/WhatChangedCard/.test(between), 'What Changed must render between the KPI row and Reviews Received')
  // Each block must carry its own explicit period label so the two counts
  // are never silently mixed.
  assert(/Fixed snapshot from the last analytics run/.test(TODAY.slice(0, kpiIdx + 50)) ||
         /Fixed snapshot from the last analytics run/.test(TODAY),
         'the KPI row must be explicitly labeled as a fixed snapshot')
  assert(/Selected period/.test(TODAY.slice(sentimentIdx - 400, sentimentIdx)),
    'Reviews Received (SentimentBreakdown) must be explicitly labeled as the selected period, immediately above it')
}

// ── 2. Needs Attention max item count is enforced ───────────────────────────

function testNeedsAttentionMaxItemCountIsEnforced() {
  const digestSrc = read('utils/priorityDigest.js')
  assert(/const MAX_PRIORITIES = 5/.test(digestSrc), 'priorityDigest.js must still cap topPriorities at 5')
  assert(/rankAndDedupe\(priorityCandidates, MAX_PRIORITIES\)/.test(digestSrc), 'topPriorities must still be produced via the capped rankAndDedupe()')
  // Today.jsx must render the digest's own already-capped list, not re-slice
  // or expand it itself.
  assert(/items=\{digest\.topPriorities\}/.test(TODAY), 'Today.jsx must render digest.topPriorities directly (already capped at 5), not its own re-sliced copy')
  assert(!/topPriorities\.slice\(0,\s*(?:[6-9]|\d{2,})\)/.test(TODAY), 'Today.jsx must not widen the priorities list beyond the digest\'s own cap')
}

// ── 3. AI brief stays compact ────────────────────────────────────────────────

function testAIBriefStaysCompact() {
  assert(/label="AI Daily Brief"/.test(TODAY), 'Today.jsx must label the AI card "AI Daily Brief", not the old long-form "AI Executive Summary"')
  const briefApiSrc = read('../api/executive-brief.js')
  assert(/4-6 sentence/.test(briefApiSrc), 'the live briefing prompt must still ask for a short, bounded number of sentences')
  const cardSrc = read('components/ui/AIBriefingCard.jsx')
  // The live, short brief must be preferred over the longer pipeline
  // fallback narrative -- checked textually by source order.
  const briefBranchIdx = cardSrc.indexOf('brief.text ?')
  const summaryBranchIdx = cardSrc.indexOf('aiSummaryText ?')
  assert(briefBranchIdx > -1 && summaryBranchIdx > -1 && briefBranchIdx < summaryBranchIdx,
    'the compact live brief must be preferred (checked first) over the longer pipeline-summary fallback')
  // The optional "Top priorities" echo must stay to titles only (no
  // per-item explanation/CTA), so it doesn't balloon back into a long block.
  assert(/topPriorities\.slice\(0,\s*3\)/.test(cardSrc), 'the optional Top priorities echo inside the AI card must cap at 3 short titles')
  const echoBlockMatch = cardSrc.match(/topPriorities\?\.length > 0 && \(([\s\S]*?)\)\}/)
  assert(echoBlockMatch, 'could not find the Top priorities echo render block')
  assert(!/explanation/.test(echoBlockMatch[1]), 'the Top priorities echo must show titles only, not the full explanation text (that belongs to Needs Attention)')
}

// ── 4. Moved historical sections no longer render on Today ─────────────────

function testMovedHistoricalSectionsNoLongerRenderOnToday() {
  const removed = [
    'RatingTrendCard', 'LocationLeaderboard', 'ExecutiveScoreCard', 'CompanyGoalsSection',
    'ExecutivePerformanceDrawer', 'ActivityHistoryDrawer', 'useActivityFeed', 'useExecutiveScores',
    'useMonthlyTrend', 'useLocationStats', 'ReplyBacklogCard',
  ]
  removed.forEach(name => {
    assert(!TODAY.includes(name), `Today.jsx must no longer reference ${name} -- it moved to its own page/tab`)
  })
}

function testMovedSectionsHaveARealHomeElsewhere() {
  // Executive Performance -> /reports' new "Performance" tab.
  const reports = read('pages/ExecutiveReports.jsx')
  assert(/id: 'performance', label: 'Performance'/.test(reports), 'ExecutiveReports.jsx must register a Performance tab')
  assert(/function PerformancePanel/.test(reports), 'ExecutiveReports.jsx must define the moved PerformancePanel')
  assert(/<ExecutiveScoreCard/.test(reports) && /<CompanyGoalsSection/.test(reports), 'PerformancePanel must reuse the same score cards/goals section unchanged')

  // Activity History -> its own /activity route (un-redirected).
  const app = read('App.jsx')
  assert(/<Route path="activity"\s+element={<ActivityTimeline \/>} \/>/.test(app), 'App.jsx must serve /activity live again, not redirect it to /today')
  assert(!/<Route path="activity"\s+element={<Navigate to="\/today" replace \/>} \/>/.test(app), 'the old /activity -> /today redirect must be gone')

  // Rating Trend / Location Leaderboard already have a live, more complete
  // home at /trends -- verified by the trend/rankings tabs already existing
  // there (no new work required, just confirming they still do).
  const trends = read('pages/TrendsAnalytics.jsx')
  assert(/useMonthlyTrend/.test(trends), '/trends must still show the company rating trend')
  assert(/useLocationStats|useRankings/.test(trends), '/trends must still show location rankings')
}

// ── 5. Links route to the correct Review/Location/Action destinations ──────

function testCTALabelsMatchTheirDestinations() {
  const fnMatch = TODAY.match(/function ctaLabelFor\(sourcePath\) \{([\s\S]*?)\n\}/)
  assert(fnMatch, 'could not find ctaLabelFor()')
  const body = fnMatch[1]
  assert(/sourcePath\?\.startsWith\('\/reviews'\)\)\s*return 'View Review'/.test(body), 'a /reviews link must be labeled "View Review"')
  assert(/sourcePath === '\/actions'\)\s*return 'View Action'/.test(body), 'an /actions link must be labeled "View Action"')
  assert(/return 'View Location'/.test(body), 'every other (location-centric) source must be labeled "View Location"')
  assert(/\{ctaLabelFor\(item\.sourcePath\)\} →/.test(TODAY), 'PriorityRow must actually render the derived CTA label, not a generic "View details"')
}

function testMoreReportsLinksPointToTheRightPages() {
  const expected = ['/trends', '/locations', '/reports', '/activity']
  expected.forEach(p => {
    assert(new RegExp(`to: '${p.replace('/', '\\/')}'`).test(TODAY), `More Reports must link to ${p}`)
  })
}

// ── 6. Scoped user receives only assigned-location Today data ──────────────

function testTodayIntroducesNoNewCompanyWideCall() {
  // Today.jsx must compose everything through useTodayDigest() (which itself
  // only calls already-gated hooks) rather than calling a company-wide,
  // isLocationScoped-gated hook directly -- this was true before and must
  // stay true after the redesign moved several sections to other pages.
  const forbiddenDirectImports = ['useKPIs', 'useMonthlyTrend', 'useLocationStats', 'useExecutiveScores', 'useCompanySummary', 'useActionItems']
  forbiddenDirectImports.forEach(hook => {
    assert(!new RegExp(`import\\s*\\{[^}]*\\b${hook}\\b`).test(TODAY), `Today.jsx must not import ${hook} directly -- it must come through useTodayDigest()`)
  })
  assert(/from '\.\.\/hooks\/useTodayDigest\.js'/.test(TODAY), 'Today.jsx must still compose all its data through useTodayDigest()')

  // The hooks Today now indirectly depends on for the moved sections'
  // replacements (ExecutiveReports' new Performance tab) must still be
  // scoped-gated the same way every other company-wide file already is.
  const intel = read('hooks/useIntelligence.js')
  assert(/export function useExecutiveScores\(\)\s*\{ return useCompanyWideQuery/.test(intel),
    'useExecutiveScores must remain gated by useCompanyWideQuery so a scoped account never fires it (Multi-Location Authentication & User Access System)')
}

// ── 7. Empty state is graceful ──────────────────────────────────────────────

function testEmptyStateIsGraceful() {
  assert(/if \(!filtered\.length && !prevFiltered\.length\)/.test(TODAY), 'Today.jsx must keep the no-data-for-period early return')
  assert(/icon="🔍" title="No data for this period"/.test(TODAY), 'the page-level empty state must keep its icon/title')
  assert(/icon="✅" title="Nothing urgent right now"/.test(TODAY), 'Needs Attention must keep its graceful zero-items empty state')
}

// ── 8. Selected-period metrics update with filters ──────────────────────────

function testSelectedPeriodMetricsUseTheFilteredArray() {
  assert(/<SentimentBreakdown reviews=\{filtered\}/.test(TODAY), 'Reviews Received must be driven by the filter-reactive `filtered` array, not allReviews or a fixed snapshot')
  assert(/useTodayDigest\(filtered, prevFiltered, allReviews, filters\)/.test(TODAY), 'the digest hook must still receive the live filtered/prevFiltered/filters, so brief/topPriorities/What Changed stay filter-reactive')
}

const tests = [
  ['no duplicate reviews-received metric is presented adjacent to the KPI row', testNoDuplicateReviewsReceivedMetricAdjacentToTheKPIRow],
  ['Needs Attention max item count (5) is enforced by the shared digest, not re-widened on Today', testNeedsAttentionMaxItemCountIsEnforced],
  ['AI brief stays compact (short prompt, live-brief preferred, capped priorities echo)', testAIBriefStaysCompact],
  ['moved historical sections no longer render on Today', testMovedHistoricalSectionsNoLongerRenderOnToday],
  ['moved sections have a real home elsewhere (Reports/Trends/Activity)', testMovedSectionsHaveARealHomeElsewhere],
  ['CTA labels match their destinations (View Review/View Location/View Action)', testCTALabelsMatchTheirDestinations],
  ['More Reports links point to the right pages', testMoreReportsLinksPointToTheRightPages],
  ['Today introduces no new company-wide call (scoped-user authorization preserved)', testTodayIntroducesNoNewCompanyWideCall],
  ['empty state is graceful at both the page and Needs Attention level', testEmptyStateIsGraceful],
  ['selected-period metrics (Reviews Received) use the filtered array, so they update with filters', testSelectedPeriodMetricsUseTheFilteredArray],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
