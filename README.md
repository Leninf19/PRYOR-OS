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
├── scripts/legacy/             # pre-pipeline scraping scripts, kept for reference only
├── requirements.txt
├── .github/workflows/          # update-reviews, critical-alert-check, nightly-digest,
│                                # health-check, weekly-report, deploy-frontend
└── dashboard/
    ├── reviews.db, reviews.csv   # committed pipeline state (see Known limitations)
    ├── api/google/               # Vercel serverless functions: OAuth, status, publish,
    │                             # test-connection, trigger-sync (see below)
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
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | `notify.py`, `health_check.py`, `weekly_report.py`, `critical_alert_check.py`, `nightly_digest.py` | GitHub Actions secrets |
| `VERCEL_TOKEN` | CI's own `vercel --prod` deploy step | GitHub Actions secret |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | `dashboard/api/google/*.js` (OAuth, status, publish, test-connection) **and** `google_api.py` (`gbp_sync.py`, `gbp_import.py`, `critical_alert_check.py`) | **Both** Vercel project env vars (for the live serverless functions) **and** GitHub Actions secrets (for the scheduled Python sync/alert workflows) — same three values, set in two places. See "Refresh token generation" below; once automation is configured, `GOOGLE_REFRESH_TOKEN` is written to Vercel for you, but still needs manually copying into GitHub Actions secrets since GitHub has no equivalent write API used here. |
| `VERCEL_API_TOKEN` / `VERCEL_PROJECT_ID` / `VERCEL_ORG_ID` / `VERCEL_DEPLOY_HOOK_URL` | `dashboard/api/google/callback.js` (writes `GOOGLE_REFRESH_TOKEN` to Vercel automatically after OAuth, then triggers a redeploy) | Vercel project env vars. `VERCEL_API_TOKEN` is a personal/team API token scoped to env-var write access — distinct from the GitHub Actions secret of a similar name (`VERCEL_TOKEN`), do not confuse the two. |
| `GITHUB_SYNC_PAT` | `dashboard/api/google/trigger-sync.js` (the Settings → Connection Center "Sync Now" button) | Vercel project env var — a GitHub personal access token with `workflow` scope, used only to dispatch `update-reviews.yml` on demand. |

`VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` used by the GitHub Actions deploy step are not secret and are hardcoded directly in the workflow YAML files — this is unrelated to the same-named Vercel env vars above (those are read at runtime by `callback.js`, not by CI).

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

### Refresh token generation (automated)

Historically this required copying a refresh token out of the browser and pasting it into Vercel by hand. That manual step is now optional:

- With `VERCEL_API_TOKEN` / `VERCEL_PROJECT_ID` / `VERCEL_DEPLOY_HOOK_URL` set in Vercel, clicking "Connect Google Account" in Settings walks through OAuth, and `dashboard/api/google/callback.js` writes `GOOGLE_REFRESH_TOKEN` to Vercel directly and triggers a redeploy — the token is never shown in the browser.
- Without those three set, `callback.js` falls back to the original flow: it displays the token once and links to the manual copy-paste steps.
- Either way, the same token also needs to be added to **GitHub Actions secrets** by hand (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN`) so the scheduled Python sync/alert workflows can authenticate — there's no automation for that half, since GitHub has no equivalent "write a secret" API used here.
- CSRF protection: `auth.js` sets a random `state` nonce in an httpOnly cookie; `callback.js` rejects the exchange if it doesn't match.

### Connection Center (Settings page)

Settings → Google Integration now shows: connection state, linked account ID, granted scopes, access-token expiry, and (once connected) two live tools:

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
- **Single-tenant, no authentication.** One account, one dataset, no login. Any multi-restaurant-group or role-based-access use would need real backend work.
- **Some AI prompts hardcode "Los Tres Amigos"** by name (pre-existing, in `ai_engine.py`) rather than reading the brand list dynamically.
- **Workspace state (review notes/assignments/action statuses) lives in `localStorage`**, not a shared backend — it doesn't sync between devices or team members. Isolated behind a service-layer seam (`dashboard/src/services/*Service.js`) specifically so it can be swapped for a real backend later without touching page components.
- **`dashboard/reviews.db` (37MB+) and `dashboard/reviews.csv` are committed to git and rewritten every ~6 hours**, because GitHub Actions runners are ephemeral and the repo is currently the only persistence layer between runs. This drives unbounded `.git` growth. Recommended options for a future fix (not yet actioned, since it touches the live CI pipeline and needs its own sign-off): move to Git LFS, move the DB to external storage (Vercel Blob / a hosted SQLite service like Turso) and stop committing it, or periodically squash git history.

## Future roadmap

- Real backend + auth, if/when workspace state needs to be shared across a team instead of per-browser.
- Resolve the `reviews.db` git-bloat tradeoff above.
- List/table virtualization if review volume grows enough that the current pagination-based approach stops being sufficient.
