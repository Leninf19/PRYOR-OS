# Los Tres Amigos Review Intelligence Dashboard

A Google Business Profile review intelligence platform for a 21-location, 5-brand Mexican restaurant group (Los Tres Amigos, Los Tres Mex Grill, Mi Lindo San Blas, Rio Luna, Casa Tequila). A Python pipeline scrapes and classifies reviews on a schedule; a static React dashboard (deployed on Vercel) reads the precomputed results.

## Architecture overview

Two halves that only communicate through `dashboard/reviews.db` and the static JSON it gets exported to:

1. **Data pipeline** (root, Python, runs on GitHub Actions) — scrapes Google reviews, classifies them, computes every score/metric the dashboard shows, and exports the results as static JSON.
2. **Dashboard** (`dashboard/`, Vite + React + Tailwind) — a static SPA that fetches those JSON files. It has no database connection and no server-side rendering; the only server-side code it ships is a handful of Vercel serverless functions in `dashboard/api/` for things that must happen live (AI rewrite-on-demand, Google OAuth).

There is no multi-tenant auth: this is a single-account app for one restaurant group's own reviews.

## Data pipeline

Runs roughly every 6 hours via `.github/workflows/update-reviews.yml`, in this order:

1. **`gbp_sync.py`** — syncs reviews via the official Google Business Profile API (`google_api.py`), auto-discovering locations and upserting into `dashboard/reviews.db` via `db.py`'s shared schema/dedup layer. Replaces the old Playwright scraper as the active sync path — see "Google Business Profile integration" below.
2. **`validate.py`** — flags data-quality issues (missing fields, suspicious duplicates) into the `validation_flags` table.
3. **`refresh_analytics.py`** — the core analytics engine. Computes everything the dashboard displays (see "How scores are calculated" below) and writes it into the `analytics_cache` table.
4. **`notify.py`** — sends alert emails for scraper/sync failures, per-location rating drops, and structural data bugs. (New low-star reviews have their own dedicated alerting now — see below — so they're no longer part of this email.)
5. **`export_chunks.py`** — reads `analytics_cache` (and raw review rows) and writes small, purpose-built JSON files into `dashboard/public/data/` — this is the only thing the frontend ever reads.
6. The workflow commits `dashboard/reviews.db` + `dashboard/reviews.csv` back to the repo (see "Known limitations" — this is how state survives between ephemeral CI runs) and deploys the built dashboard to Vercel directly from this same workflow.

Independent workflows:
- **`.github/workflows/critical-alert-check.yml`** (every ~15 min) — runs `critical_alert_check.py`: a fast partial sync + incremental AI classification + an immediate email the moment an unanswered review is AI-classified `critical` (food safety, injury, discrimination, legal/violence concerns). Doesn't wait for the nightly digest.
- **`.github/workflows/nightly-digest.yml`** (~10pm America/New_York, DST-safe) — runs `nightly_digest.py`: one email covering every new, *meaningful* 1-2★ review (see "Google Business Profile integration" below for the exact filtering rules).
- **`.github/workflows/health-check.yml`** (daily) — runs `health_check.py` as an independent watchdog, so a problem is still caught even if the 6-hourly workflow's trigger stops firing entirely.
- **`.github/workflows/weekly-report.yml`** (Mondays) — runs `weekly_report.py`, emails a summary.
- **`.github/workflows/deploy-frontend.yml`** — redeploys the dashboard on any push to `dashboard/**` (excluding the DB/CSV, which have their own commit path above).

`migrate_csv_to_sqlite.py` and `merge_scraped.py` are one-off/manual maintenance scripts, not part of the scheduled pipeline. `scripts/legacy/` holds older scraping scripts that predate the current `db.py` pipeline and aren't referenced by anything live — kept for reference, not run. **`auto_update.py`** (the original Playwright scraper) is likewise kept in the repo as a dormant manual fallback — not wired into any workflow — in case the Google API path is ever unavailable; run it by hand (`python auto_update.py`) if needed.

## AI pipeline

Two different patterns, used for different reasons:

- **Batch, server-side, cached** (`ai_engine.py`) — runs during the pipeline (`refresh_analytics.py`/`backfill_sentiment.py`), classifies review sentiment/priority and generates summaries/response drafts. Results are cached by content hash (`db.py::review_content_hash`) so unchanged reviews are never re-sent to the API. Falls back to star-based heuristics everywhere if `ANTHROPIC_API_KEY` isn't set — nothing in the dashboard hard-requires AI to function.
- **Live, client-triggered** (`dashboard/api/rewrite.js`, `dashboard/api/executive-brief.js`) — Vercel serverless functions the browser calls directly (no SDK, plain `fetch` to `https://api.anthropic.com/v1/messages`) for things that need to react to the user's current filter selection rather than the last pipeline run: response tone-rewriting and the live executive briefing.

## Folder structure

```
├── gbp_sync.py               # active review sync (Google Business Profile API)
├── google_api.py              # GBP API v4 client: accounts/locations/reviews/reply, pagination, backoff
├── gbp_import.py              # one-time historical import/reconciliation (gated, see below)
├── validate.py, refresh_analytics.py,   # pipeline stages, run in this order
│   notify.py, export_chunks.py
├── digest_filters.py           # shared "is this meaningful/critical" logic
├── critical_alert_check.py     # ~15min immediate critical-review alert
├── nightly_digest.py           # ~10pm ET nightly low-star digest
├── auto_update.py              # dormant Playwright-scraper fallback (not scheduled)
├── db.py                     # shared SQLite schema + upsert/dedup logic
├── ai_engine.py               # batch AI classification/summaries/drafts
├── health_check.py, weekly_report.py   # independent scheduled watchdogs
├── migrate_csv_to_sqlite.py, merge_scraped.py   # one-off/manual maintenance
├── set_location_contacts.py    # admin tool: restaurant contact-email config (see below)
├── scripts/legacy/             # pre-pipeline scraping scripts, kept for reference only
├── requirements.txt
├── .github/workflows/          # update-reviews, critical-alert-check, nightly-digest,
│                                # health-check, weekly-report, deploy-frontend
└── dashboard/
    ├── reviews.db, reviews.csv   # committed pipeline state (see Known limitations)
    ├── api/google/               # Vercel serverless functions: OAuth, status, publish,
    │                             # test-connection, trigger-sync (see below)
    ├── api/actions/[action].js   # Action Accountability Store: GET list / POST update (see above)
    ├── public/data/              # static JSON the SPA fetches — export_chunks.py's output
    └── src/
        ├── pages/                # one file per route
        ├── components/ui/        # shared design-system primitives
        ├── hooks/                # React Query hooks, one per data source
        └── utils/                # textAnalysis.js (category mirror of refresh_analytics.py), dataUtils.js
```

## Environment variables / secrets

| Variable | Where it's used | Where it's set |
|---|---|---|
| `ANTHROPIC_API_KEY` | `ai_engine.py` (batch), `dashboard/api/rewrite.js`, `dashboard/api/executive-brief.js` (live) | GitHub Actions secret **and** Vercel project env var (the live functions run on Vercel, not CI) |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | `notify.py`, `health_check.py`, `weekly_report.py`, `critical_alert_check.py`, `nightly_digest.py` (batch only) | GitHub Actions secrets only — this mailbox is unrelated to the restaurant bad-review email workflow below, which uses its own separate mailbox and its own `SMTP_*` variables. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM_NAME` | `dashboard/api/_lib/emailSender.js` (live, restaurant bad-review email workflow) | Vercel project env var (the live send runs on Vercel, not CI — see "Restaurant Bad-Review Email Workflow" below). `SMTP_HOST` / `SMTP_USER` / `SMTP_PASSWORD` are **mandatory**; `SMTP_PORT` / `SMTP_SECURE` / `SMTP_FROM_NAME` are optional with safe defaults. |
| `REVIEW_ESCALATION_CC_EMAILS` / `REVIEW_REPLY_TO_EMAIL` / `DASHBOARD_BASE_URL` | `dashboard/api/_lib/reviewEmailConfig.js` / `actions/[action].js` (restaurant bad-review email workflow) | Vercel project env vars — see "Restaurant Bad-Review Email Workflow" below. `REVIEW_ESCALATION_CC_EMAILS` is **mandatory** (an empty/unset CC list fails the send closed, 503); the other two are optional with safe defaults. |
| `VERCEL_TOKEN` | CI's own `vercel --prod` deploy step | GitHub Actions secret |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | `dashboard/api/google/[action].js` (OAuth, status, publish, test-connection) **and** `google_api.py` (`gbp_sync.py`, `gbp_import.py`, `critical_alert_check.py`) | **Both** Vercel project env vars **and** GitHub Actions secrets — same two values, set in two places (the OAuth app's own identity, not a per-connection credential). |
| `GOOGLE_REFRESH_TOKEN` | `google_api.py`'s fallback path only (Phase 8, Milestone 8.7/8.8 — the live refresh token now lives in the Redis-backed credential store; see "Refresh token generation" below) | GitHub Actions secret only, kept as a permanent fallback for the scheduled Python workflows. No longer read by any Vercel function — safe to remove from Vercel once the credential-store migration is verified stable. |
| `CREDENTIAL_ENCRYPTION_KEY` | `dashboard/api/_lib/credentialStore.js` (AES-256-GCM key for the Redis-stored refresh token) **and** `google_api.py` (decrypts the same value read from Redis) | **Both** a Vercel project env var **and** a GitHub Actions secret — same value in both places, same reasoning as `UPSTASH_REDIS_REST_URL`/`_TOKEN` below. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` (same method as `SESSION_SIGNING_SECRET`) — any sufficiently-random string works, it's SHA-256'd into a proper 32-byte AES key internally. |
| `VERCEL_API_TOKEN` / `VERCEL_PROJECT_ID` / `VERCEL_ORG_ID` / `VERCEL_DEPLOY_HOOK_URL` | `dashboard/api/google/_lib/vercel.js` (`upsertEnvVar`/`triggerRedeploy`) — legacy, no longer called by the active connect/reconnect flow; kept only as a manual rollback escape hatch | Vercel project env vars, if you choose to keep them configured for the rollback path. `VERCEL_API_TOKEN` is a personal/team API token scoped to env-var write access — distinct from the GitHub Actions secret of a similar name (`VERCEL_TOKEN`), do not confuse the two. |
| `GITHUB_SYNC_PAT` | `dashboard/api/google/trigger-sync.js` (the Settings → Connection Center "Sync Now" button) | Vercel project env var — a GitHub personal access token with `workflow` scope, used only to dispatch `update-reviews.yml` on demand. |
| `SESSION_SIGNING_SECRET` | `dashboard/api/_lib/session.js` (session cookie signing/verification, Edge + Node) | Vercel project env var. A dedicated, high-entropy secret (32+ characters) — generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`. Never reuse another secret for this. |
| `ACCOUNT_DIRECTORY_JSON` | `dashboard/api/_lib/accounts.js` (account directory — see "Authentication & authorization" below) | Vercel project env var. A JSON string; see schema below. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | `dashboard/api/_lib/rateLimit.js`, `actionStore.js`, `contactStore.js`, `auditLog.js`, `credentialStore.js` (all Vercel-side) **and** `google_api.py` (GitHub Actions, Milestone 8.8 — reads the live Google credential) | Vercel project env var, auto-populated if you add the Upstash Redis integration via the Vercel Marketplace — strongly recommended (see "Rate limiting" below for what happens if unset on Vercel). **Also** add as GitHub Actions secrets (same values) so the scheduled Python pipeline can read the live Google connection instead of only the `GOOGLE_REFRESH_TOKEN` fallback — a one-time setup, see "Refresh token generation" below. |

`VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` used by the GitHub Actions deploy step are not secret and are hardcoded directly in the workflow YAML files — this is unrelated to the same-named Vercel env vars above (those are read at runtime by `callback.js`, not by CI).

## Authentication & authorization (Phase 1)

Every write-capable and sensitive-data endpoint requires a signed session cookie (`lta_session`) tied to an account in `ACCOUNT_DIRECTORY_JSON`. This replaces the previous state where every `dashboard/api/google/*.js` endpoint and the entire review dataset were reachable by anyone who knew or guessed the URL.

### Account directory (temporary, Phase 1 only)

`ACCOUNT_DIRECTORY_JSON` is a single Vercel env var holding a JSON object:

```json
{
  "accounts": [
    {
      "userId": "usr_lenin",
      "email": "you@example.com",
      "passwordHash": "$2b$12$...",
      "role": "owner",
      "locationIds": "*",
      "sessionVersion": 1,
      "disabled": false,
      "displayName": "Lenin"
    }
  ]
}
```

- `role` is one of `owner`, `marketing`, `location_manager`, `read_only`. Only `owner` accounts should exist in Phase 1 (Lenin, Martin, Ruffy) — `location_manager`/`read_only` are supported by the schema but not yet safe to use (see "Location authorization strategy" below).
- `passwordHash` is a bcrypt hash (cost factor 12), generated with:
  ```
  node -e "require('bcryptjs').hash(process.argv[1], 12).then(console.log)" 'the-password'
  ```
  (run from `dashboard/`, where `bcryptjs` is installed). Never store a plaintext password here.
- `locationIds` is `"*"` for full access, or (once location-scoped roles are introduced) an array of stable numeric `locations.id` values — never location names.
- `sessionVersion` invalidates every outstanding session for that account the moment you increment it (e.g. after a password change or to force a re-login). Bump it, redeploy the env var, done — no other action needed.
- `disabled: true` blocks an account without deleting its record.
- If this env var is missing or fails validation in any way, the entire auth system fails **closed** — every request is treated as unauthenticated. This is deliberate.

**This is an explicit, temporary stopgap** — not a permanent user-management system. The migration path to a hosted database (Phase 4) is a straight lift: `userId`/`email`/`passwordHash`/`role`/`locationIds`/`sessionVersion`/`disabled` map directly onto a `users` table's columns.

### Session design

A signed (JWS/HS256 via `jose`), `HttpOnly`, `Secure`, `SameSite=Lax` cookie, 12-hour fixed expiry. Claims: `userId`, `email`, `role`, `locationIds`, `issuedAt`, `expiresAt`, `sessionVersion` — nothing else (no password hashes, no OAuth tokens, no API keys). On every request, the account's *current* role/locationIds/sessionVersion/disabled state is re-read from `ACCOUNT_DIRECTORY_JSON` — the cookie's claims are only used to identify which account it is, never trusted as the actual permission source.

`dashboard/middleware.js` performs the same check at the Edge as a fast pre-filter (and to permanently retire the legacy `/data/*` path — see below), but `dashboard/api/_lib/auth.js`'s `requireAuth()` is the authoritative layer and every API handler calls it independently.

### Rate limiting

Login, the highest-stakes write endpoints (`publish`, `trigger-sync`, `trigger-import`, `test-connection`), and the Anthropic-backed endpoints (`rewrite`, `executive-brief`, since abuse there is a direct cost) are rate-limited via Upstash Redis (`@upstash/ratelimit`), which is durable across serverless instances — unlike an in-memory counter, which resets per cold start and provides close to no real protection in a multi-instance deployment.

**Behavior deliberately differs by environment (`dashboard/api/_lib/rateLimit.js`):**

- **Production** (`VERCEL_ENV === 'production'`, which Vercel sets automatically on deployed functions): if `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are missing, or Upstash itself is unreachable/erroring, the endpoint **fails closed** — it returns a generic `503 { error: 'service_unavailable' }` rather than silently letting the request through. The response never names Upstash or any env var, and authentication still runs first, so an unauthenticated caller learns nothing beyond the normal 401 — only an already-authenticated caller ever sees the 503, and even then with no configuration detail. A sanitized error is logged server-side for the administrator.
- **Everywhere else** (local scripts, the Node test suite, `vercel dev` without `VERCEL_ENV=production`, preview deployments): missing Upstash config **fails open**, so local development and CI never need a real Upstash account. Every fail-open path logs an unmistakable `DEV/TEST FALLBACK` warning — it is never silently mistaken for real protection.

Add the Upstash Redis integration from the Vercel Marketplace to get real protection in production. `dashboard/scripts/check-prod-env.mjs` is an optional, not-wired-in-by-default script you can add to `buildCommand` if you'd rather a misconfigured deploy fail the build outright instead of only degrading at request time (see that file's header for the tradeoff).

### Location authorization strategy

`locations.id` (a stable integer, already the foreign key for every review in `dashboard/reviews.db`) is the correct long-term authorization identifier — not `location_name`. `export_chunks.py`'s `review_to_dict()` already emits it as `locationId` on every exported review, and `dashboard/api/_lib/auth.js`'s `requireScopedAuth()`/`requireLocationAccess()` (built in Phase 2, wired up for real starting Phase 8) enforce it: a `location_manager` account's `locationIds` grant is checked against the resolved `location_id`, and a location outside the grant returns `404` (existence-hiding), never `403`.

**As of Phase 8, `location_manager` accounts are real and safe to create for Restaurant Contacts** (`dashboard/api/settings/[action].js`'s `contacts-*` actions) — the first production endpoints to actually call `requireScopedAuth()`. The gap that isn't closed yet is narrower than it used to be: `publish.js`/`rewrite.js` (replying to/rewriting a *review*, not a contact record) still don't resolve or verify a review's `location_id` server-side — they're gated purely by role (`owner`/`marketing`), which already excludes `location_manager` entirely. Scoping those two endpoints the same way Restaurant Contacts now is was explicitly deferred to its own future phase (Phase 8's role matrix ships Manager scoping for Restaurant Contacts only, on purpose — see the Phase 8 plan's "Corrections to the original brief").

### Local development secrets

If you use `vercel env pull` to test any of this locally, it writes every project env var — including `ACCOUNT_DIRECTORY_JSON`, `SESSION_SIGNING_SECRET`, and the Upstash/Google/GitHub/Anthropic credentials — into a plaintext `.env*.local` file inside `dashboard/`. `dashboard/.gitignore` covers these filenames explicitly (the root `.gitignore`'s `*.env` pattern does not match Vercel's actual `.env.local`/`.env.development.local` naming). Never commit one of these files, and never paste its contents anywhere outside your own machine.

### Standing rule: no sensitive data in `dashboard/public/`

`dashboard/public/` is served by Vercel as static assets to anyone, unauthenticated, forever. **No sensitive operational data may ever be written there** — this includes raw reviews, manager investigations, complaint cases, internal notes, assignments, manager responses, audit history, unpublished reply drafts, AI-generated internal recommendations, account/user information, or any integration status containing private identifiers. `export_chunks.py` writes to `dashboard/private-data/` instead, reachable only through the authenticated `dashboard/api/data/[...path].js` endpoint. When the future Manager Complaint Investigation feature is built, its data must follow the same rule from day one.

## Action Accountability Store

Action Center's task-tracking state (status, assignee, due date, notes, history) is collaborative, shared state — not analytics — and is deliberately isolated from the review-sync pipeline: **no `reviews.db`/SQLite/`analytics_cache` schema change, no `refresh_analytics.py`/`export_chunks.py` change, no provider change**. It lives entirely in Upstash Redis, the same Redis instance already used for rate limiting (`_lib/rateLimit.js`), via one Redis hash (`action_workspace:v1`, one field per action-item id).

- **`dashboard/api/_lib/actionStore.js`** — the Redis seam (`getAllActions()`/`upsertAction()`), same role as `accountStore.js`'s seam over the account directory. Never fails open: an unconfigured or unreachable store always throws (mapped to a 503 by the endpoint), in every environment — unlike rate limiting's dev/test fallback, there is no safe fake success for a write.
- **`dashboard/api/actions/[action].js`** — the one consolidated serverless function (`GET /api/actions/list`, `POST /api/actions/update`), following the same one-file-many-actions pattern `session/[action].js` already uses to stay under Vercel's function-count ceiling. Same read/write roles as the AI Action Center already had (`owner`, `marketing`) — this does **not** introduce location-scoped authorization; `location_manager` accounts exist now (see "Location authorization strategy" above) but are not yet scoped to Action Center's own task workspace, only to Restaurant Contacts.
- **`GET /api/session/accounts`** — the reusable identity-directory endpoint (added to the existing `session/[action].js`, not a new file), returning every non-disabled account's safe identity (no `passwordHash`). Deliberately on the identity layer rather than owned by Action Center, so future features (workload reporting, notifications, settings/manager-administration, audit-log attribution) reuse this same endpoint instead of each growing their own account-listing logic.

**Task record shape** (server-authoritative fields are stamped only by `actionStore.js`, from the authenticated caller and the server clock — a client-supplied `createdBy`/`createdAt`/`updatedBy`/`updatedAt`/`history`/`id` in a patch is rejected outright, not silently stripped):

```
{ id, status, assignedTo, assignedLocation, assignedDepartment, dueDate, notes,
  outcomeSnapshot, history: [{ at, by, action }],
  createdBy, createdAt, updatedBy, updatedAt }
```

`dashboard/src/services/actionWorkspaceService.js` is the exact seam its own original header comment called out as swappable — it now calls this API instead of `localStorage`, with `useActionWorkspace.js`'s public shape (and every `ActionCenter.jsx` caller) unchanged. `dashboard/src/utils/actionWorkspaceUtils.js` holds the shared `isOverdue()`/`OPEN_STATUSES` logic so Action Center's own Overdue filter and the Executive Intelligence Center's "assigned to you and overdue" priority source can never drift apart.

Explicitly deferred (future milestones, not this one): `location_manager`-scoped task visibility, email/digest reminders for overdue tasks (would require a Python-side Redis client and cross the pipeline's batch/email boundary), and promoting the Executive Intelligence Center to the landing page.

## Restaurant Contacts Store (Phase 8)

Replaces the old edit-`reviews.db` → `export_chunks.py` → commit → deploy cycle for changing a restaurant contact with an in-dashboard editor — **Settings → Restaurant Contacts** — that takes effect immediately, no export/commit/deploy involved. Same Redis-backed-store shape as the Action Accountability Store above.

- **`dashboard/api/_lib/contactStore.js`** — one Redis hash (`restaurant_contacts:v1`), one field per `location_id`, same server-authoritative-field-stamping convention as `actionStore.js` (`createdBy`/`createdAt`/`updatedBy`/`updatedAt`/`history` are computed only here, never trusted from a client patch).
- **`dashboard/api/settings/[action].js`** — a new consolidated function (the second slot freed by the Milestone 8.2 `google/*.js` consolidation below), with actions for list/upsert/delete/toggle-active, a one-off idempotent backfill from the legacy JSON export, the global audit log read, the Email System status read, and Send Test Email. `CONTACTS_VIEW`/`CONTACTS_MANAGE` (new `Permission` constants) gate access: Owner/Marketing get full read+write; `location_manager` gets a read-only view scoped to their own `locationIds` grant (the first production use of `requireScopedAuth()` — see "Location authorization strategy" above); `read_only` has neither.
- **`dashboard/src/pages/settings/RestaurantContacts.jsx`** / **`ContactEditorModal.jsx`** — the editor UI. `ContactEditorModal` is exported standalone (not private to the Settings page) so Review Explorer's own "⚠ No Restaurant Contact Configured" banner can open it in place, without navigating away from the review.
- **Legacy cutover**: `dashboard/api/_lib/locationContacts.js` (read by the Restaurant Bad-Review Email Workflow below) keeps its exact exported signature, but now reads `contactStore.js` (Redis) first, falling back to the baked `location-contacts.json` file only if Redis is unreachable. `export_chunks.py`'s `export_location_contacts()`, `set_location_contacts.py`, and `location-contacts.json` itself are all retained as an inert-but-present fallback/emergency path, not the source of truth anymore — scheduled for actual removal once this cutover has been stable in production for a couple of release cycles (tracked in "Future roadmap" below, **not yet done** as of this write-up).

## Credential Store (Phase 8)

The Google Business Profile refresh token's storage — see "Refresh token generation" under "Google Business Profile integration" below for the full reconnect-flow writeup. Summarized here as its own store, alongside the Action Accountability/Restaurant Contacts/Audit Trail stores it shares Redis and its conventions with:

- **`dashboard/api/_lib/credentialStore.js`** — a single Redis key (`gbp_credentials:v1`), value AES-256-GCM-encrypted (Node's built-in `crypto`, no new dependency) under `CREDENTIAL_ENCRYPTION_KEY`. Exposes `getStoredCredential()` / `setStoredCredential()` / `recordSyncOutcome()` / `recordOAuthRefresh()` / `clearStoredCredential()`, plus the `GoogleHealth` enum (`connected` / `token_expired` / `token_revoked` / `auth_failed` / `never_connected`) that both the `google/[action].js` endpoints and the Settings → Google Business Profile page's Connection Status badge read directly.
- **Automatic recovery**: `recordSyncOutcome()` is called the moment Google reports `invalid_grant` — from `status`, `test-connection`, or a failed `publish` — before the response is even sent, so the next status read already reflects "Reconnect Required" rather than a stale "Connected" badge.
- **Cross-language interop**: `google_api.py` (the GitHub Actions-run Python pipeline) reads and decrypts the exact same Redis value via the `cryptography` package's `AESGCM` (Node keeps ciphertext/authTag as separate base64 fields; Python's `AESGCM.decrypt()` wants them concatenated — handled explicitly in `google_api.py`), falling back to the `GOOGLE_REFRESH_TOKEN` GitHub Actions secret if Redis/the encryption key aren't configured.

## Audit Trail (Phase 8)

A cross-entity, compliance-facing, append-only event log — distinct from Restaurant Contacts' own per-record `history` array (a lightweight "what changed on this one record" view). **Settings → Audit Log**, Owner-only.

- **`dashboard/api/_lib/auditLog.js`** — one Redis LIST (`audit_log:v1`), `LPUSH` (newest first) + `LTRIM` capped at the most recent 20,000 entries. `appendAuditEntry(entry)` is the one deliberate exception to this codebase's "never fail open on a write" convention — an audit-log write failure logs and returns `false` rather than breaking the primary action it's recording (e.g. a contact upsert that already succeeded); `listAuditEntries({entity, actorId, from, to, result, limit, offset})` throws on a genuine read failure rather than silently showing an empty log.
- Entry shape: `{ id, at, actorId, actorName, actorEmail, ip, entity, entityId, action, changes, result, message }`. `entity` values in use today: `contact`, `google_oauth`, `email`.
- Every Restaurant Contacts write, every Google reconnect/disconnect, and every Send Test Email call appends an entry here — `AUDIT_VIEW` (new `Permission` constant) is Owner-only; Marketing has `CONTACTS_MANAGE` but deliberately not `AUDIT_VIEW`.

## Restaurant Bad-Review Email Workflow

Lets marketing (`owner`/`marketing` roles) click **Send to Restaurant** on a negative review (Review Explorer, star rating ≤ 2) to email the location's contact directly, CC Martin/Ruffy, and track the thread through resolution — reusing the Action Accountability Store above rather than a second task-management system. Recovery-audit milestone; the original feature was never previously implemented (see the audit for what was searched and ruled out).

**Architecture**: direct, synchronous delivery from the authenticated Vercel function via a provider-neutral SMTP transport (nodemailer), not a GitHub Actions `workflow_dispatch`. An async dispatch can't safely report final delivery status back without new callback infrastructure, and this milestone's own requirement is that an email is never marked "sent" merely because a workflow was queued — direct delivery returns a truthful, immediate sent/failed result instead. See `dashboard/api/_lib/emailSender.js`'s header comment for the full tradeoff analysis.

The sending mailbox is a **Microsoft 365/Outlook account** (`advertising@l3amigos.com`), authenticated via SMTP AUTH over STARTTLS (`smtp.office365.com:587`) — a separate mailbox and separate credential set from the one the pre-existing internal alert scripts (`notify.py`, `nightly_digest.py`, `critical_alert_check.py`, `weekly_report.py`, `health_check.py`) already use for an unrelated purpose (see the main environment-variables table above). The config is genuinely provider-neutral — a different SMTP-capable mailbox only requires different `SMTP_*` values, no code change.

- **`dashboard/api/_lib/locationContacts.js`** — reads `dashboard/private-data/location-contacts.json` (written by `export_chunks.py`'s `export_location_contacts()`) directly off disk, server-side only. **Never added to `data.js`'s allowlist** — the browser can never fetch the whole contact directory, authenticated or not; only the one resolved recipient for the location being acted on is ever returned, via `GET /api/actions/preview-review-email`.
- **`dashboard/api/_lib/reviewEmailConfig.js`** — `REVIEW_ESCALATION_CC_EMAILS` (comma-separated, validated, malformed entries dropped with a log line — but an empty *resulting* list is fatal, see below) and `REVIEW_REPLY_TO_EMAIL` (falls back to the existing marketing inbox, `advertising@l3amigos.com`, matching every Python alert script's `TO_ADDR`). Server-side only, deliberately separate from `ACCOUNT_DIRECTORY_JSON` — who gets CC'd is a distinct policy decision from who can log in.
- **`dashboard/api/_lib/emailSender.js`** — provider-neutral SMTP transport (`SMTP_HOST`/`PORT`/`SECURE`/`USER`/`PASSWORD`/`FROM_NAME`) plus `reviewEmailTemplate.js`'s HTML+plain-text template (all customer-provided content escaped before HTML insertion). `buildTransportConfig()` is exported as a pure function specifically so port-parsing/STARTTLS-vs-implicit-TLS selection is unit-testable without a real mailbox.
- **Three new actions on the existing `dashboard/api/actions/[action].js`** (zero new serverless functions): `GET preview-review-email` (recipient/CC/Reply-To preview), `POST send-review-email` (send + record), `POST update-email-status` (manual `replied`/`follow_up_required`/`resolved` transitions, only reachable from a genuinely-sent email — never from `not_sent` or `failed`).

**Environment variables required** (none of their values are documented here):

| Variable | Purpose | Where it's set |
|---|---|---|
| `SMTP_HOST` | The mailbox's SMTP server, e.g. `smtp.office365.com` for Microsoft 365 | **Mandatory.** Vercel project env var |
| `SMTP_PORT` | The SMTP port. Defaults to `587` (STARTTLS) if unset — never independently a reason to fail, since the default is always valid | Optional (documented alongside the mandatory three; has a safe default). Vercel project env var |
| `SMTP_SECURE` | `false` for STARTTLS on port 587 (Microsoft 365) — the default if unset. `true` would mean implicit TLS (e.g. port 465, most non-Microsoft-365 providers) | Optional. Vercel project env var |
| `SMTP_USER` | The mailbox's own address, e.g. `advertising@l3amigos.com` — **must be the exact account the SMTP password/app-specific credential was issued for** | **Mandatory.** Vercel project env var |
| `SMTP_PASSWORD` | The mailbox's SMTP AUTH credential. See "Microsoft 365 SMTP AUTH" below before assuming a normal account password will work. | **Mandatory.** Vercel project env var |
| `SMTP_FROM_NAME` | Optional; the outgoing email's display name, e.g. `Lenin | Los Tres Amigos Marketing` instead of the default `LTA Review Dashboard`. Purely cosmetic — never blocks sending. | Optional. Vercel project env var |
| `REVIEW_ESCALATION_CC_EMAILS` | Comma-separated CC list (Martin/Ruffy) — always applied on every send, no per-review opt-out. **Mandatory**: if unset (or every entry is malformed, resolving to an empty list), both `preview-review-email` and `send-review-email` fail closed with `503 {"error":"service_unavailable","message":"Review escalation recipients are not configured."}` — the feature refuses to send with no management visibility rather than silently omitting the CC. | **Mandatory.** Vercel project env var |
| `REVIEW_REPLY_TO_EMAIL` | Optional; defaults to `advertising@l3amigos.com` if unset | Optional. Vercel project env var |
| `DASHBOARD_BASE_URL` | Optional; builds the email's "internal reference" deep link (`/explorer?reviewId=...`). Falls back to `https://${VERCEL_URL}` (Vercel's own auto-populated var) if unset, or omits the link entirely if neither is available. | Optional. Vercel project env var |

**Microsoft 365 SMTP AUTH — read before assuming a password will work**: Microsoft 365 tenants frequently have Authenticated SMTP (SMTP AUTH) **disabled by default** as a security default, independent of whether the password itself is correct — a disabled mailbox will fail authentication no matter how many times the password is re-entered. Before relying on this password-based approach, an administrator should verify, per-mailbox: **Microsoft 365 Admin Center → Users → Active users → `advertising@l3amigos.com` → Mail → "Manage email apps" → confirm "Authenticated SMTP" is enabled** for that specific mailbox. This is a narrower, mailbox-scoped setting — it does not require disabling any tenant-wide security default, and no tenant-wide security default should be disabled to work around this without deliberately understanding the security tradeoff of doing so. If the tenant blocks password-based SMTP AUTH organization-wide and that policy is not going to be relaxed, this module's password-based approach is not viable — the correct next step is Microsoft OAuth2 (Nodemailer's XOAUTH2) or the Microsoft Graph `sendMail` API, not repeated password attempts.

**Contact-email configuration**: as of Phase 8, this is dashboard-editable — **Settings → Restaurant Contacts** (Owner/Marketing, `location_manager` sees a read-only view scoped to their own location) — no `export_chunks.py` run, commit, or deploy required; see "Restaurant Contacts Store" below for the full architecture. `locations.contact_email` / `contact_name` / `contact_active` (the additive `db.py` columns) and `python set_location_contacts.py` are retained only as the pre-Phase-8 fallback path and an emergency CLI, not the primary way to configure a contact anymore.

**Permitted roles**: `owner`, `marketing` — same as the AI Action Center's own read access. `location_manager` and `read_only` are explicitly rejected (403), consistent with "Location authorization strategy" above.

**Reply-To / CC behavior**: both are resolved **entirely server-side** from `REVIEW_REPLY_TO_EMAIL`/`REVIEW_ESCALATION_CC_EMAILS` — the request body has no field for either, so a client cannot redirect or suppress them regardless of what it sends. CC fires on every manual send, unconditionally (no severity gating, no opt-out) — and is **mandatory**: an unconfigured CC list blocks sending entirely (503) rather than sending with no management visibility. From and Reply-To are intentionally different mailboxes/purposes: From carries the display name + sending mailbox (`SMTP_USER`); Reply-To routes restaurant replies to the marketing inbox regardless of which mailbox actually sent the message.

**Email-status lifecycle**: `not_sent` (default/absent) → `sent` (a real send succeeded) or `failed` (attempted, recorded truthfully with a sanitized diagnostic, never claims sent) → manually, from `sent` (or an already-reached manual state), to `replied` / `follow_up_required` / `resolved`. A `failed` record can only be retried (producing a fresh `sent`/`failed`), never manually promoted to `replied` — an email that never reached the restaurant cannot have a reply. Resending an already-`sent`/`replied`/`follow_up_required`/`resolved` item requires an explicit confirm click in the UI (`confirmResend`).

**Manual restaurant-response process** (Level 1 — no inbound email ingestion, by design; see the recovery audit's Option A/B/C comparison): the restaurant replies normally to the Reply-To inbox. Marketing pastes that reply into the same item's existing Internal Notes field (Action Center's "Restaurant Email Threads" section, or Review Explorer's own notes field for that review) and updates the status to `replied` / `follow_up_required` / `resolved` from Action Center.

**Email System dashboard (Phase 8, Milestone 8.9)** — **Settings → Email** (Owner/Marketing, new `EMAIL_VIEW` permission) is a read-only view over this same subsystem: SMTP host/port/configured state (from `emailSender.js`'s `hasSmtpConfig()`, exported for exactly this), last successful/failed send and recent errors (derived from the Audit Trail's `entity: 'email'` entries above), and the delivery model reported truthfully as "Direct delivery — no queue" rather than inventing a queue metric this architecture doesn't have. **Send Test Email** (a row action on Settings → Restaurant Contacts) sends a review-agnostic diagnostic message (`dashboard/api/_lib/testEmailTemplate.js`) through the exact same `sendReviewEmail()` this workflow uses, unchanged — confirming SMTP delivery works for a given contact without waiting for a real bad review.

**Production verification checklist** (do this before considering the feature live):
1. Add `SMTP_HOST` / `SMTP_USER` / `SMTP_PASSWORD` (all mandatory) and `REVIEW_ESCALATION_CC_EMAILS` (mandatory, Martin + Ruffy's real addresses) to Vercel's Production env vars. Verify Microsoft 365 SMTP AUTH is enabled for the mailbox first (see above) — do not assume a normal account password is sufficient.
2. Optionally add `SMTP_PORT` / `SMTP_SECURE` / `SMTP_FROM_NAME` / `REVIEW_REPLY_TO_EMAIL` / `DASHBOARD_BASE_URL`.
3. Populate at least one location's contact via **Settings → Restaurant Contacts** — **use a real test recipient you control first**, not a live restaurant address. Use its row's **Send Test Email** action to confirm delivery before touching a real restaurant address.
4. Send a real test email end-to-end and confirm it actually arrives in **all** of: the test recipient's inbox, Martin's inbox, Ruffy's inbox, and the configured Reply-To inbox. Do not consider delivery verified on API-response success alone (a 200 confirms nodemailer accepted the send from the SMTP server, not that every recipient's mail provider delivered it).
5. Confirm the Action Center record shows `emailStatus: sent` with a real `emailMessageId`, and that history/notes/status-transition controls all work.
6. Only after that, populate real restaurant contact emails.

**Rollback**: revert the commits — this milestone touches no schema in a way that isn't purely additive (`locations.contact_email`/`contact_name`/`contact_active` are new, nullable columns; the Redis fields are new, optional keys on the same existing record shape) and adds no new serverless function. No data migration to undo. Unpopulated `SMTP_HOST`/`SMTP_USER`/`SMTP_PASSWORD` on Vercel simply means the feature 503s cleanly rather than partially working — safe to leave unset if rolling back the intent to ship this, not just the code.

## Deployment

- Dashboard: Vercel, auto-deployed on every push to `dashboard/**` (`deploy-frontend.yml`) and again at the end of every pipeline run (`update-reviews.yml`), since a pipeline run changes the JSON the dashboard serves.
- Pipeline: GitHub Actions only — there's no manual deploy step; `workflow_dispatch` is enabled on every workflow for on-demand runs.

## How scores are calculated

Everything is computed in `refresh_analytics.py`, one `build_*` function per feature, then written to `analytics_cache` and shipped to a same-named JSON file by `export_chunks.py`:

- `compute_health_score()` — per-location Health Score.
- `build_complaint_intelligence()` — phrase-matched complaint/praise categories (`COMPLAINT_CATEGORIES`/`PRAISE_CATEGORIES`), the foundation most other features aggregate.
- `build_department_summary()` — categories grouped into 13 operational departments.
- `build_cx_index()` — 10 Customer Experience dimensions, derived from category mention rates (not a separate AI pass).
- `build_action_center()` — ranked recommendations (priority/impact/confidence/difficulty derived from category severity, trend, and sample size).
- `build_operations_impact()` — company-wide operational superlatives.
- `build_executive_scores()` — 8 composite scores (Health, Satisfaction, Reputation, Marketing Opportunity, Operational Risk, Manager Performance, Growth, Trend), each with a plain-English `explanation` field.
- `predict_rating()` / `predict_volume()` — location-level forecasts.

The dashboard's `dashboard/src/utils/textAnalysis.js` mirrors the same category definitions client-side for pages that classify live-filtered reviews in the browser instead of waiting for the next pipeline run — keep the two in sync when adding a category.

## Google Business Profile integration

### Google Cloud setup

1. Submit an "Application for Basic API Access" via the [GBP API prerequisites page](https://developers.google.com/my-business/content/prereqs) — access isn't self-serve, Google approves manually (typically 1–5 business days).
2. Create (or reuse) a Google Cloud project at console.cloud.google.com.
3. Enable **Google My Business API** (read/reply to reviews) and **My Business Account Management API** (list locations). Enable **Business Information API** too if you want verification-status detail beyond what's already surfaced.
4. Create OAuth 2.0 credentials: Credentials → Create credentials → OAuth 2.0 Client ID → application type **Web application**. Add an authorized redirect URI: `https://<your-domain>/api/google/callback`.
5. Required scope: `https://www.googleapis.com/auth/business.manage` (single scope covers reading and replying).

### Refresh token generation (Phase 8, Milestone 8.7 — no Vercel env var, no redeploy)

Reconnecting Google Business Profile from **Settings → Google Business Profile** never touches Vercel at all now:

- Clicking "Connect Google Account" (or "Reconnect") walks through OAuth as before, but `dashboard/api/google/[action].js`'s `callback` case writes the refresh token straight to `dashboard/api/_lib/credentialStore.js` — a single Upstash Redis key (`gbp_credentials:v1`), AES-256-GCM-encrypted under `CREDENTIAL_ENCRYPTION_KEY` — instead of writing a Vercel env var and redeploying. The very next request already reads the new connection; there is no ~60s propagation window, and no entry in Vercel's deployment history for a routine reconnect.
- The token is never shown in the browser, logged, or put in a URL, on any path (including a failed save).
- The legacy `GOOGLE_REFRESH_TOKEN` Vercel env var and `dashboard/api/google/_lib/vercel.js` (`upsertEnvVar`/`triggerRedeploy`) are no longer read by the active connect/reconnect flow — kept in the repo only as a manual rollback escape hatch, not a live fallback.
- **GitHub Actions** (the scheduled Python sync/alert workflows) reads the *same* Redis-backed credential first (Milestone 8.8, `google_api.py`'s `_fetch_refresh_token_from_redis()`), falling back to the `GOOGLE_REFRESH_TOKEN` GitHub Actions secret only if Redis is unreachable or the one-time setup below hasn't been done. This closes the gap where a dashboard reconnect never used to reach the scheduled pipeline at all.
- One-time GitHub Actions setup: add `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and `CREDENTIAL_ENCRYPTION_KEY` as GitHub Actions secrets (same values as the Vercel project env vars of the same names) on any repo that runs `critical-alert-check.yml` or `historical-import.yml`. Unlike the refresh token itself, these three don't go stale on every reconnect — set them once.
- **Automatic recovery**: if Google reports `invalid_grant` (revoked or expired) from *any* live check — a manual status read, Test Connection, or a failed publish attempt — the stored connection health flips immediately, before the response is even sent. The dashboard shows "Reconnect Required" (Token Expired/Token Revoked/Authentication Failed) on the very next read, never a stale "Connected" badge hiding a broken connection.
- CSRF protection: the `auth` case sets a random `state` nonce in an httpOnly cookie; the `callback` case rejects the exchange if it doesn't match.

### Connection Center (Settings page)

Settings → Google Business Profile shows: Connection Status (one of Connected/Token Expired/Token Revoked/Authentication Failed/Never Connected), Connected Google Account, Last Authentication, Last Successful Sync, Last Failed Sync, Token Health, Number of Linked Locations, and (once connected) two live tools:

- **Test Connection** — calls `/api/google/test-connection`, which walks OAuth → refresh-token exchange → account list → location list → review read → reply-permission (scope check) and reports pass/fail with the exact reason per step, never a generic error.
- **Location Sync** — a table of every location (linked status, review count, last synced) sourced from `dashboard/public/data/gbp-sync.json` (written by `export_chunks.py::export_gbp_sync_status`), plus a **Sync Now** button that dispatches `update-reviews.yml` via the GitHub API (`GITHUB_SYNC_PAT`) instead of duplicating sync logic in JS.

### Sync design

- **Identity**: every review's Google resource name (`gbp_review_name`, e.g. `accounts/*/locations/*/reviews/*`) is the source of truth once linked; `db.py::dedup_key()` prefers it over the legacy Maps-URL-derived key so historical (scraper-sourced) and API-sourced rows never double up.
- **Historical import** (`gbp_import.py`, `--apply` to write / dry-run by default): one-time reconciliation that matches existing scraped rows to API reviews (location + star rating + review date ±1 day + fuzzy reviewer name) and links them via `gbp_review_name`, or inserts unmatched ones fresh. Writes a match-rate report (`gbp_import_report.json`, gitignored) for manual review before trusting it — **run this against a scratch copy of `reviews.db` first**, never production, without inspecting that report.
- **Incremental sync** (`gbp_sync.py`, wired into `update-reviews.yml`): auto-discovers new locations by name-matching against Google's account location list (zero manual config for a new location), upserts via the same `db.py` dedup path, and detects edits/deletions using the identical logic `auto_update.py` always used.
- **Immediate critical alerts** (`critical_alert_check.py`, ~15min cron): a fast partial sync (first review page per location only) + incremental AI classification, then an email the moment an unanswered review is AI-classified `critical` — bounded to the last 30 days so a first-ever run can't flood on historical backlog.
- **Nightly digest** (`nightly_digest.py`, ~10pm ET): one email of every new, meaningful 1-2★ review, grouped by location. "Meaningful" excludes empty reviews, stars-only reviews, and generic one-word reviews ("Bad", "Terrible", punctuation/emoji-only) — see `digest_filters.is_meaningful_review()`. Reviews already answered on Google are excluded entirely (a real, server-visible "handled" signal); reviews already sent via the immediate critical path are included but labeled "Previously Escalated" rather than re-alarming. Zero qualifying reviews → no email, just a log line.
- **Publishing**: `dashboard/api/google/publish.js` accepts a direct `reviewName` (preferred, once a review is linked — no lookup needed) or falls back to fuzzy location/reviewer-name matching for legacy unlinked rows, with full pagination (earlier versions silently stopped at page 1).

### GBP-specific limitations

- **No GBP quota-remaining endpoint.** Google doesn't expose one; the Connection Center says so explicitly rather than fabricating a number.
- **DST-safe nightly cron is an approximation, not native scheduling.** GitHub Actions cron is UTC-only; `nightly-digest.yml` fires twice daily (bracketing 10pm ET across DST) and `nightly_digest.py` itself checks the real `America/New_York` hour and no-ops on the wrong firing. Correct year-round, but relies on the script's own gate rather than the scheduler.
- **"Already handled" in the nightly digest only sees server-visible signals** (an owner reply on Google, or already escalated via the immediate path). The dashboard's own per-review handled/dismissed/assigned status lives in browser `localStorage` (by design — see the workspace-state limitation below) and isn't visible to any Python script.
- **The reply-permission check in Test Connection is a scope check, not a live probe** — Google has no dry-run reply endpoint; a revoked permission will only surface at actual publish time.
- **The Playwright scraper (`auto_update.py`) is kept as a manual fallback**, not deleted, but is unmaintained relative to the API path going forward — treat it as an emergency-only tool.

## Known limitations

- **Manager Performance Score is a proxy, not a real metric.** The review schema has no manager field — it's aggregate staff-name-mention sentiment, explicitly labeled as such in its `explanation` string.
- **Single-tenant.** One dataset (one restaurant group, Los Tres Amigos), not multiple. Authentication/authorization (login, sessions, `owner`/`marketing`/`location_manager`/`read_only` roles, location-scoped access) is real as of Phase 1–8 — see "Authentication & authorization" above — but a second, independent restaurant group on the same deployment would need real backend work (a tenant dimension doesn't exist anywhere in the schema).
- **Some AI prompts hardcode "Los Tres Amigos"** by name (pre-existing, in `ai_engine.py`) rather than reading the brand list dynamically.
- **Review workspace state (notes/assignments/status on individual reviews, `reviewWorkspaceService.js`) still lives in `localStorage`**, not a shared backend — it doesn't sync between devices or team members. Action Center's own task-tracking workspace (`actionWorkspaceService.js`) no longer has this limitation as of the Action Accountability Store (see above) — it's now Redis-backed and collaborative. Both remain isolated behind the same service-layer seam (`dashboard/src/services/*Service.js`) so the review workspace can be migrated the same way later without touching page components.
- **`dashboard/reviews.db` (37MB+) and `dashboard/reviews.csv` are committed to git and rewritten every ~6 hours**, because GitHub Actions runners are ephemeral and the repo is currently the only persistence layer between runs. This drives unbounded `.git` growth. Recommended options for a future fix (not yet actioned, since it touches the live CI pipeline and needs its own sign-off): move to Git LFS, move the DB to external storage (Vercel Blob / a hosted SQLite service like Turso) and stop committing it, or periodically squash git history.

## Future roadmap

- Migrate the remaining `localStorage`-backed workspace (`reviewWorkspaceService.js`) to a shared backend the same way the Action Accountability Store did for Action Center.
- Location-scoped access for `publish.js`/`rewrite.js` (replying to/rewriting a review) and for Action Center's own task workspace — `location_manager` accounts exist now (Phase 8) and are scoped for Restaurant Contacts, but not yet for these two.
- **Scheduled legacy-artifact removal (Phase 8 cutover, not yet due)**: `db.py`'s `contact_*` columns, `set_location_contacts.py`, `export_location_contacts()`, and `location-contacts.json`'s `vercel.json` `includeFiles` entry were all kept as an inert fallback when Restaurant Contacts moved to Redis (see "Restaurant Contacts Store" above) — the plan's own default is to remove them roughly two release cycles after cutover is verified stable, not immediately. Phase 8 shipped and deployed the same day this note was written, so that window has **not** elapsed yet — reassess before actually deleting anything here.
- Resolve the `reviews.db` git-bloat tradeoff above.
- List/table virtualization if review volume grows enough that the current pagination-based approach stops being sufficient.
