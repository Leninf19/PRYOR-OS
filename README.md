# Los Tres Amigos Review Intelligence Dashboard

A Google Business Profile review intelligence platform for a 21-location, 5-brand Mexican restaurant group (Los Tres Amigos, Los Tres Mex Grill, Mi Lindo San Blas, Rio Luna, Casa Tequila). A Python pipeline scrapes and classifies reviews on a schedule; a static React dashboard (deployed on Vercel) reads the precomputed results.

## Architecture overview

Two halves that only communicate through `dashboard/reviews.db` and the static JSON it gets exported to:

1. **Data pipeline** (root, Python, runs on GitHub Actions) — scrapes Google reviews, classifies them, computes every score/metric the dashboard shows, and exports the results as static JSON.
2. **Dashboard** (`dashboard/`, Vite + React + Tailwind) — a static SPA that fetches those JSON files. It has no database connection and no server-side rendering; the only server-side code it ships is a handful of Vercel serverless functions in `dashboard/api/` for things that must happen live (AI rewrite-on-demand, Google OAuth).

There is no multi-tenant auth: this is a single-account app for one restaurant group's own reviews.

## Data pipeline

Runs roughly every 6 hours via `.github/workflows/update-reviews.yml`, in this order:

1. **`auto_update.py`** — scrapes Google Business Profile reviews (Playwright), upserts into `dashboard/reviews.db` via `db.py`'s shared schema/dedup layer.
2. **`validate.py`** — flags data-quality issues (missing fields, suspicious duplicates) into the `validation_flags` table.
3. **`refresh_analytics.py`** — the core analytics engine. Computes everything the dashboard displays (see "How scores are calculated" below) and writes it into the `analytics_cache` table.
4. **`notify.py`** — sends alert emails for anything that crossed a threshold this run.
5. **`export_chunks.py`** — reads `analytics_cache` (and raw review rows) and writes small, purpose-built JSON files into `dashboard/public/data/` — this is the only thing the frontend ever reads.
6. The workflow commits `dashboard/reviews.db` + `dashboard/reviews.csv` back to the repo (see "Known limitations" — this is how state survives between ephemeral CI runs) and deploys the built dashboard to Vercel directly from this same workflow.

Two more independent workflows:
- **`.github/workflows/health-check.yml`** (daily) — runs `health_check.py` as an independent watchdog, so a problem is still caught even if the 6-hourly workflow's trigger stops firing entirely.
- **`.github/workflows/weekly-report.yml`** (Mondays) — runs `weekly_report.py`, emails a summary.
- **`.github/workflows/deploy-frontend.yml`** — redeploys the dashboard on any push to `dashboard/**` (excluding the DB/CSV, which have their own commit path above).

`migrate_csv_to_sqlite.py` and `merge_scraped.py` are one-off/manual maintenance scripts, not part of the scheduled pipeline. `scripts/legacy/` holds older scraping scripts that predate the current `auto_update.py`/`db.py` pipeline and aren't referenced by anything live — kept for reference, not run.

## AI pipeline

Two different patterns, used for different reasons:

- **Batch, server-side, cached** (`ai_engine.py`) — runs during the pipeline (`refresh_analytics.py`/`backfill_sentiment.py`), classifies review sentiment/priority and generates summaries/response drafts. Results are cached by content hash (`db.py::review_content_hash`) so unchanged reviews are never re-sent to the API. Falls back to star-based heuristics everywhere if `ANTHROPIC_API_KEY` isn't set — nothing in the dashboard hard-requires AI to function.
- **Live, client-triggered** (`dashboard/api/rewrite.js`, `dashboard/api/executive-brief.js`) — Vercel serverless functions the browser calls directly (no SDK, plain `fetch` to `https://api.anthropic.com/v1/messages`) for things that need to react to the user's current filter selection rather than the last pipeline run: response tone-rewriting and the live executive briefing.

## Folder structure

```
├── auto_update.py, validate.py, refresh_analytics.py,   # pipeline stages, run in this order
│   notify.py, export_chunks.py
├── db.py                    # shared SQLite schema + upsert/dedup logic
├── ai_engine.py              # batch AI classification/summaries/drafts
├── health_check.py, weekly_report.py   # independent scheduled watchdogs
├── migrate_csv_to_sqlite.py, merge_scraped.py   # one-off/manual maintenance
├── scripts/legacy/            # pre-pipeline scraping scripts, kept for reference only
├── requirements.txt
├── .github/workflows/         # update-reviews, health-check, weekly-report, deploy-frontend
└── dashboard/
    ├── reviews.db, reviews.csv   # committed pipeline state (see Known limitations)
    ├── api/                      # Vercel serverless functions (live AI calls, Google OAuth)
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
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | `notify.py`, `health_check.py`, `weekly_report.py` | GitHub Actions secrets |
| `VERCEL_TOKEN` | CI's own `vercel --prod` deploy step | GitHub Actions secret |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | `dashboard/api/google/*.js` (OAuth + publish-reply-to-Google) | Vercel project env vars only — walked through interactively in the dashboard's Settings page, not referenced by any GitHub workflow |

`VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` are not secret and are hardcoded directly in the workflow YAML files.

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
