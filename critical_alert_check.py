"""
critical_alert_check.py -- frequent (~15-20 min), lightweight check: syncs
just the newest page of reviews per location via the Google Business Profile
API, classifies anything new/changed, and immediately emails if any
unanswered review is AI-classified 'critical' and hasn't already been
escalated.

Deliberately cheap: no full refresh_analytics.py recompute, no
export_chunks.py -- the dashboard's own data still refreshes on the main
update-reviews.yml cadence. This is purely an early-warning tripwire; the
same critical review still appears in the 10pm digest too, marked
"Previously Escalated" (see digest_filters.is_already_escalated()).
"""
import os
import smtplib
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import argparse
import sys

import ai_engine
import db
import digest_filters
import gbp_sync
import tenant_keys
import tenant_paths

TO_ADDR = "advertising@l3amigos.com"
FROM_ADDR = os.environ.get("GMAIL_USER", "")
APP_PASS = os.environ.get("GMAIL_APP_PASSWORD", "")

CLASSIFY_LIMIT = 50  # this path only ever needs to classify a handful of brand-new reviews

# The exact, known production condition (Google Cloud project 786038057684):
# a 429/RESOURCE_EXHAUSTED at account/location discovery, distinct from a
# genuine auth failure -- reconnecting Google Business Profile does nothing
# for this, so the message must never suggest it does.
GBP_QUOTA_BLOCK_MESSAGE = "GBP sync unavailable due to Google API quota block. Continuing with database fallback."


def _describe_sync_failure(sync_result: dict) -> str:
    """Diagnostics-only -- explains WHY a sync failed as specifically as
    possible, replacing the previous `sync failed -- {sync_result.get('errors')}`,
    which silently printed None whenever the failure happened at account/
    location discovery: provider_sync.py's sync_all() returns that failure's
    message under the 'reason' key, never 'errors' (which is only populated
    for a different failure shape -- a per-location review-fetch failure
    after discovery already succeeded). Pure function: never raises, never
    mutates sync_result, and has no bearing on run()'s control flow -- the
    database fallback below always runs regardless of what this returns."""
    error_type = sync_result.get("error_type")
    status = sync_result.get("error_status")
    detail = sync_result.get("reason")
    if detail is None:
        errors = sync_result.get("errors")
        detail = "; ".join(errors) if errors else "no error detail available"

    if error_type == "GBPRateLimitError" or status == 429:
        return f"{GBP_QUOTA_BLOCK_MESSAGE} (detail: {detail})"

    if error_type == "GBPAuthError" or status == 401:
        return (f"GBP sync failed due to a Google authentication error (detail: {detail}). "
                f"Reconnect Google Business Profile from Settings if this persists. "
                f"Continuing with database fallback.")

    # Anything else is genuinely unclassified from this caller's perspective
    # -- surface everything known about it (never just None) plus a
    # traceback when one was captured, so it's actually debuggable.
    message = (f"GBP sync failed with an unexpected error -- type={error_type or 'unknown'}, "
               f"status={status}, message={detail}. Continuing with database fallback.")
    tb = sync_result.get("error_traceback")
    if tb:
        message = f"{message}\n{tb}"
    return message


def _send_email(subject: str, html: str) -> None:
    if not FROM_ADDR or not APP_PASS:
        print("critical_alert_check.py: GMAIL_USER/GMAIL_APP_PASSWORD not set -- skipping send")
        return
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"LTA Review Dashboard <{FROM_ADDR}>"
    msg["To"] = TO_ADDR
    msg.attach(MIMEText(html, "html"))
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(FROM_ADDR, APP_PASS)
        smtp.sendmail(FROM_ADDR, TO_ADDR, msg.as_string())


def _build_html(reviews: list) -> str:
    cards = ""
    for r in reviews:
        reason_html = (
            f'<p style="margin:0;color:#991b1b"><strong>Why flagged:</strong> {r["ai_sentiment_reason"]}</p>'
            if r.get("ai_sentiment_reason") else ""
        )
        cards += f"""
        <div style="border:1px solid #f87171;border-radius:8px;padding:16px;margin-bottom:12px;background:#fef2f2">
          <p style="margin:0 0 4px;font-weight:600">{r['location_name']} — {r['star_rating'] or '?'}★ from {r['reviewer_name'] or 'Anonymous'}</p>
          <p style="margin:0 0 8px;color:#555">{r['review_date']}</p>
          <p style="margin:0 0 8px">{r['review_text'] or ''}</p>
          {reason_html}
        </div>"""
    return f"""<html><body style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto">
      <div style="background:#991b1b;color:white;padding:20px">
        <p style="margin:0;font-size:10px;letter-spacing:0.15em;text-transform:uppercase;opacity:0.85">LTA Review Dashboard</p>
        <h1 style="margin:8px 0 0;font-size:20px">Critical Review Alert</h1>
      </div>
      <div style="padding:20px">
        <p>{len(reviews)} review(s) just flagged <strong>critical priority</strong> (safety, legal, injury,
        or discrimination concerns) and need immediate attention:</p>
        {cards}
      </div>
    </body></html>"""


def run(tenant_id: str) -> dict:
    """Multi-Tenant Phase 4C/4D revision: tenant_id is REQUIRED -- no
    default. Validated before any DB connection or GBP sync call, then
    this tenant's own review database is resolved (Phase 4D), so a
    missing/invalid/unregistered tenant fails closed before touching
    anything."""
    tenant_keys.assert_valid_tenant_id(tenant_id, "critical_alert_check.run")
    db.DB_PATH = tenant_paths.resolve_review_db_path(tenant_id)

    conn = db.get_connection()
    db.init_schema(conn)
    print("[critical_alert_check] stage=start")

    # Root-cause fix (production audit): a GBP sync outcome of ANY kind --
    # 'skipped' (not configured) or 'failed' (quota block, auth error,
    # anything else) -- must NEVER suppress the scraper-based critical-
    # review check below. This used to return early on 'skipped' only
    # (the 'failed' branch already correctly fell through) -- meaning if
    # GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET were ever entirely absent
    # (not just an invalid/expired token), the database fallback check
    # never ran at all. sync_reviews.py's own scraper-provider run
    # (update-reviews.yml) is what actually populates new reviews; this
    # GBP attempt is a secondary, optional source for this specific check.
    sync_result = gbp_sync.sync_all(tenant_id=tenant_id, fast=True)
    status = sync_result.get("status")
    if status == "skipped":
        print(f"[critical_alert_check] stage=gbp_sync result=skipped reason={sync_result.get('reason')}")
    elif status == "failed":
        print(f"[critical_alert_check] stage=gbp_sync result=failed detail={_describe_sync_failure(sync_result)}")
    else:
        print(f"[critical_alert_check] stage=gbp_sync result=ok")

    if ai_engine.is_available():
        to_classify = db.get_reviews_needing_classification(conn, limit=CLASSIFY_LIMIT)
        print(f"[critical_alert_check] stage=ai_classification to_classify={len(to_classify)}")
        if to_classify:
            classified = ai_engine.classify_reviews_batch(to_classify)
            for r in to_classify:
                result = classified.get(r["id"])
                if not result:
                    continue
                content_hash = db.review_content_hash(r["review_text"], r["star_rating"])
                db.save_ai_classification(conn, r["id"], result["sentiment"], result["reason"],
                                           result["priority"], content_hash)
            conn.commit()
            print(f"[critical_alert_check] stage=ai_classification classified={len(classified)}/{len(to_classify)}")
    else:
        print("[critical_alert_check] stage=ai_classification result=skipped reason=ai_engine_unavailable")

    critical = digest_filters.find_unescalated_critical_reviews(conn)
    print(f"[critical_alert_check] stage=find_unescalated_critical count={len(critical)}")
    if not critical:
        print("critical_alert_check.py: no new critical reviews. Nothing to send.")
        return {"status": "ok", "sent": 0}

    subject = f"Critical Review Alert — {len(critical)} review(s) need immediate attention"

    # Root-cause fix (production audit): logging used to happen unconditionally
    # after calling _send_email(), but _send_email() silently no-ops (prints
    # and returns, does not raise) when GMAIL_USER/GMAIL_APP_PASSWORD are
    # missing -- meaning these critical reviews would have been marked
    # "notified" forever even though no email was ever sent. A genuine SMTP
    # failure (a real exception from _send_email()) already correctly
    # prevents logging today (the exception propagates before the loop
    # below runs); this closes the missing-credentials gap the same way.
    if not FROM_ADDR or not APP_PASS:
        print(f"[critical_alert_check] stage=send result=no_credentials pending={len(critical)}")
        return {"status": "ready_no_credentials", "sent": 0, "pending": len(critical)}

    _send_email(subject, _build_html(critical))
    print(f"[critical_alert_check] stage=send result=success count={len(critical)}")

    for r in critical:
        digest_filters.log_notification(
            conn, "critical_review_immediate", subject,
            related_review_id=r["id"], related_location_id=r["location_id"],
        )
    conn.commit()
    print(f"critical_alert_check.py: sent immediate alert for {len(critical)} critical review(s).")
    return {"status": "ok", "sent": len(critical)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant to check. REQUIRED -- no default. The calling workflow "
                              "must pass this explicitly (e.g. --tenant-id t_los-tres-amigos); this "
                              "script never infers a tenant on its own.")
    args = parser.parse_args()
    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::critical_alert_check.py: invalid --tenant-id {args.tenant_id!r}")
        sys.exit(1)
    try:
        run(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::critical_alert_check.py: {e}")
        sys.exit(1)
