// Regression tests for the Notification Center bell's wiring in
// dashboard/src/components/Layout.jsx. Source-text assertions (no React
// Testing Library/jsdom in this repo, per test_frontend_location_scoping.js's
// own established convention) -- behavioral coverage (open/close, badge,
// mark-read, mobile layout) lives in the Playwright browser QA for this
// milestone instead.
//
// Run directly: node tests/test_notification_bell_ui.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LAYOUT_JSX = path.resolve(__dirname, '..', 'dashboard', 'src', 'components', 'Layout.jsx')
const USE_NOTIFICATIONS_JS = path.resolve(__dirname, '..', 'dashboard', 'src', 'hooks', 'useNotifications.js')

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

const SRC = readFileSync(LAYOUT_JSX, 'utf-8')

function testNotificationBellIsSelfContainedViaTheHook() {
  assert(SRC.includes("import { useNotifications } from '../hooks/useNotifications.js'"), 'Layout.jsx must import useNotifications')
  const fnMatch = SRC.match(/function NotificationBell\(\) \{([\s\S]*?)\n\}/)
  assert(fnMatch, 'NotificationBell must take no props (self-contained via the hook)')
  assert(/const \{ notifications, unreadCount, isLoading, isError, markRead, markAllRead \} = useNotifications\(\)/.test(fnMatch[1]), 'NotificationBell must call useNotifications() itself')
}

function testBellIsMountedInBothDesktopSnapshotBarAndMobileTopbar() {
  const occurrences = [...SRC.matchAll(/<NotificationBell\s*\/>/g)].length
  assert(occurrences === 2, `expected the bell mounted twice (desktop SnapshotBar + mobile topbar), found ${occurrences}`)
}

function testBadgeShowsUnreadCountNotRawItemCount() {
  assert(/\{unreadCount > 0 && \(/.test(SRC), 'the badge must be conditioned on unreadCount, not a raw notification count')
  assert(!/alertList\.length \+ unanswered\.length/.test(SRC), 'the old raw alerts+unanswered count must be gone')
}

function testEmptyStateUsesTheRequiredCopy() {
  assert(SRC.includes("You're all caught up"), 'empty state must say "You\'re all caught up"')
  assert(SRC.includes('No alerts need your attention right now.'), 'empty state must say "No alerts need your attention right now."')
}

function testMarkAllReadButtonOnlyShownWhenUnreadExists() {
  const match = SRC.match(/\{unreadCount > 0 && \(\s*\n\s*<button type="button" onClick=\{markAllRead\}/)
  assert(match, 'Mark all read must be conditionally rendered only when unreadCount > 0, and wired to markAllRead')
}

function testNotificationRowMarksReadOnClickAndShowsRequiredFields() {
  const rowMatch = SRC.match(/function NotificationRow\(\{[\s\S]*?\n\}/)
  assert(rowMatch, 'could not find NotificationRow')
  const body = rowMatch[0]
  assert(/if \(!n\.read\) markRead\(n\.key\)/.test(body), 'clicking an unread notification must mark it read')
  assert(/n\.title/.test(body) && /n\.location/.test(body) && /n\.context/.test(body), 'a notification row must show title, location, and context')
  assert(/relativeTime\(n\.timestamp\)/.test(body), 'a notification row must show a relative timestamp')
  assert(/n\.read \? 'transparent' : 'var\(--color-accent-lt\)'/.test(body), 'read/unread must be visually distinguished')
}

function testReviewNotificationsDeepLinkUsingTheExistingReviewIdMechanism() {
  const fnMatch = SRC.match(/function notificationLinkTo\(n\) \{([\s\S]*?)\n\}/)
  assert(fnMatch, 'could not find notificationLinkTo')
  assert(/\/reviews\?reviewId=\$\{encodeURIComponent\(n\.link\.id\)\}/.test(fnMatch[1]), 'a review notification must deep-link via the EXISTING ?reviewId= mechanism Reviews.jsx already supports, not a new query param scheme')
}

function testNeedsAttentionAndEarlierSectionsAreUnreadVsRead() {
  assert(/const unread = notifications\.filter\(n => !n\.read\)/.test(SRC))
  assert(/const read = notifications\.filter\(n => n\.read\)/.test(SRC))
  assert(SRC.includes('Needs attention'))
  assert(SRC.includes('Earlier'))
}

function testMobilePanelUsesAResponsiveSheetLayoutNotAFixedDesktopWidth() {
  const fnMatch = SRC.match(/function NotificationBell\(\) \{([\s\S]*?)\nfunction /)
  assert(fnMatch, 'could not isolate NotificationBell body')
  assert(/left-3 right-3 sm:left-auto sm:right-0/.test(fnMatch[0]), 'the panel must be a full-width-minus-margin sheet on mobile, anchored under the bell only from sm: up')
  assert(/max-h-\[70vh\]/.test(fnMatch[0]), 'the panel must cap its own height on small viewports rather than overflowing')
}

// Regression guard for a real production bug caught during rollout: the
// hook originally built `/api/notifications?action=${action}` (a query
// string), but Vercel's [action].js dynamic-route convention maps the URL
// PATH SEGMENT to req.query.action (e.g. /api/actions/list, /api/settings/
// contacts-upsert -- see actionWorkspaceService.js/contactsService.js) --
// a query string never matches that route pattern and 404s before the
// function is even invoked. Every Node-level test for this endpoint calls
// the handler directly with a manually-constructed req.query.action, so
// none of them could have caught this; only a source-scan of the actual
// fetch URL construction (or a live deployment) can.
function testCallsTheRealApiUsingThePathSegmentConventionNotAQueryString() {
  const hookSrc = readFileSync(USE_NOTIFICATIONS_JS, 'utf-8')
  assert(hookSrc.includes('`/api/notifications/${action}`'), 'useNotifications.js must build the URL as /api/notifications/<action> (path segment), matching every other [action].js endpoint\'s real routing convention')
  assert(!/\/api\/notifications\?action=/.test(hookSrc), 'useNotifications.js must never use a ?action= query string -- that URL shape never matches Vercel\'s dynamic [action].js route and 404s in production')
}

function main() {
  run('NotificationBell is self-contained via useNotifications()', testNotificationBellIsSelfContainedViaTheHook)
  run('useNotifications.js calls the real API using the path-segment convention, not a query string', testCallsTheRealApiUsingThePathSegmentConventionNotAQueryString)
  run('the bell is mounted in both the desktop SnapshotBar and the mobile topbar', testBellIsMountedInBothDesktopSnapshotBarAndMobileTopbar)
  run('the badge reflects unreadCount, not a raw item count', testBadgeShowsUnreadCountNotRawItemCount)
  run('the empty state uses the required copy', testEmptyStateUsesTheRequiredCopy)
  run('Mark all read is shown only when there is something unread', testMarkAllReadButtonOnlyShownWhenUnreadExists)
  run('a notification row marks itself read on click and shows title/location/context/timestamp', testNotificationRowMarksReadOnClickAndShowsRequiredFields)
  run('a review notification deep-links via the existing ?reviewId= mechanism', testReviewNotificationsDeepLinkUsingTheExistingReviewIdMechanism)
  run('notifications are grouped into Needs attention (unread) / Earlier (read)', testNeedsAttentionAndEarlierSectionsAreUnreadVsRead)
  run('the panel uses a responsive mobile sheet layout, not a fixed desktop-only width', testMobilePanelUsesAResponsiveSheetLayoutNotAFixedDesktopWidth)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
