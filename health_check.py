"""
health_check.py - Health-check Agent (Milestone 2).

Runs on its own daily schedule (.github/workflows/health-check.yml), separate
from the ~6h scrape cron, so it keeps working even if the scrape workflow
itself stops firing entirely -- the exact failure mode ("a workflow quietly
stops and nobody notices") this project already lived through once.

Three steps against scraper_runs, in order:
0. Watchdog reconciliation (provider_sync.reconcile_stuck_runs()): any row
   still status='running' well past a full sync cycle is marked 'timed_out'
   with a finished_at, before either check below runs. This turns a
   perpetually-open row (the run #159 incident: a non-ProviderError
   exception escaped sync_all()'s per-location loop with nothing to catch
   it, so its final UPDATE never ran and the row stayed 'running' forever)
   into an honest, terminal historical record -- and, since it's a one-way
   transition, is also *why* the same stuck run can no longer alert forever
   once it ages past this threshold: it stops matching check_stuck_run's
   `WHERE status = 'running'` query entirely.
1. Stuck run: a row still status='running' for a shorter, more suspicious
   window (but not yet old enough for reconciliation above) -- worth an
   early heads-up even though it might still self-resolve.
2. Stale pipeline: no run has finished successfully in too long, which
   catches a dead/disabled cron trigger even if no individual run ever
   errored.

Reuses weekly_report.py's Gmail SMTP pattern. check_stuck_run dedupes per
run id (has THIS specific run already been alerted on, ever) rather than a
blanket resend window -- a time-window dedup either silenced a genuinely new
stuck run because an unrelated one alerted recently, or re-alerted on the
exact same permanently-open run every single day forever, depending on
timing. check_stale_pipeline deliberately keeps the resend-window approach:
it has no single row identity to key on ("no success in N hours" is a
condition, not a specific run), and re-alerting daily while genuinely still
stale is the intended behavior.
"""
import os
import smtplib
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import argparse
import sys

import requests

import db
import provider_sync
import tenant_keys
import tenant_paths

# Platform-operational alerts only (scraper stuck-run / stale-pipeline
# liveness) -- never tenant/review content, so this always goes to the
# platform operator regardless of which tenant this script runs for. See
# notify.py's own routing split for the reasoning and the business-content
# boundary this file never crosses.
TO_ADDR = "lenin@futuremark.studio"
FROM_ADDR = os.environ.get("GMAIL_USER", "")
APP_PASS = os.environ.get("GMAIL_APP_PASSWORD", "")

STUCK_RUN_THRESHOLD = timedelta(hours=2)       # a scrape cycle should never take this long
STALE_PIPELINE_THRESHOLD = timedelta(hours=14)  # ~2x the 6h cron interval
RESEND_WINDOW = timedelta(hours=20)             # re-alert daily, not every health-check run

# Scheduling-reliability audit (2026-09-27): critical-alert-check.yml's own
# native GitHub `schedule:` trigger was measured firing at only ~7% of its
# nominal 15-minute cadence -- a GitHub Actions platform limitation on
# sub-hourly cron, not a defect in that workflow's own code. The fix is a
# Vercel Cron Job dispatching it independently (dashboard/api/google/
# [action].js's cronCriticalAlertCheck()), but nothing INSIDE that 15-minute
# pipeline can ever notice its own silence if its trigger mechanism itself
# goes dark (a dead Vercel cron, a misconfigured secret, etc.) -- that
# requires an INDEPENDENT watchdog. health_check.py's own daily schedule was
# separately measured firing reliably (~108% of nominal over the same
# 14-day window), so it is reused here as that watchdog rather than
# inventing a new, separately-scheduled check with its own reliability
# question mark.
GITHUB_API_BASE = "https://api.github.com"
GITHUB_REPO = "Leninf19/PRYOR-OS"
CRITICAL_ALERT_WORKFLOW_FILE = "critical-alert-check.yml"
CRITICAL_ALERT_STALE_THRESHOLD = timedelta(hours=2)  # generous vs. the intended 15-min cadence -- avoids false alarms from ordinary jitter


def already_notified(conn, notification_type, since: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM notifications_log WHERE notification_type = ? AND sent_at >= ? LIMIT 1",
        (notification_type, since),
    ).fetchone() is not None


def already_notified_for_run(conn, notification_type: str, run_id: int) -> bool:
    """Per-run identity dedup: has THIS run already been alerted on, ever --
    no time window. A run's identity/started_at never change, so once
    alerted there is nothing new to say until its status changes -- and once
    it does (self-resolves, or gets reconciled to 'timed_out'), it stops
    matching the caller's own query entirely, so no further alert of this
    type is even possible."""
    return conn.execute(
        "SELECT 1 FROM notifications_log WHERE notification_type = ? AND related_run_id = ? LIMIT 1",
        (notification_type, run_id),
    ).fetchone() is not None


def log_notification(conn, notification_type, subject, related_run_id=None):
    conn.execute(
        """INSERT INTO notifications_log (sent_at, notification_type, recipient, subject, related_run_id)
           VALUES (?, ?, ?, ?, ?)""",
        (datetime.now(timezone.utc).isoformat(), notification_type, TO_ADDR, subject, related_run_id),
    )


def check_stuck_run(conn, now: datetime) -> str:
    """Alerts on every row still status='running' past STUCK_RUN_THRESHOLD,
    skipping any run already alerted on. Checks every such row (not just the
    single most recent one) so two simultaneously-stuck runs can't hide each
    other."""
    cutoff = (now - STUCK_RUN_THRESHOLD).isoformat()
    rows = conn.execute(
        "SELECT * FROM scraper_runs WHERE status = 'running' AND started_at < ? ORDER BY id",
        (cutoff,),
    ).fetchall()

    sections = []
    for row in rows:
        if already_notified_for_run(conn, "stuck_run", row["id"]):
            continue
        started = datetime.fromisoformat(row["started_at"])
        log_notification(conn, "stuck_run", f"run #{row['id']} stuck since {row['started_at']}",
                          related_run_id=row["id"])
        sections.append(
            f"<h2 style='color:#b91c1c'>Scraper run #{row['id']} appears stuck</h2>"
            f"<p>Started {row['started_at']} ({now - started} ago) and never finished -- "
            f"likely a crash before its final status update was written.</p>"
        )
    return "".join(sections)


def check_stale_pipeline(conn, now: datetime) -> str:
    resend_cutoff = (now - RESEND_WINDOW).isoformat()
    if already_notified(conn, "stale_pipeline", resend_cutoff):
        return ""
    row = conn.execute(
        "SELECT * FROM scraper_runs WHERE status IN ('ok', 'partial') ORDER BY finished_at DESC LIMIT 1"
    ).fetchone()
    if row is None:
        last_finished = None
    else:
        last_finished = datetime.fromisoformat(row["finished_at"])

    if last_finished is not None and now - last_finished < STALE_PIPELINE_THRESHOLD:
        return ""

    log_notification(conn, "stale_pipeline", f"no successful run since {last_finished}")
    if last_finished is None:
        detail = "No successful scraper run found at all."
    else:
        detail = f"Last successful run finished {last_finished.isoformat()} ({now - last_finished} ago)."
    return (
        f"<h2 style='color:#b91c1c'>Scraper pipeline looks stale</h2>"
        f"<p>{detail} Expected at least one successful run every "
        f"~{STALE_PIPELINE_THRESHOLD}. Check whether the cron trigger is still firing.</p>"
    )


def check_critical_alert_pipeline_stale(conn, now: datetime) -> str:
    """Independent watchdog for the 15-minute critical-review-alert pipeline
    (critical-alert-check.yml): queries the GitHub Actions API directly
    (ambient GITHUB_TOKEN, actions:read permission) for that workflow's most
    recent SUCCESSFUL run of any event type -- the native GitHub schedule
    trigger (left enabled) OR the new Vercel-cron-driven workflow_dispatch --
    and alerts if none exists within CRITICAL_ALERT_STALE_THRESHOLD.
    Deliberately `status=success`, never merely `status=completed`: a
    completed-but-FAILED run (e.g. a genuine GBPAuthError, or any other bug)
    means the alert check did NOT actually run successfully -- exactly the
    condition this watchdog exists to catch, so it must never be mistaken
    for evidence of health. A resend-window dedup (like check_stale_pipeline
    above, not per-run-id like check_stuck_run) since "no successful run in
    N hours" is a condition, not a specific row identity."""
    resend_cutoff = (now - RESEND_WINDOW).isoformat()
    if already_notified(conn, "critical_alert_pipeline_stale", resend_cutoff):
        return ""

    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        print("health_check.py: GITHUB_TOKEN not set -- skipping critical-alert-pipeline staleness check")
        return ""

    try:
        resp = requests.get(
            f"{GITHUB_API_BASE}/repos/{GITHUB_REPO}/actions/workflows/{CRITICAL_ALERT_WORKFLOW_FILE}/runs",
            params={"status": "success", "per_page": 1},
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=15,
        )
        resp.raise_for_status()
        runs = resp.json().get("workflow_runs", [])
    except Exception as e:
        # Fails open (never alerts, never crashes health_check.py's other
        # checks) -- a GitHub API hiccup during THIS specific probe is not
        # itself evidence the pipeline is stale, and every other check in
        # this file must still run and be able to send its own email.
        print(f"health_check.py: critical-alert-pipeline staleness check failed to query GitHub API: {e}")
        return ""

    last_run_at = (
        datetime.fromisoformat(runs[0]["created_at"].replace("Z", "+00:00"))
        if runs else None
    )
    if last_run_at is not None and now - last_run_at < CRITICAL_ALERT_STALE_THRESHOLD:
        return ""

    if last_run_at is None:
        detail = "No successful run found at all."
    else:
        detail = f"Last successful run finished {last_run_at.isoformat()} ({now - last_run_at} ago)."

    log_notification(conn, "critical_alert_pipeline_stale", detail)
    return (
        f"<h2 style='color:#b91c1c'>Critical-review-alert pipeline looks stale</h2>"
        f"<p>{detail} Expected a successful run at least every ~15 minutes (via the Vercel "
        f"cron dispatch) or, at minimum, within ~{CRITICAL_ALERT_STALE_THRESHOLD}. Check the "
        f"Vercel cron job (dashboard/api/google/[action].js's cron-critical-alert-check "
        f"action) and confirm GitHub's own schedule trigger for critical-alert-check.yml is "
        f"still enabled.</p>"
    )


def send_email(subject, html):
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"LTA Review Dashboard <{FROM_ADDR}>"
    msg["To"] = TO_ADDR
    msg.attach(MIMEText(html, "html"))
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(FROM_ADDR, APP_PASS)
        smtp.sendmail(FROM_ADDR, TO_ADDR, msg.as_string())


def main():
    """Multi-Tenant Phase 4D revision: --tenant-id is REQUIRED, no default.
    Resolved before any DB connection, so a missing/invalid/unregistered
    tenant fails closed before touching anything."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant whose review database to check. REQUIRED -- no "
                              "default. This script never infers a tenant on its own.")
    args = parser.parse_args()
    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::health_check.py: invalid --tenant-id {args.tenant_id!r}")
        sys.exit(1)
    try:
        db.DB_PATH = tenant_paths.resolve_review_db_path(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::health_check.py: {e}")
        sys.exit(1)

    conn = db.get_connection()
    db.init_schema(conn)
    now = datetime.now(timezone.utc)

    reconciled = provider_sync.reconcile_stuck_runs(conn, now=now)
    for row in reconciled:
        print(f"health_check.py: reconciled run #{row['id']} (started {row['started_at']}) as timed_out")

    sections = [check_stuck_run(conn, now), check_stale_pipeline(conn, now), check_critical_alert_pipeline_stale(conn, now)]
    conn.commit()

    sections = [s for s in sections if s]
    if not sections:
        conn.close()
        print("health_check.py: pipeline healthy")
        return

    if not FROM_ADDR or not APP_PASS:
        conn.close()
        print(f"health_check.py: {len(sections)} issue(s) found but GMAIL_USER/GMAIL_APP_PASSWORD not set, skipping send")
        return

    html = "<html><body style='font-family:sans-serif;max-width:640px;margin:0 auto'>" + "".join(sections) + "</body></html>"
    subject = f"LTA Dashboard Health Alert — {now.strftime('%b %d, %Y')}"
    send_email(subject, html)
    conn.close()
    print(f"health_check.py: sent email with {len(sections)} issue(s)")


if __name__ == "__main__":
    main()
