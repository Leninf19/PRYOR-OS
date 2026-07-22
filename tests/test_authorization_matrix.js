// Phase 2 Milestone 3: the Authorization Test Matrix.
//
// TEST INFRASTRUCTURE ONLY. This file changes no production behavior --
// every assertion below exercises code that already exists and is already
// active (requireAuth, evaluateSession, the real endpoint handlers) or, for
// the Milestone 2 helpers (requireLocationAccess/requireOwnership/
// requireScopedAuth), exercises them in isolation exactly as
// tests/test_permissions.js already does. Nothing here calls the new
// helpers *through* an endpoint, because no endpoint does that yet.
//
// PURPOSE: this is the frozen regression baseline the Phase 2 Revision 3
// architecture calls for -- built once, against current (Phase 1 + M1/M2)
// behavior, then re-run UNMODIFIED as Milestones 4-9 change data shape and
// endpoint wiring. A future milestone changing an ACTIVE assertion here
// without an explicit, reviewed reason is a signal something regressed.
// A future milestone flipping a PENDING assertion to active is exactly the
// point of having recorded it.
//
// PENDING TESTS: several role/endpoint combinations described in the
// approved architecture are not decidable yet, because the endpoint code
// that would enforce them doesn't exist until a later milestone (location
// filtering in /api/data is Milestone 6, publish.js scoping is Milestone 8,
// etc). These are never silently skipped -- pending(...) below records each
// one explicitly with its expected final behavior, the milestone that
// activates it, and why it cannot pass today. See the PENDING SUMMARY at
// the end of this file's output.
//
// Run directly: node tests/test_authorization_matrix.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { signSession } from '../dashboard/api/_lib/session.js'
import { requireAuth, evaluateSession, requireLocationAccess, requireOwnership } from '../dashboard/api/_lib/auth.js'
import { Permission, ROLE_PERMISSIONS, roleHasPermission } from '../dashboard/api/_lib/permissions.js'

import dataHandler from '../dashboard/api/data.js'
import executiveBriefHandler from '../dashboard/api/executive-brief.js'
import rewriteHandler from '../dashboard/api/rewrite.js'
import sessionHandler from '../dashboard/api/session/[action].js'
import actionsHandler from '../dashboard/api/actions/[action].js'
import authHandler from '../dashboard/api/google/auth.js'
import callbackHandler from '../dashboard/api/google/callback.js'
import publishHandler from '../dashboard/api/google/publish.js'
import statusHandler from '../dashboard/api/google/status.js'
import testConnectionHandler from '../dashboard/api/google/test-connection.js'
import triggerSyncHandler from '../dashboard/api/google/trigger-sync.js'
import triggerImportHandler from '../dashboard/api/google/trigger-import.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const DASHBOARD_DIR = path.join(REPO_ROOT, 'dashboard')
const API_DIR = path.join(DASHBOARD_DIR, 'api')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
async function run(name, fn) {
  try {
    await fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  }
}

// Never silently skipped. Each call records, in the output and in
// pendingResults, exactly what final behavior is expected, which milestone
// activates it, and why it cannot pass under the current Phase 1 + M1/M2
// endpoint implementation. Counted separately from pass/fail -- a pending
// entry never fails the suite, but it also never disappears quietly.
const pendingResults = []
function pending(name, { expectedBehavior, milestone, reason }) {
  console.log(`PENDING: ${name}  [activates: Milestone ${milestone}]`)
  console.log(`  expected final behavior: ${expectedBehavior}`)
  console.log(`  why not active yet: ${reason}`)
  pendingResults.push({ name, milestone, expectedBehavior, reason })
}

// ---------------------------------------------------------------------------
// Fixture accounts (all @example.com -- never a real account, never written
// to any real ACCOUNT_DIRECTORY_JSON outside this process's env var).
// ---------------------------------------------------------------------------

async function setDirectory(overrides = {}) {
  const hash = await bcrypt.hash('correct-horse-battery-staple', 12)
  const base = {
    owner:            { userId: 'usr_owner',    email: 'owner@example.com',    passwordHash: hash, role: 'owner',            locationIds: '*',        sessionVersion: 1, disabled: false, displayName: 'Owner' },
    marketing:        { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing',       locationIds: '*',        sessionVersion: 1, disabled: false, displayName: 'Marketing' },
    location_manager: { userId: 'usr_lm',        email: 'lm@example.com',      passwordHash: hash, role: 'location_manager', locationIds: [3, 7, 12], sessionVersion: 1, disabled: false, displayName: 'Location Manager' },
    read_only:        { userId: 'usr_ro',        email: 'ro@example.com',      passwordHash: hash, role: 'read_only',        locationIds: [7],        sessionVersion: 1, disabled: false, displayName: 'Read Only' },
    disabled_owner:   { userId: 'usr_disabled',  email: 'disabled@example.com', passwordHash: hash, role: 'owner',            locationIds: '*',        sessionVersion: 1, disabled: true,  displayName: 'Disabled' },
  }
  for (const [key, patch] of Object.entries(overrides)) {
    base[key] = { ...base[key], ...patch }
  }
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({ accounts: Object.values(base) })
  return base
}

async function tokenFor(account, overrides = {}) {
  return signSession({
    userId: account.userId, email: account.email, role: account.role,
    locationIds: account.locationIds, sessionVersion: account.sessionVersion,
    ...overrides,
  })
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.send = (str) => { res.body = str; return res }
  res.redirect = (code) => { res.statusCode = code; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

const ROLES = ['owner', 'marketing', 'location_manager', 'read_only']

// ---------------------------------------------------------------------------
// SECTION 6 (defined early so SECTION 2's role matrix can be generated from
// it): the centralized endpoint authorization registry. One entry per
// ROUTE (session/[action].js contributes three). `file` is the path the
// scanner meta-test (below) matches production files against, so every
// entry's `file` must be a real path relative to dashboard/.
//
// currentAllowedRoles: the CURRENT production gate, read directly off each
// handler's requireAuth/evaluateSession call -- null means "any
// authenticated role", 'NONE' means no authentication is required at all
// (login itself, logout).
// ---------------------------------------------------------------------------

const ENDPOINT_REGISTRY = [
  {
    route: 'GET /api/data', file: 'api/data.js', method: 'GET',
    authRequired: true, currentAllowedRoles: ['owner', 'marketing'],
    scope: 'company-wide today; no location filtering exists yet',
    unauthorizedShape: 'json', wrongRoleStatus: 403,
    locationMilestone: 6,
    notes: 'Serves dashboard/private-data/** via a positive allowlist (see data-file registry below). Role gate is a flat allow-list, not permission-based.',
  },
  {
    route: 'GET /api/session/whoami', file: 'api/session/[action].js', method: 'GET', action: 'whoami',
    authRequired: true, currentAllowedRoles: null,
    scope: 'account-wide (identity only, no data)',
    unauthorizedShape: 'json', wrongRoleStatus: null,
    locationMilestone: null,
    notes: 'requireAuth(req, res, null) -- any authenticated, non-disabled, current-sessionVersion role passes. There is no "wrong role" case for this endpoint.',
  },
  {
    route: 'POST /api/session/login', file: 'api/session/[action].js', method: 'POST', action: 'login',
    authRequired: false, currentAllowedRoles: 'NONE',
    scope: 'none (entry point)',
    unauthorizedShape: null, wrongRoleStatus: null,
    locationMilestone: null,
    notes: 'Deliberately open to unauthenticated callers -- this IS the sign-in endpoint. Rate-limited (test_rate_limit.js) and enumeration-safe (test_login.js).',
  },
  {
    route: 'POST /api/session/logout', file: 'api/session/[action].js', method: 'POST', action: 'logout',
    authRequired: false, currentAllowedRoles: 'NONE',
    scope: 'none',
    unauthorizedShape: null, wrongRoleStatus: null,
    locationMilestone: null,
    notes: 'Idempotent cookie clear; no session required to call it, matching Phase 1 design (no server-side revocation list).',
  },
  {
    route: 'POST /api/google/publish', file: 'api/google/publish.js', method: 'POST',
    authRequired: true, currentAllowedRoles: ['owner', 'marketing'],
    scope: 'reply for any location today; no location filtering exists yet',
    unauthorizedShape: 'json', wrongRoleStatus: 403,
    locationMilestone: 8,
    notes: 'The "review reply" endpoint referenced throughout the architecture as the target of Milestone 7 (review->location lookup) and Milestone 8 (scoping).',
  },
  {
    route: 'POST /api/rewrite', file: 'api/rewrite.js', method: 'POST',
    authRequired: true, currentAllowedRoles: ['owner', 'marketing'],
    scope: 'account-wide -- a text-tone rewrite tool, not location data',
    unauthorizedShape: 'json', wrongRoleStatus: 403,
    locationMilestone: null,
    notes: 'No location dimension exists for this endpoint (it rewrites arbitrary caller-supplied text). No milestone in the roadmap scopes it; Owner/Marketing-only is expected to be permanent.',
  },
  {
    route: 'POST /api/executive-brief', file: 'api/executive-brief.js', method: 'POST',
    authRequired: true, currentAllowedRoles: ['owner', 'marketing'],
    scope: 'company-wide by design (CAMPAIGNS/EXPORT-tier functionality)',
    unauthorizedShape: 'json', wrongRoleStatus: 403,
    locationMilestone: null,
    notes: 'Per the strict location-scoping rule, a company-wide brief can never be handed to a location-scoped role -- Owner/Marketing-only is a PERMANENT design decision, not a pending gap.',
  },
  {
    route: 'GET /api/google/status', file: 'api/google/status.js', method: 'GET',
    authRequired: true, currentAllowedRoles: ['owner'],
    scope: 'account-wide administrative (Google connection status)',
    unauthorizedShape: 'json', wrongRoleStatus: 403,
    locationMilestone: null,
    notes: 'Owner-only administrative surface; not in scope for any location-aware milestone.',
  },
  {
    route: 'GET /api/google/test-connection', file: 'api/google/test-connection.js', method: 'GET',
    authRequired: true, currentAllowedRoles: ['owner'],
    scope: 'account-wide administrative',
    unauthorizedShape: 'json', wrongRoleStatus: 403,
    locationMilestone: null,
    notes: 'Owner-only administrative surface.',
  },
  {
    route: 'POST /api/google/trigger-sync', file: 'api/google/trigger-sync.js', method: 'POST',
    authRequired: true, currentAllowedRoles: ['owner'],
    scope: 'account-wide administrative (workflow trigger)',
    unauthorizedShape: 'json', wrongRoleStatus: 403,
    locationMilestone: null,
    notes: 'Owner-only administrative surface.',
  },
  {
    route: 'POST /api/google/trigger-import', file: 'api/google/trigger-import.js', method: 'POST',
    authRequired: true, currentAllowedRoles: ['owner'],
    scope: 'account-wide administrative (workflow trigger)',
    unauthorizedShape: 'json', wrongRoleStatus: 403,
    locationMilestone: null,
    notes: 'Owner-only administrative surface.',
  },
  {
    route: 'GET /api/google/auth', file: 'api/google/auth.js', method: 'GET',
    authRequired: true, currentAllowedRoles: ['owner'],
    scope: 'account-wide administrative (OAuth initiation)',
    unauthorizedShape: 'html', wrongRoleStatus: 403,
    locationMilestone: null,
    knownDefect: 'ERROR_CONTRACT_EXCEPTION_1',
    notes: 'RESOLVED by Milestone 6A (was: ERROR_CONTRACT_EXCEPTION_1). This handler now destructures `reason` from evaluateSession() and uses the shared statusForAuthFailure(reason) helper (dashboard/api/_lib/auth.js) to return 403 for an authenticated-but-wrong-role caller (e.g. Marketing), matching every requireAuth()-based endpoint and the frozen §6 error contract. 401 is still returned for a true identity failure (no session, invalid session, disabled account, stale sessionVersion). See ERROR_CONTRACT_EXCEPTIONS below for the full resolution record.',
  },
  {
    route: 'GET /api/google/callback', file: 'api/google/callback.js', method: 'GET',
    authRequired: true, currentAllowedRoles: ['owner'],
    scope: 'account-wide administrative (OAuth callback)',
    unauthorizedShape: 'html', wrongRoleStatus: 403,
    locationMilestone: null,
    knownDefect: 'ERROR_CONTRACT_EXCEPTION_1',
    notes: 'Same fix and the same resolved ERROR_CONTRACT_EXCEPTION_1 as auth.js above, plus an independent CSRF state check (unchanged). Owner-only.',
  },
  {
    route: 'GET /api/session/accounts', file: 'api/session/[action].js', method: 'GET', action: 'accounts',
    authRequired: true, currentAllowedRoles: null,
    scope: 'account-wide (identity directory listing, no review/location data)',
    unauthorizedShape: 'json', wrongRoleStatus: null,
    locationMilestone: null,
    notes: 'Action Center Accountability milestone. requireAuth(req, res, null) -- any authenticated, non-disabled, current-sessionVersion role passes, same as whoami. Returns every non-disabled account\'s sanitized identity (no passwordHash) -- deliberately on the identity layer, not owned by any one feature, so future features (workload reporting, notifications, settings, audit logs) reuse this same endpoint instead of each growing their own account-listing logic. There is no "wrong role" case for this endpoint.',
  },
  {
    route: 'GET /api/actions/list', file: 'api/actions/[action].js', method: 'GET', action: 'list',
    authRequired: true, currentAllowedRoles: ['owner', 'marketing'],
    scope: 'company-wide task workspace -- not part of the location-authorization roadmap (Milestones 6-9 above); this endpoint reads Redis-backed collaborative state, never reviews.db-derived location data',
    unauthorizedShape: 'json', wrongRoleStatus: 403,
    locationMilestone: null,
    notes: 'Action Center Accountability milestone. Same read roles as the AI Action Center already has today (owner, marketing) -- location_manager is deliberately NOT granted here; per README "Location authorization strategy", location-scoped accounts remain unsafe to create until Milestone 6/7\'s location_id propagation lands, and this milestone does not change that.',
  },
  {
    route: 'POST /api/actions/update', file: 'api/actions/[action].js', method: 'POST', action: 'update',
    authRequired: true, currentAllowedRoles: ['owner', 'marketing'],
    scope: 'company-wide task workspace -- same non-goal as GET /api/actions/list',
    unauthorizedShape: 'json', wrongRoleStatus: 403,
    locationMilestone: null,
    notes: 'Action Center Accountability milestone. Rate-limited per-caller (test_actions_endpoint.js). Rejects any patch containing a server-owned field (createdBy/At, updatedBy/At, history, id) with 400, before ever reaching actionStore.js.',
  },
  {
    route: 'GET /api/actions/preview-review-email', file: 'api/actions/[action].js', method: 'GET', action: 'preview-review-email',
    authRequired: true, currentAllowedRoles: ['owner', 'marketing'],
    scope: 'restaurant bad-review email workflow -- same non-goal as GET /api/actions/list; recipient is resolved server-side, never client-supplied',
    unauthorizedShape: 'json', wrongRoleStatus: 403,
    locationMilestone: null,
    notes: 'Recovery-audit milestone (restaurant bad-review email workflow). Read-only preview of the recipient/CC/Reply-To a send WOULD use, for the confirmation panel -- never returns the whole location-contacts.json directory, only the one location requested.',
  },
  {
    route: 'POST /api/actions/send-review-email', file: 'api/actions/[action].js', method: 'POST', action: 'send-review-email',
    authRequired: true, currentAllowedRoles: ['owner', 'marketing'],
    scope: 'restaurant bad-review email workflow -- same non-goal as GET /api/actions/list',
    unauthorizedShape: 'json', wrongRoleStatus: 403,
    locationMilestone: null,
    notes: 'Recovery-audit milestone. Rate-limited per-caller (test_send_review_email.js). Recipient/CC/Reply-To are always server-resolved (locationContacts.js / reviewEmailConfig.js) -- the request body has no field for any of them. Duplicate-send protection requires confirmResend once an item is sent/replied/follow_up_required/resolved.',
  },
  {
    route: 'POST /api/actions/update-email-status', file: 'api/actions/[action].js', method: 'POST', action: 'update-email-status',
    authRequired: true, currentAllowedRoles: ['owner', 'marketing'],
    scope: 'restaurant bad-review email workflow -- same non-goal as GET /api/actions/list',
    unauthorizedShape: 'json', wrongRoleStatus: 403,
    locationMilestone: null,
    notes: 'Recovery-audit milestone. Manual replied/follow_up_required/resolved transitions only -- rejects "sent"/"failed"/"queued"/"not_sent" outright, and rejects any item with no prior outgoing email, so this can never be used to fake a send.',
  },
]

// ---------------------------------------------------------------------------
// TRACKED ARCHITECTURE EXCEPTIONS -- known, deliberate deviations from the
// frozen Phase 2 Revision 3 architecture, each with an explicit owner (a
// named milestone or sub-milestone) so it cannot go unfixed by omission.
// Referenced by `knownDefect` above and cross-checked by a meta-test below.
// An exception with status: 'resolved' is retained for historical context
// (which milestone found it, which milestone fixed it, what changed) --
// never deleted outright -- but must no longer be treated as open: see
// recordErrorContractPendingTests() (skips resolved exceptions) and
// testResolvedExceptionsDoNotLeaveStaleRegistryEntries() (fails if any
// registry entry referencing a resolved exception still shows the old,
// pre-fix status).
// ---------------------------------------------------------------------------

const ERROR_CONTRACT_EXCEPTIONS = [
  {
    id: 'ERROR_CONTRACT_EXCEPTION_1',
    status: 'resolved',
    affects: ['api/google/auth.js', 'api/google/callback.js'],
    formerBehavior: '401 for an authenticated account with the wrong role (indistinguishable from no session at all)',
    targetBehavior: '403 for an authenticated account with the wrong role, per the frozen §6 error contract -- matching every requireAuth()-based endpoint',
    discoveredByMilestone: 3,
    resolvedByMilestone: '6A',
    resolvedByMilestoneName: 'Milestone 6A -- API error-contract normalization',
    resolutionSummary: 'Both handlers now destructure `reason` (not just `account`) from evaluateSession() and branch on the new shared dashboard/api/_lib/auth.js helper statusForAuthFailure(reason) -- 403 for reason === "forbidden" (authenticated, wrong role), 401 otherwise (no valid identity at all). requireAuth(), evaluateSession() itself, and the successful-Owner path are all byte-for-byte unchanged; Owner remains the only allowed role.',
  },
]

// ---------------------------------------------------------------------------
// SECTION 7: the data-file authorization registry. Keyed to the EXACT
// filenames/patterns data.js's own allowlist actually serves (read directly
// off dashboard/api/data.js's source below, not hand-copied, so this
// registry cannot silently drift from the real allowlist).
// ---------------------------------------------------------------------------

// `files`: the EXACT literal EXACT_ALLOWLIST entries (or, for dynamic
// patterns, the literal path PREFIX before the slug) belonging to this
// category -- independently listed per file/pattern even where several
// files share one conceptual category, so the cross-check test below can
// do exact set-membership rather than a fuzzy "explainable" heuristic. A
// category with no real backing file yet uses an empty `files: []` array
// and explains why in `accessModel`.
const DATA_FILE_REGISTRY = [
  {
    category: 'per-location reviews', files: ['reviews/by-location/'], dynamic: true,
    owner: 'yes', marketing: 'yes', location_manager: 'assigned-only (pending)', read_only: 'assigned-only (pending)',
    accessModel: 'unrestricted today for owner/marketing (every slug); assigned-only intended for scoped roles',
    milestone: 6,
  },
  {
    // RESOLVED (Milestone 5, Option C): dashboard/private-data/analytics/locations/<locationId>.json
    // now exists -- generated by export_chunks.py's export_location_analytics()
    // from refresh_analytics.py's analytics_location_<id> cache entries (the
    // same shared aggregation functions company-wide analytics use, given
    // this location's own filtered review list). It carries review counts,
    // average rating, star distribution, response metrics, trends,
    // department metrics, keywords, and AI summaries -- exactly the fields
    // this category names.
    //
    // NOT YET represented in `files` below and NOT YET in this category's
    // per-role access columns, on purpose: dashboard/api/data.js's allowlist
    // is completely unchanged by Milestone 5 (confirmed by
    // testAnalyticsLocationsArtifactExistsButNotYetServedByApiData below) --
    // this file exists in the export pipeline's output but is not reachable
    // by ANY role through any endpoint yet, not even Owner/Marketing.
    // Milestone 6 owns both wiring it into data.js's allowlist and enforcing
    // location-scoped access to it.
    category: 'per-location analytics', files: [],
    exportArtifact: 'analytics/locations/{locationId}.json',
    owner: 'not yet reachable via any endpoint (Milestone 6)',
    marketing: 'not yet reachable via any endpoint (Milestone 6)',
    location_manager: 'not yet reachable via any endpoint (Milestone 6)',
    read_only: 'not yet reachable via any endpoint (Milestone 6)',
    accessModel: 'RESOLVED existence gap (Milestone 5): the artifact now exists in the export pipeline\'s output, keyed by the canonical numeric locationId (never a slug), reconciled against company totals (review counts, star distribution, average rating all verified to sum/reconcile exactly). PENDING access gap (Milestone 6): not yet added to data.js\'s allowlist, so nobody can fetch it via /api/data yet.',
    milestone: 6,
  },
  {
    category: 'company-wide KPIs', files: ['analytics/kpis.json', 'analytics/location-stats.json'],
    owner: 'yes', marketing: 'yes', location_manager: 'blocked (permanent)', read_only: 'blocked (permanent)',
    accessModel: 'company-wide data is never handed to a scoped role per the strict-scoping rule -- Milestone 6 changes the ENFORCEMENT MECHANISM (from a blanket role-gate to a precise permission/category check), not the outcome. analytics/location-stats.json is filed here (not under "per-location analytics") because, despite its name, it is one company-wide file enumerating every location\'s stats together, not a per-location artifact.',
    milestone: 6,
  },
  {
    category: 'rankings', files: ['analytics/rankings-30d.json'],
    owner: 'yes', marketing: 'yes', location_manager: 'blocked (permanent)', read_only: 'blocked (permanent)',
    accessModel: 'company-wide ranking across all locations -- same permanent-block reasoning as company-wide KPIs',
    milestone: 6,
  },
  {
    category: 'company-wide trends', files: ['analytics/monthly-trend.json'],
    owner: 'yes', marketing: 'yes', location_manager: 'blocked (permanent)', read_only: 'blocked (permanent)',
    accessModel: 'same permanent-block reasoning as company-wide KPIs',
    milestone: 6,
  },
  {
    // RESOLVED (Milestone 5): the same analytics/locations/<locationId>.json
    // artifact above carries this category's data too, in its `trends`
    // field (monthly trend history + trend-alert), computed via the same
    // shared monthly_trend()/rating_trend_alert() functions the company-wide
    // trends file uses -- one physical file serves both conceptual
    // categories, which is why both point at the same exportArtifact rather
    // than each getting a separate file. Same NOT YET reachable via
    // /api/data caveat as per-location analytics above.
    category: 'per-location trends', files: [],
    exportArtifact: 'analytics/locations/{locationId}.json',
    owner: 'not yet reachable via any endpoint (Milestone 6)',
    marketing: 'not yet reachable via any endpoint (Milestone 6)',
    location_manager: 'not yet reachable via any endpoint (Milestone 6)',
    read_only: 'not yet reachable via any endpoint (Milestone 6)',
    accessModel: 'RESOLVED existence gap (Milestone 5): per-location monthly trend + trend-alert data now exists, embedded in analytics/locations/{locationId}.json\'s `trends` field. PENDING access gap (Milestone 6): not yet in data.js\'s allowlist.',
    milestone: 6,
  },
  {
    category: 'reports', files: ['reports/weekly-summary.json'],
    owner: 'yes', marketing: 'yes', location_manager: 'blocked (permanent)', read_only: 'blocked (permanent)',
    accessModel: 'company-wide report; permanent block for scoped roles',
    milestone: 6,
  },
  {
    category: 'company-wide intelligence',
    files: [
      'insights/all.json',
      'intelligence/company-summary.json', 'intelligence/complaint-intelligence.json', 'intelligence/department-performance.json',
      'intelligence/cx-index.json', 'intelligence/best-quotes.json', 'intelligence/seasonal-trends.json',
      'intelligence/executive-scores.json', 'intelligence/action-center.json', 'intelligence/operations-impact.json',
      'intelligence/predictive-alerts.json', 'intelligence/competitive-intelligence.json', 'intelligence/response-drafts.json',
    ],
    owner: 'yes', marketing: 'yes', location_manager: 'blocked (permanent)', read_only: 'blocked (permanent)',
    accessModel: 'company-wide by construction; permanent block for scoped roles. NAMING DEBT (see NAMING_INCONSISTENCIES below): insights/all.json lives in a differently-named directory than the 12 intelligence/*.json files it is conceptually identical to -- both are listed here individually (not squashed into one string) precisely so this registry stays exact even though the directory names disagree.',
    milestone: 6,
  },
  {
    category: 'per-location intelligence', files: ['intelligence/locations/', 'insights/'], dynamic: true,
    owner: 'yes', marketing: 'yes', location_manager: 'assigned-only (pending)', read_only: 'assigned-only (pending)',
    accessModel: 'unrestricted today for owner/marketing; assigned-only intended for scoped roles. This is the exact pattern Milestone 5 (Option C) extends for the two GAP categories above. Same insights/ vs intelligence/locations/ naming debt as the company-wide bucket -- both listed individually below.',
    milestone: 6,
  },
  {
    category: 'operational / meta (no location dimension)',
    files: ['meta.json', 'action-items.json', 'validation.json', 'scraper-status.json', 'gbp-sync.json', 'provider-health.json'],
    owner: 'yes', marketing: 'yes', location_manager: 'blocked (permanent)', read_only: 'blocked (permanent)',
    accessModel: 'not one of the architecture\'s 11 named categories -- these are operational/meta files (location directory, validation status, scraper/sync state) with no location dimension at all. Documented explicitly here so the registry accounts for every real allowlisted file rather than silently omitting them. provider-health.json (Phase 3 Milestone 5, a completely separate numbering track from this file\'s own "Milestone 5" in SECTION 7B below -- that one is Phase 2\'s per-location analytics work) was added to data.js\'s allowlist with the exact same owner/marketing-only access as its scraper-status.json/gbp-sync.json siblings -- no new access model needed.',
    milestone: 6,
  },
  {
    category: 'raw-data exports', files: [],
    owner: 'yes (derived)', marketing: 'yes (derived)', location_manager: 'derived from Milestone 6 access', read_only: 'blocked -- requires Milestone 9 frontend control removal',
    accessModel: 'CLARIFIED (Decision 3): raw-data export is client-side repackaging of data already returned by /api/data (dashboard/src/utils/exportUtils.js turns already-fetched JSON into CSV in the browser) -- there is no separate backend export endpoint or file, and none should be invented. Responsibilities are split explicitly: Milestone 6 ensures the SOURCE DATA Location Manager can retrieve is already location-scoped, so their export is automatically limited to authorized data -- no separate export permission check is needed on the backend for them. Milestone 9 is responsible for hiding/disabling the CSV/print/download export controls in the frontend for Read Only, since Read Only\'s export prohibition cannot be enforced by data-scoping alone (unlike Location Manager, they must not export their own visible data either) and there is no backend export surface to gate.',
    milestone: null,
    milestoneNotes: { locationManagerExport: 6, readOnlyExportControlRemoval: 9 },
  },
  {
    category: 'review-to-location internal lookup', files: [],
    owner: 'internal-only, never public', marketing: 'internal-only, never public', location_manager: 'internal-only, never public', read_only: 'internal-only, never public',
    accessModel: 'Milestone 7 creates this file to let publish.js resolve a review to its owning location. It must NEVER be added to data.js\'s public allowlist (EXACT_ALLOWLIST or DYNAMIC_ALLOWLIST) for any role, including Owner. See the PENDING test below that guards this by name once the file exists.',
    milestone: 7,
  },
]

// ---------------------------------------------------------------------------
// NAMING INCONSISTENCIES (Decision 4): documented as safe technical debt,
// not fixed here (no files renamed in this milestone). Each entry states why
// it is safe -- i.e. that it does not create any authorization ambiguity,
// because every file on both sides of the naming split is independently
// registered above and receives IDENTICAL per-role treatment.
// ---------------------------------------------------------------------------

const NAMING_INCONSISTENCIES = [
  {
    id: 'insights_vs_intelligence',
    description: 'insights/* and intelligence/* are two separate directory names representing overlapping conceptual categories: insights/all.json is company-wide (same bucket as the 12 intelligence/*.json files); insights/{slug}.json is per-location (same bucket as intelligence/locations/{slug}.json).',
    safeBecause: 'both sides of the split receive IDENTICAL authorization treatment in DATA_FILE_REGISTRY (same owner/marketing/location_manager/read_only access, same milestone) -- the naming split is cosmetic, not an authorization ambiguity. Every individual file/pattern from both directories is independently listed in the registry above rather than being merged into one squashed string, so a future rename or split cannot silently drop coverage of one side.',
    disposition: 'safe technical debt -- no rename planned in this milestone',
  },
]

// ===========================================================================
// SECTION 1 -- AUTHENTICATION BASELINE
// ===========================================================================

async function testUnauthenticatedProtectedRequestReturns401() {
  await setDirectory()
  const { req, res } = (() => { const r = fakeRes(); return { req: { headers: {} }, res: r } })()
  const account = await requireAuth(req, res, ['owner'])
  assert(account === null, 'unauthenticated request must be rejected')
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
  assert(res.body.error === 'unauthenticated', res.body.error)
}

async function testInvalidSessionReturns401() {
  await setDirectory()
  const req = { headers: { cookie: 'lta_session=not-a-real-jwt-at-all' } }
  const res = fakeRes()
  const account = await requireAuth(req, res, null)
  assert(account === null, 'a malformed/invalid session token must be rejected')
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testExpiredSessionReturns401() {
  const fixtures = await setDirectory()
  const token = await tokenFor(fixtures.owner)
  // Sign a second, already-expired token rather than waiting -- expiresInSeconds
  // accepts a negative value to simulate a token whose exp already passed.
  const expired = await signSession(
    { userId: fixtures.owner.userId, email: fixtures.owner.email, role: fixtures.owner.role, locationIds: fixtures.owner.locationIds, sessionVersion: fixtures.owner.sessionVersion },
    { expiresInSeconds: -10 },
  )
  const req = { headers: { cookie: `lta_session=${expired}` } }
  const res = fakeRes()
  const account = await requireAuth(req, res, null)
  assert(account === null, 'expired session must be rejected')
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
  assert(token, 'sanity: a fresh token was constructible for comparison')
}

async function testDisabledAccountRejected() {
  const fixtures = await setDirectory()
  const token = await tokenFor(fixtures.disabled_owner)
  const req = { headers: { cookie: `lta_session=${token}` } }
  const res = fakeRes()
  const account = await requireAuth(req, res, ['owner'])
  assert(account === null, 'a disabled account must be rejected even with a validly-signed, current-version token')
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testSessionVersionMismatchRejected() {
  const fixtures = await setDirectory()
  // Token carries sessionVersion 1; bump the directory's current version to
  // 2 (simulating a password/role change) without re-issuing the token.
  await setDirectory({ owner: { sessionVersion: 2 } })
  const token = await tokenFor({ ...fixtures.owner, sessionVersion: 1 })
  const req = { headers: { cookie: `lta_session=${token}` } }
  const res = fakeRes()
  const account = await requireAuth(req, res, null)
  assert(account === null, 'a stale sessionVersion must be rejected even though the signature is valid')
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
  assert(res.body.error === 'session_expired', res.body.error)
}

async function testValidAccountReResolvesFromAuthoritativeStore() {
  const fixtures = await setDirectory()
  // Token issued while the account was 'owner' with company-wide access.
  const token = await tokenFor(fixtures.owner)

  // The directory now says something different for the SAME userId: role
  // downgraded, locationIds narrowed. No new token was issued -- the browser
  // still presents the original cookie.
  await setDirectory({ owner: { role: 'location_manager', locationIds: [9] } })

  const req = { headers: { cookie: `lta_session=${token}` } }
  const res = fakeRes()
  const account = await requireAuth(req, res, null)
  assert(account !== null, 'a still-valid token (unchanged sessionVersion) must still authenticate')
  assert(account.role === 'location_manager', `role must be re-resolved from the CURRENT store, got ${account.role}`)
  assert(JSON.stringify(account.locationIds) === JSON.stringify([9]), `locationIds must be re-resolved from the CURRENT store, got ${JSON.stringify(account.locationIds)}`)
}

async function testNoClaimTrustedPermanentlyFromToken() {
  const fixtures = await setDirectory()
  // Forge a token claiming 'owner' -- but the directory has never had this
  // userId as owner, or is about to say otherwise. This proves the ROLE
  // CHECK ITSELF uses the freshly-read account, not claims.role from the
  // token, by downgrading the role between issuance and request and
  // confirming an owner-only route now rejects it.
  const token = await tokenFor(fixtures.owner) // claims.role === 'owner' inside the JWT
  await setDirectory({ owner: { role: 'read_only', locationIds: [7] } })

  const req = { headers: { cookie: `lta_session=${token}` } }
  const res = fakeRes()
  const account = await requireAuth(req, res, ['owner'])
  assert(account === null, 'an owner-only route must reject this session once the store says the account is no longer owner, regardless of what the token claims')
  assert(res.statusCode === 403, `expected 403 (authenticated, wrong role), got ${res.statusCode}`)
}

// ===========================================================================
// SECTION 2 -- ROLE MATRIX
//
// Generated from ENDPOINT_REGISTRY so the matrix cannot silently drift from
// the registry that also drives the scanner meta-test (SECTION 6). For each
// endpoint requiring auth, every role NOT in currentAllowedRoles must be
// rejected with wrongRoleStatus (403) today -- this is real, ACTIVE
// production behavior (a flat per-endpoint role allow-list), independent of
// the still-unused Milestone 2 permission helpers. Roles that ARE allowed
// are covered by existing functional suites (test_data_endpoint.js,
// test_endpoint_auth.js, test_publish_reply.js, test_oauth_safety.js) and
// are not re-mocked here -- this matrix's job is the AUTHORIZATION decision,
// not endpoint business logic.
// ===========================================================================

const HANDLERS = {
  'api/data.js': dataHandler,
  'api/executive-brief.js': executiveBriefHandler,
  'api/rewrite.js': rewriteHandler,
  'api/session/[action].js': sessionHandler,
  'api/actions/[action].js': actionsHandler,
  'api/google/auth.js': authHandler,
  'api/google/callback.js': callbackHandler,
  'api/google/publish.js': publishHandler,
  'api/google/status.js': statusHandler,
  'api/google/test-connection.js': testConnectionHandler,
  'api/google/trigger-sync.js': triggerSyncHandler,
  'api/google/trigger-import.js': triggerImportHandler,
}

function minimalReqFor(entry, token) {
  const headers = token ? { cookie: `lta_session=${token}` } : {}
  const req = { method: entry.method, headers, body: {} }
  if (entry.action) req.query = { action: entry.action, ...(req.query || {}) }
  if (entry.file === 'api/data.js') req.query = { file: 'meta.json' }
  if (entry.file === 'api/google/callback.js') req.query = { code: 'x', state: 'y' }
  return req
}

async function testRoleMatrixDeniesEveryNonAllowedRole() {
  const fixtures = await setDirectory()
  for (const entry of ENDPOINT_REGISTRY) {
    if (!entry.authRequired || entry.currentAllowedRoles === 'NONE') continue
    const handler = HANDLERS[entry.file]
    assert(handler, `no handler wired for registry file ${entry.file}`)

    for (const role of ROLES) {
      const allowed = entry.currentAllowedRoles === null || entry.currentAllowedRoles.includes(role)
      if (allowed) continue // covered by existing functional suites, see banner above

      const account = fixtures[role]
      const token = await tokenFor(account)
      const req = minimalReqFor(entry, token)
      const res = fakeRes()
      globalThis.fetch = async (url) => { throw new Error(`fetch must not be called for a role that should be rejected before any handler logic: ${url}`) }
      await handler(req, res)
      assert(
        res.statusCode === entry.wrongRoleStatus,
        `${entry.route}: role ${role} expected ${entry.wrongRoleStatus}, got ${res.statusCode}`,
      )
    }
  }
}

// --- Location Manager / Read Only: future (pending) behavior -------------
// These describe scoped access that literally cannot exist until the
// endpoint itself becomes location-aware. Recorded, not skipped.

function recordScopedRolePendingTests() {
  pending('location_manager: read assigned locations succeeds via /api/data', {
    expectedBehavior: 'GET /api/data?file=reviews/by-location/<assigned-slug>.json returns 200 for a location_manager whose locationIds include that location',
    milestone: 6,
    reason: '/api/data has zero location-awareness today -- ALLOWED_ROLES = [owner, marketing] rejects location_manager outright (403) regardless of which file is requested; there is no per-file location check to activate yet.',
  })
  pending('location_manager: unassigned location rejected with 404 (never 403)', {
    expectedBehavior: 'a location outside locationIds returns 404 (existence-hiding), matching the frozen API error contract (§6)',
    milestone: 6,
    reason: 'Same as above -- today the rejection is a blanket 403 at the role-gate, before any per-location check runs.',
  })
  pending('location_manager: reply only for assigned locations', {
    expectedBehavior: 'POST /api/google/publish succeeds for a review belonging to an assigned location and is rejected (404) for a review outside locationIds',
    milestone: 8,
    reason: 'publish.js has no location dimension today -- it is gated purely by ALLOWED_ROLES = [owner, marketing], which already rejects location_manager entirely (403) before any per-review location check could run. Requires Milestone 7\'s review->location lookup to exist first.',
  })
  pending('location_manager: export assigned-location data', {
    expectedBehavior: 'export (client-side CSV) is derivable only from data the account can view, i.e. assigned-location data once Milestone 6 lands',
    milestone: 6,
    reason: 'Export has no independent backend enforcement today (see the raw-data exports entry in the data-file registry) -- it inherits whatever /api/data returns, which is nothing for location_manager until Milestone 6.',
  })
  pending('location_manager: company-wide analytics containing other locations rejected', {
    expectedBehavior: 'any company-wide file (KPIs, rankings, trends, reports, company-wide intelligence) is rejected for location_manager even after Milestone 6 lands assigned-location access -- this is a PERMANENT rule, not a temporary gap',
    milestone: 6,
    reason: 'Cannot be distinguished from the blanket "location_manager can access nothing" rejection until Milestone 6 introduces file-category-aware checks; today all such requests already 403, but for the wrong reason (role gate, not category gate).',
  })
  pending('read_only: read assigned-location reviews and analytics', {
    expectedBehavior: 'GET /api/data for an assigned location\'s reviews/intelligence returns 200',
    milestone: 6,
    reason: 'Same blanket role-gate limitation as location_manager above.',
  })
  pending('read_only: unassigned location rejected with 404', {
    expectedBehavior: '404, never 403, for a location outside locationIds',
    milestone: 6,
    reason: 'Same as location_manager\'s unassigned-location pending case.',
  })
  pending('read_only: export controls hidden/disabled in the frontend', {
    expectedBehavior: 'read_only must never be able to export, even for assigned-location data it can otherwise view -- this is a PERMANENT distinction from location_manager (who does get EXPORT_ASSIGNED). RESOLVED ASSIGNMENT (Decision 3): since export is client-side-only with no backend enforcement point, this is owned by Milestone 9 (frontend role-aware UI), which must hide/disable CSV, print, download, or equivalent export controls for read_only specifically.',
    milestone: 9,
    reason: 'Cannot be exercised today because read_only cannot reach any data at all yet (blanket role-gate 403), and the frontend export controls (dashboard/src/utils/exportUtils.js callers) are not yet role-aware -- both preconditions land in Milestones 6 and 9 respectively.',
  })
}

// --- Error-contract normalization: pending target behavior ----------------
// Only UNRESOLVED exceptions are recorded as pending -- a resolved one
// (like ERROR_CONTRACT_EXCEPTION_1, fixed by Milestone 6A) must not still
// show up here, or the matrix would be lying about the current state of
// the codebase. Its activated test lives in SECTION 2/main() as an
// ordinary run(...) call now, not a pending(...) call.
function recordErrorContractPendingTests() {
  for (const exception of ERROR_CONTRACT_EXCEPTIONS) {
    if (exception.status === 'resolved') continue
    pending(`${exception.affects.join(' & ')}: authenticated-wrong-role caller returns 403, not ${exception.formerBehavior.split(' ')[0]}`, {
      expectedBehavior: exception.targetBehavior,
      milestone: exception.ownerMilestone,
      reason: `Current behavior is "${exception.formerBehavior}". ${exception.reasonNotFixedYet} Placement: ${exception.ownerMilestoneName} -- ${exception.ownerMilestonePlacement}`,
    })
  }
}

// --- Error-contract normalization: activated target-behavior test --------
// The activated replacement for the pending test that used to live here --
// ERROR_CONTRACT_EXCEPTION_1 is now resolved. Combines two checks in one
// test: (1) the registry itself is not stale (a resolved exception's
// referencing entries must show the corrected wrongRoleStatus, or the
// registry would be lying about current behavior), and (2) a live
// confirmation that the target 403 behavior actually landed at both
// affected endpoints. Full endpoint-level coverage (all four roles, both
// endpoints, response-shape/HTML checks, fail-closed checks on the new
// shared statusForAuthFailure() helper, and the unaffected successful-Owner
// path) lives in the dedicated tests/test_google_oauth_error_contract.js.
async function testResolvedOAuthExceptionEndpointsReturn403ForWrongRole() {
  const fixtures = await setDirectory()
  const resolvedExceptions = ERROR_CONTRACT_EXCEPTIONS.filter(e => e.status === 'resolved')
  assert(resolvedExceptions.length > 0, 'expected at least one resolved error-contract exception to verify')

  for (const exception of resolvedExceptions) {
    const referencingEntries = ENDPOINT_REGISTRY.filter(e => e.knownDefect === exception.id)
    assert(referencingEntries.length === exception.affects.length,
      `resolved exception ${exception.id} should still be referenced by exactly ${exception.affects.length} registry entries for historical context, found ${referencingEntries.length}`)

    for (const entry of referencingEntries) {
      assert(entry.wrongRoleStatus === 403, `${entry.route} references resolved exception ${exception.id} but its registry wrongRoleStatus is still ${entry.wrongRoleStatus} -- the registry is stale and must be updated to reflect the fix`)

      const handler = HANDLERS[entry.file]
      const token = await tokenFor(fixtures.marketing)
      const req = minimalReqFor(entry, token)
      const res = fakeRes()
      await handler(req, res)
      assert(res.statusCode === 403, `${entry.file}: authenticated Marketing must now return 403 (${exception.id} resolved by Milestone ${exception.resolvedByMilestone}), got ${res.statusCode}`)
    }
  }
}

// ===========================================================================
// SECTION 3 -- PERMISSION INVARIANTS (meta-tests over the registry itself)
// ===========================================================================

async function testEveryRolePermissionIsInCentralRegistry() {
  const validPermissions = new Set(Object.values(Permission))
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
    for (const p of perms) {
      assert(validPermissions.has(p), `ROLE_PERMISSIONS.${role} references "${p}", which is not a value in the Permission registry`)
    }
  }
}

async function testNoUnknownRoleReceivesAnyPermission() {
  for (const role of ['superadmin', 'guest', '', null, undefined, 'Owner', 'OWNER']) {
    for (const permission of Object.values(Permission)) {
      assert(roleHasPermission(role, permission) === false, `unknown/malformed role ${JSON.stringify(role)} must never receive ${permission}`)
    }
  }
}

async function testNoUnknownPermissionEverReturnsTrue() {
  for (const role of ROLES) {
    for (const permission of ['view_everything', 'reply_all', '', null, undefined, 'VIEW_ALL']) {
      assert(roleHasPermission(role, permission) === false, `role ${role} must never be granted unknown permission ${JSON.stringify(permission)}`)
    }
  }
}

async function testPermissionRegistryFrozen() {
  assert(Object.isFrozen(Permission), 'Permission must be frozen')
  assert(Object.isFrozen(ROLE_PERMISSIONS), 'ROLE_PERMISSIONS must be frozen')
}

// Every *_ASSIGNED permission has an unrestricted counterpart (REPLY vs
// REPLY_ASSIGNED, EXPORT vs EXPORT_ASSIGNED). No role should hold both the
// unrestricted and the assigned-only variant of the same capability unless
// that is an explicitly approved exception (none exist today).
const ASSIGNED_PAIRS = [
  [Permission.REPLY, Permission.REPLY_ASSIGNED],
  [Permission.EXPORT, Permission.EXPORT_ASSIGNED],
]
async function testNoRoleHasBothUnrestrictedAndAssignedVariant() {
  for (const role of ROLES) {
    for (const [unrestricted, assigned] of ASSIGNED_PAIRS) {
      const hasBoth = roleHasPermission(role, unrestricted) && roleHasPermission(role, assigned)
      assert(!hasBoth, `role ${role} holds both ${unrestricted} and ${assigned} -- no approved exception exists for this`)
    }
  }
}

async function testReadOnlyNeverReplyOrExport() {
  for (const p of [Permission.REPLY, Permission.REPLY_ASSIGNED, Permission.EXPORT, Permission.EXPORT_ASSIGNED]) {
    assert(roleHasPermission('read_only', p) === false, `read_only must never hold ${p}`)
  }
}

async function testLocationManagerNeverHasCompanyWideCapabilities() {
  for (const p of [Permission.VIEW_ALL, Permission.REPLY, Permission.EXPORT, Permission.CAMPAIGNS, Permission.ADMIN]) {
    assert(roleHasPermission('location_manager', p) === false, `location_manager must never hold ${p}`)
  }
}

async function testOwnerAndMarketingRetainApprovedUnrestrictedCapabilities() {
  for (const role of ['owner', 'marketing']) {
    for (const p of [Permission.VIEW_ALL, Permission.VIEW_ASSIGNED, Permission.REPLY, Permission.EXPORT, Permission.CAMPAIGNS]) {
      assert(roleHasPermission(role, p) === true, `${role} must retain ${p}`)
    }
  }
  assert(roleHasPermission('owner', Permission.ADMIN) === true, 'owner must retain ADMIN')
  assert(roleHasPermission('marketing', Permission.ADMIN) === false, 'marketing must never hold ADMIN')
}

// ===========================================================================
// SECTION 4 -- LOCATION-SCOPE INVARIANTS
// ===========================================================================

async function testWildcardGrantsAllValidLocationIds() {
  const account = { locationIds: '*' }
  for (const id of [1, 3, 7, 12, 9999, 1000000]) {
    assert(requireLocationAccess(account, id) === true, `wildcard must grant location ${id}`)
  }
}

async function testAssignedNumericIdsAllowed() {
  const account = { locationIds: [3, 7, 12] }
  for (const id of [3, 7, 12]) {
    assert(requireLocationAccess(account, id) === true, `assigned id ${id} must be allowed`)
  }
}

async function testUnassignedIdsDenied() {
  const account = { locationIds: [3, 7, 12] }
  for (const id of [1, 2, 4, 99, 0, -1]) {
    assert(requireLocationAccess(account, id) === false, `unassigned id ${id} must be denied`)
  }
}

async function testStringNumberMismatchDoesNotAccidentallyPass() {
  // account.locationIds are always numbers (accounts.js's validator rejects
  // anything else) -- Array.includes uses strict equality, so a string form
  // of an assigned id must NOT match. No normalization is designed or
  // implemented; this proves that's still true rather than silently
  // broadening what "matches" means.
  const account = { locationIds: [7] }
  assert(requireLocationAccess(account, '7') === false, 'string "7" must not match numeric 7 -- no implicit normalization exists')
  assert(requireLocationAccess(account, 7) === true, 'sanity: numeric 7 does match')
}

async function testMalformedLocationIdRequestedFailsClosed() {
  // The REQUESTED locationId being malformed (as opposed to the account
  // shape) safely returns false in every case -- Array.includes never
  // throws for these inputs, it simply never matches.
  const account = { locationIds: [3, 7, 12] }
  for (const badId of [null, undefined, NaN, 0, -1, {}, []]) {
    assert(requireLocationAccess(account, badId) === false, `requested locationId ${JSON.stringify(badId)} must fail closed (false), not match`)
  }
}

// RESOLVED (Decision 2, follow-up to Milestone 3): requireLocationAccess now
// fails closed -- returns false -- for every malformed account/locationIds
// shape below, instead of throwing a TypeError. This is a defensive
// correction to auth.js applied ONLY to this still-unused helper (no
// production endpoint calls it), so it changes no runtime endpoint
// behavior. Previously this suite documented the opposite (a throw) as a
// known gap; that gap is now closed and this test asserts the fixed
// behavior, not the old defect.
async function testMalformedAccountShapeFailsClosedNotThrows() {
  const shapesThatMustReturnFalse = [
    [null, 'account is null'],
    [undefined, 'account is undefined'],
    [{}, 'account missing locationIds entirely'],
    [{ locationIds: null }, 'locationIds is null'],
    [{ locationIds: undefined }, 'locationIds is undefined'],
    [{ locationIds: 0 }, 'locationIds is zero'],
    [{ locationIds: {} }, 'locationIds is a plain object'],
    [{ locationIds: 'all' }, 'locationIds is a non-"*" string'],
    [{ locationIds: [] }, 'locationIds is an empty array'],
    [{ locationIds: [null, undefined, 'x', {}] }, 'locationIds is an array of malformed values -- none may accidentally grant access'],
  ]
  for (const [account, label] of shapesThatMustReturnFalse) {
    let result
    let threw = false
    try {
      result = requireLocationAccess(account, 7)
    } catch (e) {
      threw = true
    }
    assert(!threw, `requireLocationAccess must never throw (${label}) -- it must fail closed instead`)
    assert(result === false, `requireLocationAccess must return false for ${label}, got ${JSON.stringify(result)}`)
  }

  // The two cases that must still WORK, unchanged, alongside the new
  // defensive checks: '*' remains unrestricted, and a valid array of
  // positive numeric ids continues to grant access to a matching id.
  assert(requireLocationAccess({ locationIds: '*' }, 7) === true, 'wildcard must remain unrestricted')
  assert(requireLocationAccess({ locationIds: [3, 7, 12] }, 7) === true, 'a valid array must still grant an assigned id')
  assert(requireLocationAccess({ locationIds: [3, 7, 12] }, 99) === false, 'a valid array must still deny an unassigned id')
}

// requireOwnership must retain identical fail-closed behavior purely
// through delegation to requireLocationAccess -- no independent logic to
// verify, just that the delegation itself doesn't reintroduce a throw.
async function testRequireOwnershipFailsClosedThroughDelegation() {
  for (const account of [null, undefined, {}, { locationIds: null }, { locationIds: 0 }, { locationIds: {} }]) {
    let threw = false
    let result
    try {
      result = requireOwnership(account, 7)
    } catch (e) {
      threw = true
    }
    assert(!threw, `requireOwnership must never throw for malformed account ${JSON.stringify(account)}`)
    assert(result === false, `requireOwnership must fail closed (false) for malformed account ${JSON.stringify(account)}`)
  }
  assert(requireOwnership({ locationIds: '*' }, 7) === true, 'requireOwnership wildcard passthrough must still work')
}

async function testRequireOwnershipEquivalentToRequireLocationAccess() {
  const cases = [
    [{ locationIds: '*' }, 42, true],
    [{ locationIds: [7] }, 7, true],
    [{ locationIds: [7] }, 8, false],
    [{ locationIds: [3, 7, 12] }, 12, true],
  ]
  for (const [account, locationId, expected] of cases) {
    assert(requireOwnership(account, locationId) === requireLocationAccess(account, locationId), 'requireOwnership must always agree with requireLocationAccess')
    assert(requireOwnership(account, locationId) === expected, `requireOwnership(${JSON.stringify(account)}, ${locationId}) expected ${expected}`)
  }
}

// ===========================================================================
// SECTION 5 -- ERROR CONTRACT (401 / 403 / 404 for requireScopedAuth)
//
// requireScopedAuth's full 401/403/404/success matrix is already exercised
// exhaustively in tests/test_permissions.js (testRequireScopedAuthUnauthenticated,
// testRequireScopedAuthPermissionDenied, testRequireScopedAuthLocationOutOfScopeReturns404,
// testRequireScopedAuthSucceedsInScope, testRequireScopedAuthSucceedsWithNoLocationScope)
// -- not duplicated here. This section instead confirms the same three
// status codes at the requireAuth() layer (the endpoint-facing gate every
// current production route actually uses), since that is the layer this
// milestone's endpoint registry describes.
//
// 400 (malformed request): covered by test_login.js (missing email/password)
// and test_endpoint_auth.js (trigger-import's confirm-phrase requirement).
// 429 (rate limit): covered by test_rate_limit.js.
// 500 (unexpected failure): covered by test_data_endpoint.js (corrupted
// JSON artifact -> safe 500).
// ===========================================================================

async function testErrorContract401ForNoIdentity() {
  await setDirectory()
  const res = fakeRes()
  const account = await requireAuth({ headers: {} }, res, ['owner'])
  assert(account === null && res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testErrorContract403ForWrongCapability() {
  const fixtures = await setDirectory()
  const token = await tokenFor(fixtures.marketing)
  const res = fakeRes()
  const account = await requireAuth({ headers: { cookie: `lta_session=${token}` } }, res, ['owner'])
  assert(account === null && res.statusCode === 403, `expected 403 for an authenticated-but-wrong-role caller, got ${res.statusCode}`)
}

async function testErrorContract404ReservedForLocationScopeOnly() {
  // requireAuth itself has no concept of location scope -- it only ever
  // produces 401/403. 404-for-out-of-scope-location is exclusively
  // requireScopedAuth's behavior (see test_permissions.js), confirming the
  // two layers don't overlap in what error codes they can produce.
  const fixtures = await setDirectory()
  const token = await tokenFor(fixtures.location_manager)
  const res = fakeRes()
  const account = await requireAuth({ headers: { cookie: `lta_session=${token}` } }, res, ['owner'])
  assert(account === null, 'location_manager must be rejected from an owner-only route')
  assert(res.statusCode === 403, `requireAuth must never produce 404 on its own -- expected 403, got ${res.statusCode}`)
}

// ===========================================================================
// SECTION 6 -- ENDPOINT REGISTRY SCANNER (protection against future
// unregistered endpoints)
//
// DISCOVERY RULE (documented so a future reader can judge false positives):
//   A file under dashboard/api/** counts as a standalone, routable endpoint
//   if and only if:
//     1. it has a .js extension, AND
//     2. no path segment in its relative path is exactly "_lib" (excludes
//        both dashboard/api/_lib/** and dashboard/api/google/_lib/**, the
//        two current non-route helper directories), AND
//     3. its source contains a top-level "export default" (Vercel's
//        file-based routing convention: a route file's default export is
//        the handler function). This excludes any future shared,
//        non-"_lib"-named support file that isn't itself an endpoint.
//   Test fixtures are irrelevant to this rule because it only ever walks
//   dashboard/api/**, never tests/**.
// ===========================================================================

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

async function testEndpointRegistryScannerCatchesUnregisteredEndpoints() {
  const discovered = new Set(discoverEndpointFiles(API_DIR).map(f => `api/${f}`))
  const registered = new Set(ENDPOINT_REGISTRY.map(e => e.file))

  const unregistered = [...discovered].filter(f => !registered.has(f))
  assert(unregistered.length === 0, `found production endpoint file(s) with no ENDPOINT_REGISTRY entry: ${unregistered.join(', ')} -- add an entry before this can pass`)

  const registeredButGone = [...registered].filter(f => !discovered.has(f))
  assert(registeredButGone.length === 0, `ENDPOINT_REGISTRY references file(s) that no longer exist: ${registeredButGone.join(', ')}`)
}

async function testDiscoveryRuleExcludesLibAndNonHandlerFiles() {
  // Unit-tests the discovery predicate's exclusion logic directly, using
  // the real _lib directories (which must yield nothing) plus a check that
  // every currently-discovered file really does have export default.
  const libFiles = discoverEndpointFiles(path.join(API_DIR, '_lib'))
  assert(libFiles.length === 0, '_lib files must never be discovered as endpoints')

  const googleLibFiles = discoverEndpointFiles(path.join(API_DIR, 'google', '_lib'))
  assert(googleLibFiles.length === 0, 'google/_lib files must never be discovered as endpoints')

  const discovered = discoverEndpointFiles(API_DIR)
  assert(discovered.length === ENDPOINT_REGISTRY.reduce((set, e) => set.add(e.file), new Set()).size,
    `discovered ${discovered.length} endpoint files but the registry covers ${new Set(ENDPOINT_REGISTRY.map(e => e.file)).size} unique files`)
}

// Decision 1's requirement made mechanical: a `knownDefect` reference on an
// ENDPOINT_REGISTRY entry must always resolve to a real, fully-specified
// entry in ERROR_CONTRACT_EXCEPTIONS (id, current/target behavior, and an
// owning milestone) -- so a tracked exception can never quietly lose its
// owner if the registry is edited later.
async function testEveryKnownDefectIsTrackedWithAnOwner() {
  const exceptionIds = new Set(ERROR_CONTRACT_EXCEPTIONS.map(e => e.id))
  for (const entry of ENDPOINT_REGISTRY) {
    if (!entry.knownDefect) continue
    assert(exceptionIds.has(entry.knownDefect), `${entry.route} references unknown defect id "${entry.knownDefect}" -- no matching ERROR_CONTRACT_EXCEPTIONS entry`)
  }
  for (const exception of ERROR_CONTRACT_EXCEPTIONS) {
    assert(exception.status === 'resolved' || exception.ownerMilestone,
      `exception ${exception.id} has no ownerMilestone -- every open tracked exception must be assigned, never left unowned`)
    assert(exception.status !== 'resolved' || exception.resolvedByMilestone,
      `resolved exception ${exception.id} must record which milestone resolved it`)
    const behaviorBefore = exception.status === 'resolved' ? exception.formerBehavior : exception.currentBehavior
    assert(behaviorBefore && exception.targetBehavior, `exception ${exception.id} must document both its former/current and target behavior`)
    const referencingEntries = ENDPOINT_REGISTRY.filter(e => e.knownDefect === exception.id)
    assert(referencingEntries.length === exception.affects.length, `exception ${exception.id} claims to affect ${exception.affects.length} file(s) but ${referencingEntries.length} registry entries reference it`)
  }
}

// ===========================================================================
// SECTION 7 -- DATA-FILE AUTHORIZATION REGISTRY
// ===========================================================================

// Extract the real allowlist entries directly from data.js's source text
// (not hand-copied) so this registry's coverage claim can't silently drift
// from the actual production allowlist. No import of internal, unexported
// consts is possible (EXACT_ALLOWLIST/DYNAMIC_ALLOWLIST are module-private
// by design), so this is a static-source check, the same technique
// test_oauth_safety.js and test_permissions.js already use elsewhere.
function extractExactAllowlist() {
  const source = readFileSync(path.join(API_DIR, 'data.js'), 'utf-8')
  const match = source.match(/EXACT_ALLOWLIST = new Set\(\[([\s\S]*?)\]\)/)
  assert(match, 'could not find EXACT_ALLOWLIST in data.js -- has its shape changed?')
  return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1])
}

// Extracts the literal path PREFIX (the part before ${SLUG}) out of each
// `new RegExp(\`^prefix${SLUG}\.json$\`)` entry in DYNAMIC_ALLOWLIST, e.g.
// 'insights/${SLUG}\\.json$' -> 'insights/'. Lets the dynamic-pattern side
// of the registry be cross-checked with the same exactness as the literal
// EXACT_ALLOWLIST side, instead of being taken on faith.
function extractDynamicAllowlistPrefixes() {
  const source = readFileSync(path.join(API_DIR, 'data.js'), 'utf-8')
  const match = source.match(/DYNAMIC_ALLOWLIST = \[([\s\S]*?)\n\]/)
  assert(match, 'could not find DYNAMIC_ALLOWLIST in data.js -- has its shape changed?')
  const prefixes = [...match[1].matchAll(/new RegExp\(`\^([a-zA-Z0-9/_-]*)\$\{SLUG\}/g)].map(m => m[1])
  assert(prefixes.length === 3, `expected 3 DYNAMIC_ALLOWLIST patterns, found ${prefixes.length} -- registry's dynamic categories need re-review`)
  return prefixes
}

// (Decision 4 follow-up) Exact, mechanical cross-check: the union of every
// DATA_FILE_REGISTRY category's `files` array (for non-dynamic categories)
// must equal EXACT_ALLOWLIST exactly -- no allowlisted file missing from
// the registry, no registry file that isn't really allowlisted, and no file
// claimed by two categories at once. Dynamic categories are checked
// separately, by prefix, against DYNAMIC_ALLOWLIST.
async function testDataFileRegistryCoversEveryAllowlistedFileExactly() {
  const exact = new Set(extractExactAllowlist())
  const dynamicPrefixes = new Set(extractDynamicAllowlistPrefixes())

  const registryExactFiles = []
  const registryDynamicPrefixes = []
  for (const category of DATA_FILE_REGISTRY) {
    for (const f of category.files) {
      if (category.dynamic) registryDynamicPrefixes.push(f)
      else registryExactFiles.push(f)
    }
  }

  // No duplicates across categories (a file claimed by two categories at
  // once would hide an ambiguity in per-role treatment).
  const seen = new Set()
  for (const f of registryExactFiles) {
    assert(!seen.has(f), `"${f}" appears in more than one DATA_FILE_REGISTRY category`)
    seen.add(f)
  }

  const missingFromRegistry = [...exact].filter(f => !seen.has(f))
  assert(missingFromRegistry.length === 0, `allowlisted file(s) not present in any DATA_FILE_REGISTRY category: ${missingFromRegistry.join(', ')}`)

  const registryFilesNotReallyAllowlisted = registryExactFiles.filter(f => !exact.has(f))
  assert(registryFilesNotReallyAllowlisted.length === 0, `DATA_FILE_REGISTRY lists file(s) that are not actually in data.js's EXACT_ALLOWLIST: ${registryFilesNotReallyAllowlisted.join(', ')}`)

  // Dynamic side: every real DYNAMIC_ALLOWLIST prefix must be claimed by
  // exactly one registry category, and vice versa.
  const missingDynamicPrefixes = [...dynamicPrefixes].filter(p => !registryDynamicPrefixes.includes(p))
  assert(missingDynamicPrefixes.length === 0, `DYNAMIC_ALLOWLIST prefix(es) not represented in the registry: ${missingDynamicPrefixes.join(', ')}`)
  const extraDynamicPrefixes = registryDynamicPrefixes.filter(p => !dynamicPrefixes.has(p))
  assert(extraDynamicPrefixes.length === 0, `registry claims dynamic prefix(es) that data.js's DYNAMIC_ALLOWLIST does not actually have: ${extraDynamicPrefixes.join(', ')}`)
}

function pendingReviewToLocationLookupGuard() {
  pending('review-to-location internal lookup file is never added to the public /api/data allowlist', {
    expectedBehavior: 'once Milestone 7 creates the review->location lookup file, a test must assert (by its real filename) that it never appears in data.js\'s EXACT_ALLOWLIST or matches any DYNAMIC_ALLOWLIST pattern, for any role including Owner',
    milestone: 7,
    reason: 'the file does not exist yet -- there is nothing to name or assert against until Milestone 7 creates it. This entry is the placeholder commitment that the guard test will be written then, not skipped.',
  })
}

async function testCurrentAllowlistHasNoPerRoleOrPerLocationLogic() {
  // Confirms today's actual mechanism: data.js's gate is a single flat
  // ALLOWED_ROLES check with ZERO per-file, per-role, or per-location
  // branching -- which is exactly why every scoped-role data-file category
  // above is "pending" rather than partially active.
  const source = readFileSync(path.join(API_DIR, 'data.js'), 'utf-8')
  assert(/const ALLOWED_ROLES = \['owner', 'marketing'\]/.test(source), 'data.js\'s role gate must still be the flat owner/marketing allow-list this milestone assumes -- if this changed, the data-file registry\'s "pending" statuses need re-review')
  assert(!/locationIds/.test(source), 'data.js must not yet reference locationIds anywhere -- if it does, location filtering has begun and this registry is stale')
}

// ===========================================================================
// SECTION 7B -- MILESTONE 5 (per-location analytics export, no auth change)
//
// These are NEW ACTIVE tests, not previously-pending tests being flipped on:
// none of the 10 pending role/endpoint tests recorded in SECTIONS 2/7 above
// have their prerequisites satisfied by Milestone 5 (it makes zero
// endpoint/authorization changes) -- they remain exactly as pending as
// before. What IS newly verifiable today is that the export pipeline's
// output now includes the per-location analytics artifact, and that
// dashboard/api/data.js is completely unaware of it (proving /api/data's
// behavior is unchanged and confirming the pending statuses above are
// still correct).
// ===========================================================================

async function testMilestone5PerLocationAnalyticsArtifactExistsInExportPipeline() {
  const exportSrc = readFileSync(path.join(REPO_ROOT, 'export_chunks.py'), 'utf-8')
  assert(/def export_location_analytics\(/.test(exportSrc), 'export_chunks.py must define export_location_analytics()')
  assert(/analytics\/locations\/\{loc_id\}\.json/.test(exportSrc), 'export_location_analytics() must write to analytics/locations/<locationId>.json')
  assert(/def validate_location_analytics\(/.test(exportSrc), 'export_chunks.py must define validate_location_analytics() (Milestone 5 integrity checks)')

  const analyticsSrc = readFileSync(path.join(REPO_ROOT, 'refresh_analytics.py'), 'utf-8')
  assert(/analytics_location_\{loc_id\}/.test(analyticsSrc), 'refresh_analytics.py must compute a per-location analytics_location_<id> cache entry')
  assert(/build_department_summary\(loc_intel\)/.test(analyticsSrc), 'the per-location artifact must reuse build_department_summary() (the same shared function company-wide department_performance uses), not a duplicated calculation')
}

async function testAnalyticsLocationsArtifactExistsButNotYetServedByApiData() {
  // The other half of the story above: the new export artifact exists, but
  // dashboard/api/data.js (the only endpoint that could ever serve it) has
  // not changed at all -- confirms /api/data's behavior is unchanged by
  // Milestone 5, and that the DATA_FILE_REGISTRY's "not yet reachable via
  // any endpoint" wording for per-location analytics/trends is accurate,
  // not stale.
  const dataJsSrc = readFileSync(path.join(API_DIR, 'data.js'), 'utf-8')
  assert(!/analytics\/locations/.test(dataJsSrc), 'data.js must not yet reference analytics/locations/ -- if it does, Milestone 6 has started and this test/registry needs updating, not this milestone')
  assert(/const ALLOWED_ROLES = \['owner', 'marketing'\]/.test(dataJsSrc), 'data.js\'s role gate must still be exactly what it was before Milestone 5')
}

// ===========================================================================
// SECTION 8 -- EXISTING BEHAVIOR PRESERVATION
// ===========================================================================

async function testRequireAuthSourceUnchanged() {
  const authSrc = readFileSync(path.join(DASHBOARD_DIR, 'api', '_lib', 'auth.js'), 'utf-8')
  const fnMatch = authSrc.match(/export async function requireAuth\(req, res, allowedRoles\) \{[\s\S]*?\n\}/)
  assert(fnMatch, 'requireAuth function body must still be present with the expected signature')
  const body = fnMatch[0]
  assert(body.includes(`res.status(403).json({ error: 'forbidden', message: 'You do not have permission to perform this action.' })`), 'requireAuth forbidden branch unchanged')
  assert(body.includes(`res.status(401).json({ error: 'session_expired', message: 'Your session is no longer valid. Please sign in again.' })`), 'requireAuth session_expired branch unchanged')
  assert(body.includes(`res.status(401).json({ error: 'unauthenticated', message: 'Sign in required.' })`), 'requireAuth unauthenticated branch unchanged')
}

async function testNoProductionEndpointImportsTheNewHelpers() {
  const offenders = []
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '_lib') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.js')) continue
      const src = readFileSync(full, 'utf-8')
      if (/\brequireScopedAuth\b|\brequireOwnership\b|\brequireLocationAccess\b/.test(src)) offenders.push(full)
    }
  }
  walk(API_DIR)
  assert(offenders.length === 0, `no production endpoint may import the Milestone 2 helpers yet, found: ${offenders.join(', ')}`)
}

async function testMiddlewareAndSessionFilesUntouchedByThisMilestone() {
  // Structural sanity check, not a git diff -- confirms these files still
  // use the same accountStore-based pattern from Milestone 1/2 and have not
  // grown any reference to the new authorization helpers.
  const middlewareSrc = readFileSync(path.join(DASHBOARD_DIR, 'middleware.js'), 'utf-8')
  const sessionSrc = readFileSync(path.join(API_DIR, 'session', '[action].js'), 'utf-8')
  for (const [name, src] of [['middleware.js', middlewareSrc], ['session/[action].js', sessionSrc]]) {
    assert(!/requireScopedAuth|requireOwnership|requireLocationAccess/.test(src), `${name} must not reference the new Milestone 2 helpers`)
  }
}

async function testAllFixtureAccountsAreObviouslyFake() {
  // Milestone 3 must use fixture accounts only. A light structural guard:
  // every fixture email in this file's own directory-builder uses the
  // example.com reserved domain (RFC 2606), never a real domain.
  const fixtures = await setDirectory()
  for (const account of Object.values(fixtures)) {
    assert(account.email.endsWith('@example.com'), `fixture account ${account.userId} must use a reserved example.com email, got ${account.email}`)
  }
}

// ===========================================================================

async function main() {
  console.log('--- SECTION 1: Authentication baseline ---')
  await run('unauthenticated protected request -> 401', testUnauthenticatedProtectedRequestReturns401)
  await run('invalid/malformed session -> 401', testInvalidSessionReturns401)
  await run('expired session -> 401', testExpiredSessionReturns401)
  await run('disabled account -> rejected (401)', testDisabledAccountRejected)
  await run('sessionVersion mismatch -> rejected (401 session_expired)', testSessionVersionMismatchRejected)
  await run('valid account re-resolves role/locationIds from the authoritative store, not the token', testValidAccountReResolvesFromAuthoritativeStore)
  await run('no authorization claim is trusted permanently from the session token', testNoClaimTrustedPermanentlyFromToken)

  console.log('\n--- SECTION 2: Role matrix ---')
  await run('every endpoint denies every role not in its current allow-list (403)', testRoleMatrixDeniesEveryNonAllowedRole)
  await run('[RESOLVED, Milestone 6A] OAuth endpoints (auth.js/callback.js) return 403 for authenticated wrong-role, not 401 -- registry is not stale', testResolvedOAuthExceptionEndpointsReturn403ForWrongRole)
  recordScopedRolePendingTests()
  recordErrorContractPendingTests()

  console.log('\n--- SECTION 3: Permission invariants ---')
  await run('every role references only permissions defined in the central Permission registry', testEveryRolePermissionIsInCentralRegistry)
  await run('no unknown/malformed role ever receives a permission', testNoUnknownRoleReceivesAnyPermission)
  await run('no unknown permission string ever returns true for any role', testNoUnknownPermissionEverReturnsTrue)
  await run('Permission and ROLE_PERMISSIONS are frozen', testPermissionRegistryFrozen)
  await run('no role holds both an unrestricted and its assigned-only variant', testNoRoleHasBothUnrestrictedAndAssignedVariant)
  await run('read_only never receives reply or export (unrestricted or assigned)', testReadOnlyNeverReplyOrExport)
  await run('location_manager never receives view_all, reply, export, campaigns, or admin', testLocationManagerNeverHasCompanyWideCapabilities)
  await run('owner and marketing retain their approved unrestricted capabilities', testOwnerAndMarketingRetainApprovedUnrestrictedCapabilities)

  console.log('\n--- SECTION 4: Location-scope invariants ---')
  await run('wildcard locationIds grants all valid location ids', testWildcardGrantsAllValidLocationIds)
  await run('assigned numeric ids allowed', testAssignedNumericIdsAllowed)
  await run('unassigned ids denied', testUnassignedIdsDenied)
  await run('string/number mismatch does not accidentally pass (no implicit normalization)', testStringNumberMismatchDoesNotAccidentallyPass)
  await run('malformed requested locationId (null/undefined/NaN/0/negative/object/array) fails closed', testMalformedLocationIdRequestedFailsClosed)
  await run('[RESOLVED, Decision 2] malformed account.locationIds shape fails closed (false), never throws', testMalformedAccountShapeFailsClosedNotThrows)
  await run('requireOwnership fails closed identically to requireLocationAccess through delegation', testRequireOwnershipFailsClosedThroughDelegation)
  await run('requireOwnership stays behaviorally identical to requireLocationAccess', testRequireOwnershipEquivalentToRequireLocationAccess)

  console.log('\n--- SECTION 5: Error contract (401/403/404) ---')
  await run('401 for no identity at all', testErrorContract401ForNoIdentity)
  await run('403 for authenticated account lacking the required role/capability', testErrorContract403ForWrongCapability)
  await run('requireAuth never produces 404 -- that is exclusively requireScopedAuth\'s domain', testErrorContract404ReservedForLocationScopeOnly)

  console.log('\n--- SECTION 6: Endpoint registry scanner ---')
  await run('every discovered production endpoint file has a registry entry, and vice versa', testEndpointRegistryScannerCatchesUnregisteredEndpoints)
  await run('discovery rule correctly excludes _lib files and only counts real handler files', testDiscoveryRuleExcludesLibAndNonHandlerFiles)
  await run('every tracked error-contract exception (knownDefect) has a real, owned ERROR_CONTRACT_EXCEPTIONS entry', testEveryKnownDefectIsTrackedWithAnOwner)

  console.log('\n--- SECTION 7: Data-file authorization registry ---')
  await run('every allowlisted data file (exact + dynamic) maps to exactly one registry category, with none missing or invented', testDataFileRegistryCoversEveryAllowlistedFileExactly)
  await run('/api/data\'s current gate has zero per-role or per-location logic (confirms every "pending" status above)', testCurrentAllowlistHasNoPerRoleOrPerLocationLogic)
  pendingReviewToLocationLookupGuard()

  console.log('\n--- SECTION 7B: Milestone 5 (per-location analytics export) ---')
  await run('per-location analytics artifact now exists in the export pipeline (export_chunks.py + refresh_analytics.py)', testMilestone5PerLocationAnalyticsArtifactExistsInExportPipeline)
  await run('the new artifact is not yet served by /api/data -- data.js is unchanged', testAnalyticsLocationsArtifactExistsButNotYetServedByApiData)

  console.log('\n--- SECTION 8: Existing behavior preservation ---')
  await run('requireAuth() source is unchanged', testRequireAuthSourceUnchanged)
  await run('no production endpoint imports requireScopedAuth/requireOwnership/requireLocationAccess', testNoProductionEndpointImportsTheNewHelpers)
  await run('middleware.js and session/[action].js reference none of the new helpers', testMiddlewareAndSessionFilesUntouchedByThisMilestone)
  await run('all fixture accounts use the reserved example.com domain (never a real account)', testAllFixtureAccountsAreObviouslyFake)

  console.log('\n--- PENDING SUMMARY (grouped by activating milestone) ---')
  const byMilestone = {}
  for (const p of pendingResults) {
    byMilestone[p.milestone] = byMilestone[p.milestone] || []
    byMilestone[p.milestone].push(p.name)
  }
  // Milestone labels are a mix of plain numbers (5, 6, 7, 8, 9) and
  // sub-milestone strings (e.g. "6A") -- sort numerically first, with a
  // lettered sub-milestone immediately after its base number.
  for (const milestone of Object.keys(byMilestone).sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b))) {
    console.log(`  Milestone ${milestone}: ${byMilestone[milestone].length} pending`)
    for (const name of byMilestone[milestone]) console.log(`    - ${name}`)
  }

  console.log()
  console.log(`ACTIVE: ${results.length} tests run, ${results.filter(Boolean).length} passed, ${results.filter(r => !r).length} failed`)
  console.log(`PENDING: ${pendingResults.length} explicitly recorded (not counted as pass/fail)`)

  if (results.every(Boolean)) {
    console.log(`\nALL ${results.length} ACTIVE TESTS PASSED`)
    process.exit(0)
  }
  console.log(`\n${results.filter(r => !r).length} of ${results.length} ACTIVE TESTS FAILED`)
  process.exit(1)
}

main()
