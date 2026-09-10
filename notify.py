"""
notify.py - Notify Agent (Milestone 2).

Runs after validate.py/refresh_analytics.py in the pipeline and sends a
single digest email covering whatever needs a human's attention right now:
scraper failures, per-location rating drops, and structural data bugs
(duplicate review URLs). Every alert type is deduped via notifications_log
so the same underlying issue doesn't re-notify every ~6h run -- only
genuinely new information re-triggers an email.

New low-star reviews have their own dedicated pipeline now: immediate
critical-review alerts (critical_alert_check.py, ~15-20 min) and the
AI-filtered nightly digest (nightly_digest.py, ~10pm ET) -- moved out of
this file so low-star handling isn't split between two independently-tuned
code paths. already_notified/log_notification below are still shared with
both via digest_filters.py.

Reuses weekly_report.py's exact Gmail SMTP pattern (same env vars, same
"from" display name) rather than inventing a second mailer.
"""
import argparse
import html as _html
import os
import re
import smtplib
import sys
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import db
import tenant_keys
import tenant_paths

TO_ADDR = "advertising@l3amigos.com"
FROM_ADDR = os.environ.get("GMAIL_USER", "")
APP_PASS = os.environ.get("GMAIL_APP_PASSWORD", "")

RATING_DROP_THRESHOLD = 0.2
RATING_DROP_MIN_N = 5
RATING_DROP_RESEND_DAYS = 7
STRUCTURAL_RESEND_HOURS = 24


def already_notified(conn, notification_type, *, related_review_id=None, related_location_id=None, since=None) -> bool:
    query = "SELECT 1 FROM notifications_log WHERE notification_type = ?"
    params = [notification_type]
    if related_review_id is not None:
        query += " AND related_review_id = ?"
        params.append(related_review_id)
    if related_location_id is not None:
        query += " AND related_location_id = ?"
        params.append(related_location_id)
    if since is not None:
        query += " AND sent_at >= ?"
        params.append(since)
    return conn.execute(query + " LIMIT 1", params).fetchone() is not None


def log_notification(conn, notification_type, subject, *, related_review_id=None, related_location_id=None):
    conn.execute(
        """INSERT INTO notifications_log
           (sent_at, notification_type, recipient, subject, related_review_id, related_location_id)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (datetime.now(timezone.utc).isoformat(), notification_type, TO_ADDR, subject,
         related_review_id, related_location_id),
    )


def _safe(s) -> str:
    return _html.escape(str(s or ""), quote=False)


def _sanitize_error_message(msg: str) -> str:
    """Defense-in-depth before an error message ever reaches an email body.
    google_api.py's own error text never embeds a credential (verified),
    but this strips anything that LOOKS like a token/secret/client-id
    regardless, in case a future error path or a raw Google response ever
    does."""
    msg = re.sub(r"ya29\.[\w\-.]+", "[REDACTED]", msg)
    msg = re.sub(r"GOCSPX-[\w-]+", "[REDACTED]", msg)
    msg = re.sub(r"[\w-]{10,}\.apps\.googleusercontent\.com", "[REDACTED-CLIENT-ID]", msg)
    msg = re.sub(r"1//[\w\-]+", "[REDACTED]", msg)  # refresh-token-shaped strings
    return msg


def _parse_global_error(raw: str) -> dict:
    """Best-effort structured extraction from google_api.py's own
    "Google API {status}: {message}" format (and the "service
    'x.googleapis.com'" substring Google's quota errors include). Degrades
    gracefully to "unknown"/a generic service name rather than guessing --
    this only ever reads text our own code already produced deterministically
    for the common cases; anything else falls back safely."""
    status_match = re.search(r"Google API (\d{3}):", raw)
    service_match = re.search(r"service '([\w.\-]+)'", raw)
    return {
        "status": status_match.group(1) if status_match else "unknown",
        "service": service_match.group(1) if service_match else "Google Business Profile API",
    }


def _build_global_failure_alert(run) -> str:
    """Template for a failure at account/location discovery -- before any
    restaurant location was even known, so there is no per-location detail
    to show and no "affected locations" list to build. Distinct from the
    per-location scrape-failure template below; only used when
    failure_stage is the explicit 'account_discovery' marker (never
    inferred from zeroed counters -- see check_scraper_failure())."""
    raw = (run["error_summary"] or "").strip()
    parsed = _parse_global_error(raw)
    safe_message = _safe(_sanitize_error_message(raw)[:500])
    workflow = os.environ.get("GITHUB_WORKFLOW", "review sync pipeline")
    when = run["finished_at"] or run["started_at"] or "unknown time"

    next_step = (
        "This is expected while Google Business Profile API quota approval is pending. "
        "Check Google Cloud Console → APIs & Services → the service above → Quotas, and confirm "
        "whether a quota increase request has been submitted and granted -- API access approval "
        "and quota approval are often separate steps."
        if parsed["status"] == "429" else
        "Check the GitHub Actions logs for this run for the full error detail."
    )

    return (
        '<div style="background:#fff7ed;border-left:4px solid #f97316;'
        'padding:20px 24px;margin-bottom:24px;border-radius:0 10px 10px 0">'
        '<p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#c2410c;'
        'text-transform:uppercase;letter-spacing:0.08em">Global API Connection Failure</p>'
        '<h2 style="margin:0 0 12px;font-size:16px;font-weight:700;color:#7c2d12">'
        '⚠️ Location discovery could not begin</h2>'
        f'<p style="margin:0 0 12px;font-size:13px;color:#1e293b;line-height:1.6">'
        f'Location discovery could not begin because the Google Business Profile '
        f'{_safe(parsed["service"])} returned HTTP {_safe(parsed["status"])}.</p>'
        '<table style="width:100%;font-size:13px;color:#374151;margin-bottom:12px" cellpadding="4">'
        f'<tr><td style="font-weight:600;width:170px">Workflow</td><td>{_safe(workflow)}</td></tr>'
        f'<tr><td style="font-weight:600">Time of failure</td><td>{_safe(when)}</td></tr>'
        f'<tr><td style="font-weight:600">Service</td><td>{_safe(parsed["service"])}</td></tr>'
        f'<tr><td style="font-weight:600">HTTP status</td><td>{_safe(parsed["status"])}</td></tr>'
        f'<tr><td style="font-weight:600">Error message</td><td>{safe_message}</td></tr>'
        f'<tr><td style="font-weight:600">Previous review data</td>'
        f'<td>Retained — nothing was overwritten or erased. This failure happened before any '
        f'location or review data was touched.</td></tr>'
        '</table>'
        f'<p style="margin:0;font-size:13px;color:#475569;line-height:1.6">'
        f'<strong>Recommended next step:</strong> {next_step}</p>'
        '</div>'
    )


def check_scraper_failure(conn) -> str:
    run = conn.execute(
        "SELECT * FROM scraper_runs WHERE status IN ('failed', 'partial') "
        "ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if not run:
        return ""
    if already_notified(conn, "scraper_failure", since=run["started_at"]):
        return ""
    log_notification(conn, "scraper_failure", f"run #{run['id']}")

    # Explicit marker ONLY -- never inferred from zeroed location counters.
    # A row with failure_stage IS NULL (every pre-existing run, and any
    # genuine per-location failure) always falls through to the original
    # per-location template below, even if it happens to show 0 of 0.
    failure_stage = run["failure_stage"] if "failure_stage" in run.keys() else None
    if failure_stage == "account_discovery":
        return _build_global_failure_alert(run)

    ok = run["locations_succeeded"] or 0
    failed = run["locations_failed"] or 0
    total = run["locations_attempted"] or 0
    raw = (run["error_summary"] or "").strip()

    # Categorise errors into human-readable buckets
    tab_errors, timeout_errors, other_errors = [], [], []
    for part in raw.split(";"):
        part = part.strip()
        if not part:
            continue
        loc = part.split(":", 1)[0].strip()
        detail = part.split(":", 1)[1].strip() if ":" in part else part
        if "reviews tab not found" in detail.lower() or "no reviews tab" in detail.lower():
            tab_errors.append(loc)
        elif "timeout" in detail.lower() or "timed out" in detail.lower():
            timeout_errors.append(loc)
        else:
            other_errors.append(part)

    # Build a plain-English explanation
    if tab_errors and not timeout_errors and not other_errors:
        cause = (
            f"The scraper could not find the <strong>Reviews section</strong> for "
            f"{len(tab_errors)} location(s). This usually happens when Google Maps "
            f"updates its page layout or a location loads slowly. "
            f"The other {ok} location(s) scraped successfully."
        )
        fix = (
            "This often resolves on the next automatic run. If the same locations "
            "keep failing for several days in a row, the scraper selectors may need updating."
        )
        affected = tab_errors
    elif timeout_errors:
        cause = (
            f"{len(timeout_errors)} location(s) timed out — the page took too long to load. "
            f"This can happen when GitHub Actions or Google Maps responds slowly. "
            f"{ok} of {total} locations completed successfully."
        )
        fix = "No action needed — the next scheduled run will retry these locations automatically."
        affected = timeout_errors + tab_errors + other_errors
    else:
        cause = f"{failed} of {total} locations encountered an error during this scrape run. {ok} succeeded."
        fix = raw or "Check the GitHub Actions logs for the full error detail."
        affected = other_errors + tab_errors + timeout_errors

    affected_html = "".join(f"<li style='margin:4px 0'>{loc}</li>" for loc in affected[:20])
    if len(affected) > 20:
        affected_html += f"<li style='color:#94a3b8'>…and {len(affected)-20} more</li>"

    status_label = "Partial scrape — some locations failed" if run["status"] == "partial" else "Scraper run failed"

    return (
        '<div style="background:#fff7ed;border-left:4px solid #f97316;'
        'padding:20px 24px;margin-bottom:24px;border-radius:0 10px 10px 0">'
        f'<p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#c2410c;'
        f'text-transform:uppercase;letter-spacing:0.08em">Scraper Alert</p>'
        f'<h2 style="margin:0 0 12px;font-size:16px;font-weight:700;color:#7c2d12">'
        f'⚠️ {status_label}</h2>'
        f'<p style="margin:0 0 8px;font-size:13px;color:#1e293b;line-height:1.6">{cause}</p>'
        f'<p style="margin:0 0 12px;font-size:13px;color:#475569;line-height:1.6">'
        f'<strong>What to do:</strong> {fix}</p>'
        + (
            f'<p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#7c2d12">'
            f'Affected locations:</p>'
            f'<ul style="margin:0;padding-left:20px;font-size:13px;color:#374151">'
            f'{affected_html}</ul>'
            if affected else ''
        )
        + '</div>'
    )


def check_rating_drops(conn) -> str:
    today = datetime.now(timezone.utc).date().isoformat()
    d30 = (datetime.now(timezone.utc) - timedelta(days=30)).date().isoformat()
    d60 = (datetime.now(timezone.utc) - timedelta(days=60)).date().isoformat()
    resend_cutoff = (datetime.now(timezone.utc) - timedelta(days=RATING_DROP_RESEND_DAYS)).isoformat()

    rows = conn.execute(
        """SELECT r.location_id, l.name AS location_name, r.star_rating, r.review_date
           FROM reviews r JOIN locations l ON l.id = r.location_id
           WHERE r.is_deleted = 0 AND r.star_rating IS NOT NULL AND r.review_date >= ?""",
        (d60,),
    ).fetchall()

    by_loc = {}
    for r in rows:
        by_loc.setdefault(r["location_id"], {"name": r["location_name"], "cur": [], "prev": []})
        if r["review_date"] >= d30:
            by_loc[r["location_id"]]["cur"].append(r["star_rating"])
        else:
            by_loc[r["location_id"]]["prev"].append(r["star_rating"])

    alerts = []
    for loc_id, data in by_loc.items():
        cur, prev = data["cur"], data["prev"]
        if len(cur) < RATING_DROP_MIN_N or len(prev) < RATING_DROP_MIN_N:
            continue
        avg_cur = sum(cur) / len(cur)
        avg_prev = sum(prev) / len(prev)
        delta = avg_cur - avg_prev
        if abs(delta) < RATING_DROP_THRESHOLD:
            continue
        if already_notified(conn, "rating_drop", related_location_id=loc_id, since=resend_cutoff):
            continue
        direction = "dropped" if delta < 0 else "improved"
        alerts.append(
            f"<li><strong>{data['name']}</strong> {direction}: "
            f"{avg_prev:.2f}★ → {avg_cur:.2f}★ (30d avg, {len(prev)} vs {len(cur)} reviews)</li>"
        )
        log_notification(conn, "rating_drop", f"{data['name']} {direction}", related_location_id=loc_id)

    if not alerts:
        return ""
    return f"<h2>Rating shifts (30-day avg)</h2><ul>{''.join(alerts)}</ul>"


def check_structural_issues(conn) -> str:
    since = (datetime.now(timezone.utc) - timedelta(hours=STRUCTURAL_RESEND_HOURS)).isoformat()
    if already_notified(conn, "duplicate_review_url", since=since):
        return ""
    count = conn.execute(
        "SELECT COUNT(*) AS c FROM validation_flags WHERE flag_type = 'duplicate_review_url' AND resolved_at IS NULL"
    ).fetchone()["c"]
    if count == 0:
        return ""
    log_notification(conn, "duplicate_review_url", f"{count} duplicate review_url flags")
    return (
        f"<h2 style='color:#b91c1c'>Data integrity: {count} duplicate review_url flags</h2>"
        f"<p>dedup_key should make this impossible -- check validate.py / validation_flags.</p>"
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
        print(f"::error::notify.py: invalid --tenant-id {args.tenant_id!r}")
        sys.exit(1)
    try:
        db.DB_PATH = tenant_paths.resolve_review_db_path(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::notify.py: {e}")
        sys.exit(1)

    conn = db.get_connection()
    db.init_schema(conn)

    sections = [
        check_scraper_failure(conn),
        check_rating_drops(conn),
        check_structural_issues(conn),
    ]
    conn.commit()

    sections = [s for s in sections if s]
    if not sections:
        conn.close()
        print("notify.py: nothing to report")
        return

    if not FROM_ADDR or not APP_PASS:
        conn.close()
        print(f"notify.py: {len(sections)} section(s) ready but GMAIL_USER/GMAIL_APP_PASSWORD not set, skipping send")
        return

    date_label = datetime.now(timezone.utc).strftime("%B %d, %Y")
    year_now   = datetime.now(timezone.utc).year
    html = (
        '<!DOCTYPE html><html lang="en"><head>'
        '<meta charset="UTF-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1.0">'
        f'<title>LTA Dashboard Alert — {date_label}</title>'
        '</head>'
        '<body style="margin:0;padding:0;background:#f1f5f9;'
        'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;'
        '-webkit-text-size-adjust:100%">'
        '<div style="max-width:640px;margin:0 auto;padding:20px 12px">'

        '<div style="background:#0f172a;border-radius:14px 14px 0 0;padding:28px 32px;text-align:center">'
        '<p style="margin:0 0 6px;font-size:10px;font-weight:800;letter-spacing:3px;'
        'color:#f59e0b;text-transform:uppercase">LTA Review Dashboard</p>'
        '<h1 style="margin:0 0 6px;font-size:20px;font-weight:800;color:white">Dashboard Alert</h1>'
        f'<p style="margin:0;font-size:12px;color:#64748b">{date_label}</p>'
        '</div>'

        '<div style="background:white;border-radius:0 0 14px 14px;padding:24px 28px 32px">'
        + "".join(sections)
        + '</div>'

        '<div style="text-align:center;padding:16px 0 4px">'
        f'<p style="font-size:11px;color:#94a3b8;margin:0;line-height:1.6">'
        f'LTA Review Dashboard &mdash; Auto-generated alert<br>'
        f'&copy; {year_now} Future Marketing Studio. All rights reserved.</p>'
        '</div>'

        '</div>'
        '</body></html>'
    )
    subject = f"LTA Dashboard Alert — {date_label}"
    send_email(subject, html)
    conn.close()
    print(f"notify.py: sent email with {len(sections)} section(s)")


if __name__ == "__main__":
    main()
