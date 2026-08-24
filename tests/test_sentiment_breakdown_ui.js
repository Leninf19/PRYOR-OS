// Regression tests for dashboard/src/components/ui/SentimentBreakdown.jsx
// and its wiring into Today.jsx (Recovery Milestone: Reviews Analytics KPI).
// No React/browser test framework exists in this repo -- these are plain
// text/regex source-content assertions, same style as
// test_review_email_workflow_frontend.js.
//
// Run directly: node tests/test_sentiment_breakdown_ui.js

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

const breakdown = () => read('components/ui/SentimentBreakdown.jsx')
const today = () => read('pages/Today.jsx')

function testHeaderLabelIsReviewsReceived() {
  assert(/Reviews Received/.test(breakdown()), 'the card header must clearly say "Reviews Received"')
}

function testUsesSharedGetSentimentNotANewModel() {
  assert(/getSentiment\(/.test(breakdown()), 'must reuse the existing getSentiment() sentiment model, not a new one')
  assert(!/ai_sentiment\s*===/.test(breakdown()), 'sentiment classification logic belongs in dataUtils.js only, not duplicated here')
}

function testPercentageNeverDividesUnguarded() {
  const content = breakdown()
  // The percentage display must be reachable even when sent.n is 0 --
  // asserting the literal zero-safe fallback exists in the source, not just
  // trusting getSentiment()'s own math (which is separately tested).
  assert(/sent\.n\s*\?\s*`\$\{pct\.toFixed\(1\)\}%.*`\s*:\s*'0%'/.test(content), 'percentage rendering must have an explicit 0% fallback when sent.n is 0')
}

function testOneDecimalPlaceRounding() {
  assert(/toFixed\(1\)/.test(breakdown()), 'percentages must use one-decimal rounding, matching the app-wide fmtPct() convention')
}

function testPeriodLabelIsOptionalAndBackwardCompatible() {
  const content = breakdown()
  assert(/periodLabel/.test(content), 'must accept an optional periodLabel prop')
  assert(/periodLabel\s*&&/.test(content), 'periodLabel must be conditionally rendered -- absent for every caller that does not pass it, so existing usages are visually unchanged')
}

function testSummaryLineIsOptInNotDefault() {
  const content = breakdown()
  assert(/showSummaryLine\s*=\s*false/.test(content), 'showSummaryLine must default to false so Overview.jsx/LocationDetail.jsx/ExecutiveReports.jsx render unchanged unless they explicitly opt in')
}

function testExistingCallersStillPassOnlyReviewsProp() {
  // The three pre-existing call sites must still work with zero changes --
  // confirms this milestone's changes to the shared component are additive.
  const overview = read('pages/Overview.jsx')
  const locationDetail = read('pages/LocationDetail.jsx')
  const execReports = read('pages/ExecutiveReports.jsx')
  for (const [label, content] of [['Overview.jsx', overview], ['LocationDetail.jsx', locationDetail], ['ExecutiveReports.jsx', execReports]]) {
    assert(/<SentimentBreakdown\s+reviews=\{/.test(content), `${label} must still render <SentimentBreakdown reviews={...} /> unmodified`)
  }
}

function testTodayImportsAndRendersSentimentBreakdown() {
  assert(/import SentimentBreakdown from ['"]\.\.\/components\/ui\/SentimentBreakdown\.jsx['"]/.test(today()), 'Today.jsx must import the shared component')
  assert(/<SentimentBreakdown\s+reviews=\{filtered\}/.test(today()), 'Today.jsx must feed it the same `filtered` array the page already receives from the global filter bar')
}

function testTodayPassesPeriodLabelAndSummaryLine() {
  const content = today()
  assert(/<SentimentBreakdown[^/]*periodLabel=\{periodLabel\}/s.test(content), 'Today.jsx should pass the active periodLabel through')
  assert(/<SentimentBreakdown[^/]*showSummaryLine/s.test(content), 'Today.jsx should opt into the compact summary line')
}

function testTodayDoesNotFilterByReplyState() {
  // The `filtered` array Today.jsx receives comes from App.jsx's RootLayout
  // (date/brand/location/stars only) -- confirms no reply-state
  // (Needs Reply/Draft/Confirmed/Failed/Externally Replied) filtering leaks
  // into what SentimentBreakdown is fed here.
  const content = today()
  assert(!/replyState|needsResponseOnly|REPLY_STATE/.test(content), 'Today.jsx must not apply any reply-state filtering to the reviews fed into SentimentBreakdown')
}

function main() {
  run('card header clearly reads "Reviews Received"', testHeaderLabelIsReviewsReceived)
  run('reuses the existing getSentiment() model, no new sentiment logic', testUsesSharedGetSentimentNotANewModel)
  run('percentage rendering has an explicit 0% fallback (no divide-by-zero)', testPercentageNeverDividesUnguarded)
  run('percentages use one-decimal-place rounding', testOneDecimalPlaceRounding)
  run('periodLabel is optional and backward-compatible', testPeriodLabelIsOptionalAndBackwardCompatible)
  run('showSummaryLine defaults to false (opt-in only)', testSummaryLineIsOptInNotDefault)
  run('the three pre-existing callers are unmodified', testExistingCallersStillPassOnlyReviewsProp)
  run('Today.jsx imports and renders SentimentBreakdown fed by `filtered`', testTodayImportsAndRendersSentimentBreakdown)
  run('Today.jsx passes periodLabel and opts into the summary line', testTodayPassesPeriodLabelAndSummaryLine)
  run('Today.jsx applies no reply-state filtering to the sentiment card', testTodayDoesNotFilterByReplyState)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
