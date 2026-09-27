"""
notify.py - Notify Agent (Milestone 2).

Runs after validate.py/refresh_analytics.py in the pipeline and sends up to
TWO independent digest emails, split by audience:

- Platform-operational (scraper failures, structural/data-integrity bugs):
  always PLATFORM_TO_ADDR, regardless of which tenant this script runs
  for -- this is infrastructure/pipeline health, never tenant content.
- Tenant-business (per-location rating shifts): recipient resolved per
  tenant via resolve_business_recipient() -- Los Tres Amigos retains its
  historical advertising@l3amigos.com; every other tenant has no
  configured notification recipient yet (a full per-tenant notification-
  settings feature is separate, future work) and is skipped with a logged
  warning, NEVER defaulted to LTA's address. This is a different setting
  from the public review-response contact (reviewContactService.js /
  resolve_review_response_contact() in ai_engine.py) -- that is a
  customer-facing "how do I reach the business" address; this is an
  internal ops-alert recipient, and this file never reads or reuses it.

Each category is dispatched independently via _dispatch_category(): its
notifications_log rows are written ONLY after its own email send succeeds
(never before), so a genuine send failure for one category leaves its
pending items exactly "not yet notified" for the next run to retry --
without touching or duplicating the other category, whose own send may
already have succeeded in the same run. Mirrors the same log-after-success
discipline critical_alert_check.py/nightly_digest.py already established
(see tests/test_notification_pipeline_audit.py) -- extended here to a
script with two independent destinations in one run, so each category's
send is caught locally rather than left to propagate (which would abort
the other category's attempt too).

New low-star reviews have their own dedicated pipeline now: immediate
critical-review alerts (critical_alert_check.py, ~15-20 min) and the
AI-filtered nightly digest (nightly_digest.py, ~10pm ET) -- moved out of
this file so low-star handling isn't split between two independently-tuned
code paths. already_notified/log_notification below are local to this file
(unlike critical_alert_check.py/nightly_digest.py, which share
digest_filters.py's versions).

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

# Platform-operational alerts (scraper failures, data-integrity bugs) --
# never tenant-specific content, so this is never resolved per tenant.
PLATFORM_TO_ADDR = "lenin@futuremark.studio"

# Tenant-business alerts (rating shifts) -- LTA's own historical recipient.
# Never used as a fallback for any other tenant -- see
# resolve_business_recipient() below.
LTA_BUSINESS_TO_ADDR = "advertising@l3amigos.com"

FROM_ADDR = os.environ.get("GMAIL_USER", "")
APP_PASS = os.environ.get("GMAIL_APP_PASSWORD", "")

RATING_DROP_THRESHOLD = 0.2
RATING_DROP_MIN_N = 5
RATING_DROP_RESEND_DAYS = 7
STRUCTURAL_RESEND_HOURS = 24


def resolve_business_recipient(tenant_id: str):
    """Tenant-business (rating-drop) notification recipient. Los Tres
    Amigos is the only tenant with a reviewed recipient today; every other
    tenant has no configured notification-recipient setting yet (a full
    per-tenant notification-settings feature is separate, future work), so
    this returns None rather than ever defaulting to LTA's address.
    Deliberately independent of resolve_review_response_contact() in
    ai_engine.py -- that resolves the PUBLIC, customer-facing
    review-response contact, an unrelated setting this never reads."""
    if tenant_id == tenant_keys.DEFAULT_TENANT_ID:
        return LTA_BUSINESS_TO_ADDR
    return None


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


def log_notification(conn, notification_type, subject, recipient=LTA_BUSINESS_TO_ADDR, *,
                      related_review_id=None, related_location_id=None):
    """recipient defaults to LTA_BUSINESS_TO_ADDR ONLY to preserve this
    function's exact prior behavior for digest_filters.py's re-export
    (`from notify import already_notified, log_notification`), which
    critical_alert_check.py/nightly_digest.py call without ever passing a
    recipient -- both are unchanged by this revision and previously relied
    on this function's old hardcoded module-level TO_ADDR, which held this
    same literal value. _dispatch_category below always passes an explicit
    recipient for notify.py's own two categories."""
    conn.execute(
        """INSERT INTO notifications_log
           (sent_at, notification_type, recipient, subject, related_review_id, related_location_id)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (datetime.now(timezone.utc).isoformat(), notification_type, recipient, subject,
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


def check_scraper_failure(conn) -> tuple[str, list[dict]]:
    """Platform-operational. Returns (html, log_calls); log_calls describes
    the notifications_log row(s) this section needs, written by the caller
    ONLY after this category's email actually sends successfully."""
    run = conn.execute(
        "SELECT * FROM scraper_runs WHERE status IN ('failed', 'partial') "
        "ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if not run:
        return "", []
    if already_notified(conn, "scraper_failure", since=run["started_at"]):
        return "", []

    log_calls = [{"notification_type": "scraper_failure", "subject": f"run #{run['id']}"}]

    # Explicit marker ONLY -- never inferred from zeroed location counters.
    # A row with failure_stage IS NULL (every pre-existing run, and any
    # genuine per-location failure) always falls through to the original
    # per-location template below, even if it happens to show 0 of 0.
    failure_stage = run["failure_stage"] if "failure_stage" in run.keys() else None
    if failure_stage == "account_discovery":
        return _build_global_failure_alert(run), log_calls

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

    html = (
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
    return html, log_calls


def check_rating_drops(conn) -> tuple[str, list[dict]]:
    """Tenant-business. Returns (html, log_calls) -- see check_scraper_failure
    for the deferred-logging contract."""
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
    log_calls = []
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
        log_calls.append({
            "notification_type": "rating_drop",
            "subject": f"{data['name']} {direction}",
            "related_location_id": loc_id,
        })

    if not alerts:
        return "", []
    return f"<h2>Rating shifts (30-day avg)</h2><ul>{''.join(alerts)}</ul>", log_calls


def check_structural_issues(conn) -> tuple[str, list[dict]]:
    """Platform-operational. Returns (html, log_calls) -- see
    check_scraper_failure for the deferred-logging contract."""
    since = (datetime.now(timezone.utc) - timedelta(hours=STRUCTURAL_RESEND_HOURS)).isoformat()
    if already_notified(conn, "duplicate_review_url", since=since):
        return "", []
    count = conn.execute(
        "SELECT COUNT(*) AS c FROM validation_flags WHERE flag_type = 'duplicate_review_url' AND resolved_at IS NULL"
    ).fetchone()["c"]
    if count == 0:
        return "", []
    log_calls = [{"notification_type": "duplicate_review_url", "subject": f"{count} duplicate review_url flags"}]
    html = (
        f"<h2 style='color:#b91c1c'>Data integrity: {count} duplicate review_url flags</h2>"
        f"<p>dedup_key should make this impossible -- check validate.py / validation_flags.</p>"
    )
    return html, log_calls


def send_email(to_addr, subject, html):
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"LTA Review Dashboard <{FROM_ADDR}>"
    msg["To"] = to_addr
    msg.attach(MIMEText(html, "html"))
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(FROM_ADDR, APP_PASS)
        smtp.sendmail(FROM_ADDR, to_addr, msg.as_string())


def _build_digest_html(sections, *, brand_label, header_title, date_label, year_now):
    return (
        '<!DOCTYPE html><html lang="en"><head>'
        '<meta charset="UTF-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1.0">'
        f'<title>{header_title} — {date_label}</title>'
        '</head>'
        '<body style="margin:0;padding:0;background:#f1f5f9;'
        'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;'
        '-webkit-text-size-adjust:100%">'
        '<div style="max-width:640px;margin:0 auto;padding:20px 12px">'

        '<div style="background:#0f172a;border-radius:14px 14px 0 0;padding:28px 32px;text-align:center">'
        f'<p style="margin:0 0 6px;font-size:10px;font-weight:800;letter-spacing:3px;'
        f'color:#f59e0b;text-transform:uppercase">{brand_label}</p>'
        f'<h1 style="margin:0 0 6px;font-size:20px;font-weight:800;color:white">{header_title}</h1>'
        f'<p style="margin:0;font-size:12px;color:#64748b">{date_label}</p>'
        '</div>'

        '<div style="background:white;border-radius:0 0 14px 14px;padding:24px 28px 32px">'
        + "".join(sections)
        + '</div>'

        '<div style="text-align:center;padding:16px 0 4px">'
        f'<p style="font-size:11px;color:#94a3b8;margin:0;line-height:1.6">'
        f'{brand_label} &mdash; Auto-generated alert<br>'
        f'&copy; {year_now} Future Marketing Studio. All rights reserved.</p>'
        '</div>'

        '</div>'
        '</body></html>'
    )


def _dispatch_category(conn, *, category, to_addr, sections, log_calls, brand_label, header_title, date_label, year_now):
    """Builds and sends one category's digest, only when it has reportable
    content and a resolved recipient, and writes its notifications_log rows
    ONLY after the send succeeds. Never raises -- a send failure is caught,
    reported, and returned as "failed" so the OTHER category (a different
    destination entirely) still gets its own independent attempt in the
    same run; main()/run() exits non-zero afterward if either failed, so
    the failure is still visible to CI.

    Returns one of: "sent" / "skipped_empty" / "skipped_no_credentials" /
    "skipped_no_recipient" / "failed"."""
    if not sections:
        return "skipped_empty"
    if to_addr is None:
        print(f"::warning::notify.py: {category} has {len(sections)} section(s) ready but no "
              f"configured recipient for this tenant -- skipping (never falling back to another "
              f"tenant's address)")
        return "skipped_no_recipient"
    if not FROM_ADDR or not APP_PASS:
        print(f"notify.py: {category}: {len(sections)} section(s) ready but GMAIL_USER/"
              f"GMAIL_APP_PASSWORD not set, skipping send")
        return "skipped_no_credentials"

    html = _build_digest_html(sections, brand_label=brand_label, header_title=header_title,
                               date_label=date_label, year_now=year_now)
    subject = f"{header_title} — {date_label}"
    try:
        send_email(to_addr, subject, html)
    except Exception as e:
        print(f"::error::notify.py: {category} email to {to_addr} failed to send -- "
              f"{len(log_calls)} pending notification(s) will retry next run: {e}")
        return "failed"

    for call in log_calls:
        log_notification(conn, recipient=to_addr, **call)
    conn.commit()
    print(f"notify.py: {category}: sent to {to_addr} with {len(sections)} section(s)")
    return "sent"


def run(tenant_id: str) -> dict:
    """Core logic, separate from main()'s argparse/CLI handling -- mirrors
    critical_alert_check.py's/nightly_digest.py's run(tenant_id) convention.
    Dispatches the platform-operational and business categories
    independently (see _dispatch_category) and returns both outcomes."""
    db.DB_PATH = tenant_paths.resolve_review_db_path(tenant_id)
    conn = db.get_connection()
    db.init_schema(conn)

    scraper_html, scraper_log_calls = check_scraper_failure(conn)
    structural_html, structural_log_calls = check_structural_issues(conn)
    rating_html, rating_log_calls = check_rating_drops(conn)

    date_label = datetime.now(timezone.utc).strftime("%B %d, %Y")
    year_now = datetime.now(timezone.utc).year

    platform_sections = [s for s in (scraper_html, structural_html) if s]
    platform_outcome = _dispatch_category(
        conn, category="platform-operational", to_addr=PLATFORM_TO_ADDR,
        sections=platform_sections, log_calls=scraper_log_calls + structural_log_calls,
        brand_label="PRYOR Platform Ops", header_title="Platform Health Alert",
        date_label=date_label, year_now=year_now,
    )

    business_sections = [s for s in (rating_html,) if s]
    business_outcome = _dispatch_category(
        conn, category="business", to_addr=resolve_business_recipient(tenant_id),
        sections=business_sections, log_calls=rating_log_calls,
        brand_label="LTA Review Dashboard", header_title="Dashboard Alert",
        date_label=date_label, year_now=year_now,
    )

    conn.close()
    print(f"notify.py: platform={platform_outcome} business={business_outcome}")
    return {"platform": platform_outcome, "business": business_outcome}


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
        result = run(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::notify.py: {e}")
        sys.exit(1)

    if result["platform"] == "failed" or result["business"] == "failed":
        sys.exit(1)


if __name__ == "__main__":
    main()
