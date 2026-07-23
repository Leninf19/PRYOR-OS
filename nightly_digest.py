"""
nightly_digest.py - Nightly negative-review digest (~10pm ET).

Replaces notify.py's old "New Low-Star Reviews" section with a dedicated,
AI-filtered digest: one professional email covering every new, *meaningful*
1-2 star review (empty / stars-only / generic one-word reviews like "Bad" are
excluded -- see digest_filters.is_meaningful_review), grouped by location.
Critical reviews are included but labeled "Previously Escalated" if
critical_alert_check.py already sent them through the immediate path --
this digest never re-alarms on something already handled.

GitHub Actions cron is UTC-only and not DST-aware, so nightly-digest.yml
ships two cron entries bracketing 10pm ET across DST. This script is what
actually decides whether "now" is really 10pm America/New_York and exits
quietly if the firing that invoked it isn't the real one -- --force bypasses
that gate for manual/workflow_dispatch runs and testing.

Dedup and "is this meaningful/critical" logic is shared with
critical_alert_check.py via digest_filters.py, not reimplemented here.
"""
import argparse
import html as _html
import os
import re
import smtplib
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from zoneinfo import ZoneInfo

import db
from digest_filters import already_notified, is_meaningful_review, is_already_escalated, log_notification

TO_ADDR = "advertising@l3amigos.com"
FROM_ADDR = os.environ.get("GMAIL_USER", "")
APP_PASS = os.environ.get("GMAIL_APP_PASSWORD", "")

NOTIFICATION_TYPE = "nightly_digest_review"
TARGET_HOUR_ET = 22

# Root-cause fix (production audit): this gate used to require the EXACT
# hour (`now_et.hour == TARGET_HOUR_ET`), on the assumption that GitHub
# Actions' cron delay would be small (a few minutes). In production it is
# not -- this repo's actual scheduled firings have consistently landed
# 3-4 hours after both cron entries (02:00/03:00 UTC), i.e. around 1-2 AM
# ET, never at hour 22. Confirmed via live run logs: every single scheduled
# run printed {'status': 'skipped_wrong_hour', 'hour_et': 1 or 2} --
# meaning this gate had NEVER once let a real firing through, and zero
# 'nightly_digest_review' notifications exist anywhere in this project's
# history. A wide overnight window tolerates that delay (and any similar
# future delay) while still rejecting a stray daytime trigger. Per-review
# dedup (already_notified/log_notification, keyed by review id) is what
# actually prevents duplicate content if both cron entries land in-window
# on the same night -- this window is intentionally generous, not exact.
VALID_HOURS_ET = {20, 21, 22, 23, 0, 1, 2, 3, 4}


# ---- rendering helpers (mirrors notify.py's review-card style; only used
# here now that the low-star section has moved out of notify.py) ----

def _safe(s):
    return _html.escape(str(s or ""), quote=False)


def _stars_bar(n):
    n = max(0, min(5, int(n or 0)))
    return (
        '<span style="color:#f59e0b;font-size:17px;letter-spacing:2px">' + "&#9733;" * n + "</span>"
        + '<span style="color:#d1d5db;font-size:17px;letter-spacing:2px">' + "&#9734;" * (5 - n) + "</span>"
    )


def _fmt_date(s):
    try:
        from datetime import date as _d
        return _d.fromisoformat(str(s or "")[:10]).strftime("%B %d, %Y")
    except Exception:
        return str(s or "Unknown date")


def _nl2p(text):
    escaped = _html.escape(str(text or ""), quote=False)
    normalized = re.sub(r'\n{2,}', '\n\n', escaped.strip())
    parts = [p.strip() for p in normalized.split('\n\n') if p.strip()]
    if not parts:
        return '<span style="color:#94a3b8;font-style:normal">No written content.</span>'
    if len(parts) == 1:
        return parts[0].replace('\n', '<br>')
    return "".join(f'<p style="margin:0 0 12px 0">{p.replace(chr(10), "<br>")}</p>' for p in parts)


_TOPIC_MAP = [
    ("Service",         ["server", "staff", "waiter", "waitress", "employee"]),
    ("Wrong Order",     ["wrong order", "wrong dish", "incorrect order", "messed up"]),
    ("Wait Time",       ["wait", "slow", "long time", "forever", "took too long"]),
    ("Refills",         ["refill", "refills"]),
    ("Food Quality",    ["cold food", "bland", "raw", "overcooked", "stale", "undercooked"]),
    ("Cleanliness",     ["dirty", "filthy", "cockroach", "roach", "rat", "pest", "gross"]),
    ("Payment/Receipt", ["card machine", "payment", "receipt", "cash"]),
    ("Atmosphere",      ["atmosphere", "noisy", "loud", "crowded", "parking"]),
    ("Health Concern",  ["sick", "ill", "vomit", "food poison", "diarrhea", "hospital"]),
    ("Price / Value",   ["expensive", "overpriced", "overcharged"]),
    ("Staff Attitude",  ["rude", "hostile", "disrespectful", "unprofessional"]),
]
_ACTION_MAP = [
    (["server", "staff", "waiter", "waitress", "employee"],    "Identify the staff member involved and follow up with management."),
    (["wrong order", "wrong dish", "incorrect", "messed up"],  "Review order accuracy procedures with the kitchen team."),
    (["refill"],                                                "Reinforce refill and table-check standards with front-of-house staff."),
    (["card machine", "payment", "receipt"],                    "Inspect payment terminals and ensure receipts are available on request."),
    (["dirty", "filthy", "cockroach", "roach", "rat", "pest"], "Schedule an immediate deep-clean and pest inspection."),
    (["sick", "food poison", "vomit", "hospital"],              "Escalate to management — potential food safety issue. Contact advertising@l3amigos.com."),
    (["wait", "slow", "long time", "forever"],                  "Review staffing levels and service pace during peak hours."),
    (["rude", "hostile", "disrespectful"],                      "Address customer service standards with the team."),
]


def _topics(text):
    if not text:
        return []
    lower = text.lower()
    return [t for t, kws in _TOPIC_MAP if any(kw in lower for kw in kws)][:6]


def _actions(text, stars):
    if not text:
        return []
    lower = text.lower()
    found = [a for kws, a in _ACTION_MAP if any(kw in lower for kw in kws)]
    if int(stars or 0) == 1:
        found.append("Consider reaching out directly to the customer to offer a resolution.")
    return found[:5] or ["Draft a professional, empathetic reply on Google."]


_PRIORITY_CHIP = {
    "critical": ("#dc2626", "#fff1f2", "Critical"),
    "high":     ("#f97316", "#fff7ed", "High Priority"),
    "medium":   ("#d97706", "#fffbeb", "Medium Priority"),
    "low":      ("#64748b", "#f8fafc", "Low Priority"),
}


def _review_card(r, escalated: bool) -> str:
    """One review's full HTML card -- reviewer, stars, full (untruncated)
    text, detected topics, recommended actions, quick links, plus an
    AI-priority chip and (if applicable) a "Previously Escalated" ribbon."""
    reviewer = _safe(r.get("reviewer_name") or "Anonymous")
    stars    = int(r.get("star_rating") or 0)
    date_s   = _fmt_date(r.get("review_date"))
    text     = (r.get("review_text") or "").strip()
    url      = r.get("review_url") or ""
    maps_url = r.get("maps_url") or ""
    priority = (r.get("ai_priority") or "").lower()

    accent, badge_bg, sentiment = ('#dc2626', '#fff1f2', 'Very Negative') if stars <= 1 else ('#f97316', '#fff7ed', 'Negative')
    p_accent, p_bg, p_label = _PRIORITY_CHIP.get(priority, ('#64748b', '#f8fafc', None))

    topics  = _topics(text)
    actions = _actions(text, stars)

    chips = "".join(
        '<span style="display:inline-block;background:#f0f9ff;color:#0369a1;'
        'border:1px solid #bae6fd;border-radius:20px;padding:3px 12px;margin:3px;'
        f'font-size:12px;font-weight:600">{t}</span>'
        for t in topics
    ) if topics else '<span style="font-size:12px;color:#94a3b8;font-style:italic">None detected</span>'

    action_rows = "".join(
        '<tr>'
        '<td style="width:14px;vertical-align:top;padding:4px 0;color:#d97706;font-size:13px">&#8226;</td>'
        f'<td style="padding:4px 0 4px 8px;font-size:13px;color:#1e293b;line-height:1.55">{a}</td>'
        '</tr>'
        for a in actions
    )
    actions_section = (
        '<tr><td style="padding:14px 22px;border-bottom:1px solid #f1f5f9">'
        '<p style="margin:0 0 8px;font-size:10px;font-weight:700;color:#64748b;'
        'text-transform:uppercase;letter-spacing:.08em">Recommended Actions</p>'
        f'<table width="100%" cellpadding="0" cellspacing="0">{action_rows}</table>'
        '</td></tr>'
    ) if action_rows else ""

    links = ""
    if url:
        links += (
            f'<a href="{_safe(url)}" style="display:inline-block;background:#0f172a;color:white;'
            'text-decoration:none;border-radius:7px;padding:9px 16px;font-size:12px;font-weight:600;'
            'margin-right:8px;margin-bottom:6px">&#128279;&nbsp;View Review</a>'
        )
    if maps_url:
        links += (
            f'<a href="{_safe(maps_url)}" style="display:inline-block;background:#f59e0b;color:#0f172a;'
            'text-decoration:none;border-radius:7px;padding:9px 16px;font-size:12px;font-weight:600;'
            'margin-bottom:6px">&#128205;&nbsp;View on Google Maps</a>'
        )

    review_body = _nl2p(text) if text else '<span style="color:#94a3b8;font-style:normal">Rating only — no written review.</span>'

    escalated_ribbon = (
        '<tr><td style="background:#eff6ff;border-bottom:1px solid #bfdbfe;padding:8px 22px">'
        '<span style="font-size:11px;font-weight:700;color:#1d4ed8">&#128276;&nbsp;PREVIOUSLY ESCALATED — '
        'sent immediately when detected; included here for the nightly record.</span>'
        '</td></tr>'
    ) if escalated else ""

    priority_chip_html = (
        f'<span style="background:{p_bg};color:{p_accent};border-radius:6px;padding:4px 10px;'
        f'font-size:11px;font-weight:700;margin-right:6px">{p_label}</span>'
    ) if p_label else ""

    return "".join([
        '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;'
        'border:1.5px solid #e2e8f0;border-radius:12px;overflow:hidden;background:white;'
        'border-collapse:separate">',

        escalated_ribbon,

        '<tr><td style="background:#0f172a;padding:16px 22px;border-radius:'
        + ('0' if escalated else '12px 12px') + ' 0 0">',
        '<table width="100%" cellpadding="0" cellspacing="0"><tr>',
        '<td><p style="margin:0 0 2px;font-size:12px;font-weight:700;color:#f59e0b;'
        'text-transform:uppercase;letter-spacing:.06em">New Low-Star Review</p>',
        f'<p style="margin:0;font-size:15px;font-weight:700;color:white">{_safe(r.get("location_name") or "")}</p></td>',
        '<td style="text-align:right;white-space:nowrap">',
        priority_chip_html,
        f'<span style="background:{badge_bg};color:{accent};border-radius:6px;'
        f'padding:5px 12px;font-size:12px;font-weight:700">{stars}&#9733;&nbsp;{sentiment}</span>',
        '</td></tr></table></td></tr>',

        '<tr><td style="padding:10px 22px 12px;background:#f8fafc;border-bottom:1px solid #f1f5f9">',
        '<table width="100%" cellpadding="0" cellspacing="0"><tr>',
        f'<td style="font-size:13px;color:#0f172a;font-weight:600">{reviewer}</td>',
        f'<td style="text-align:right;font-size:12px;color:#64748b">{date_s}</td>',
        '</tr></table>',
        f'<div style="margin-top:6px">{_stars_bar(stars)}',
        f'<span style="font-size:12px;color:#64748b;font-weight:600;vertical-align:middle;margin-left:8px">{stars} / 5</span></div>',
        '</td></tr>',

        '<tr><td style="padding:16px 22px;border-bottom:1px solid #f1f5f9">',
        '<p style="margin:0 0 8px;font-size:10px;font-weight:700;color:#64748b;'
        'text-transform:uppercase;letter-spacing:.08em">Full Review</p>',
        f'<div style="background:#f8fafc;border-left:3px solid {accent};'
        'border-radius:0 8px 8px 0;padding:14px 16px;font-size:14px;'
        'color:#1e293b;line-height:1.8;font-style:italic">',
        review_body,
        '</div></td></tr>',

        '<tr><td style="padding:14px 22px;border-bottom:1px solid #f1f5f9">',
        '<p style="margin:0 0 8px;font-size:10px;font-weight:700;color:#64748b;'
        'text-transform:uppercase;letter-spacing:.08em">Detected Topics</p>',
        f'<div>{chips}</div></td></tr>',

        actions_section,

        f'<tr><td style="padding:14px 22px">{links}</td></tr>',

        '</table>',
    ])


def find_new_meaningful_low_star(conn) -> list:
    """New (never-digested) 1-2 star reviews with real, specific content --
    Google's own review identity (gbp_review_name) or the legacy dedup_key
    already guarantee no double-counting at the DB layer; this only adds the
    per-digest "already sent" check via notifications_log.

    Excludes reviews that already have an owner reply on Google -- a real,
    server-visible "already handled" signal (unlike the dashboard's own
    handled/dismissed status, which lives in browser localStorage and isn't
    visible here -- see nightly-digest section of the README)."""
    rows = conn.execute(
        """SELECT r.*, l.name AS location_name, l.city AS city, l.maps_url
           FROM reviews r JOIN locations l ON l.id = r.location_id
           WHERE r.is_deleted = 0 AND r.star_rating IS NOT NULL AND r.star_rating <= 2
             AND (r.owner_response IS NULL OR TRIM(r.owner_response) = '')
           ORDER BY r.review_date DESC"""
    ).fetchall()
    out = []
    for r in rows:
        if not is_meaningful_review(r["review_text"] or ""):
            continue
        if already_notified(conn, NOTIFICATION_TYPE, related_review_id=r["id"]):
            continue
        out.append(dict(r))
    return out


def build_email(reviews: list, date_label: str) -> str:
    by_location = {}
    for r in reviews:
        by_location.setdefault(r["location_name"], []).append(r)

    critical_n = sum(1 for r in reviews if (r.get("ai_priority") or "").lower() == "critical")
    escalated_n = sum(1 for r in reviews if r.get("_escalated"))

    summary = (
        f'<h2 style="margin:0 0 4px;font-size:17px;font-weight:700;color:#0f172a">'
        f'&#127769;&nbsp;Nightly Review Digest ({len(reviews)})</h2>'
        f'<p style="margin:0 0 20px;font-size:13px;color:#64748b;line-height:1.6">'
        f'{len(reviews)} new meaningful low-star review{"s" if len(reviews) != 1 else ""} '
        f'across {len(by_location)} location{"s" if len(by_location) != 1 else ""}'
        + (f', {critical_n} critical' if critical_n else '')
        + (f' ({escalated_n} previously escalated)' if escalated_n else '')
        + '. Respond within 24 hours to protect your reputation.</p>'
    )

    sections = [summary]
    for loc_name in sorted(by_location.keys()):
        loc_reviews = by_location[loc_name]
        sections.append(
            f'<h3 style="margin:24px 0 12px;font-size:14px;font-weight:700;color:#0f172a;'
            f'border-bottom:2px solid #e2e8f0;padding-bottom:6px">{_safe(loc_name)} '
            f'<span style="font-weight:500;color:#64748b;font-size:12px">({len(loc_reviews)})</span></h3>'
        )
        for r in loc_reviews:
            sections.append(_review_card(r, escalated=bool(r.get("_escalated"))))

    date_label_safe = _safe(date_label)
    year_now = datetime.now().year
    return (
        '<!DOCTYPE html><html lang="en"><head>'
        '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">'
        f'<title>Nightly Review Digest — {date_label_safe}</title></head>'
        '<body style="margin:0;padding:0;background:#f1f5f9;'
        'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;'
        '-webkit-text-size-adjust:100%">'
        '<div style="max-width:640px;margin:0 auto;padding:20px 12px">'
        '<div style="background:#0f172a;border-radius:14px 14px 0 0;padding:28px 32px;text-align:center">'
        '<p style="margin:0 0 6px;font-size:10px;font-weight:800;letter-spacing:3px;'
        'color:#f59e0b;text-transform:uppercase">LTA Review Dashboard</p>'
        '<h1 style="margin:0 0 6px;font-size:20px;font-weight:800;color:white">Nightly Digest</h1>'
        f'<p style="margin:0;font-size:12px;color:#64748b">{date_label_safe}</p>'
        '</div>'
        '<div style="background:white;border-radius:0 0 14px 14px;padding:24px 28px 32px">'
        + "".join(sections)
        + '</div>'
        '<div style="text-align:center;padding:16px 0 4px">'
        f'<p style="font-size:11px;color:#94a3b8;margin:0;line-height:1.6">'
        f'LTA Review Dashboard &mdash; Auto-generated nightly digest<br>'
        f'&copy; {year_now} Future Marketing Studio. All rights reserved.</p>'
        '</div></div></body></html>'
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


def run(force: bool = False) -> dict:
    conn = db.get_connection()
    db.init_schema(conn)
    print(f"[nightly_digest] stage=start force={force}")

    now_et = datetime.now(ZoneInfo("America/New_York"))
    if not force and now_et.hour not in VALID_HOURS_ET:
        conn.close()
        print(f"[nightly_digest] stage=hour_gate result=skipped hour_et={now_et.hour}")
        return {"status": "skipped_wrong_hour", "hour_et": now_et.hour}
    print(f"[nightly_digest] stage=hour_gate result=proceed hour_et={now_et.hour}")

    reviews = find_new_meaningful_low_star(conn)
    print(f"[nightly_digest] stage=find_qualifying_reviews count={len(reviews)}")
    if not reviews:
        conn.close()
        return {"status": "no_qualifying_reviews", "count": 0}

    for r in reviews:
        r["_escalated"] = is_already_escalated(conn, r["id"])

    date_label = now_et.strftime("%B %d, %Y")
    html = build_email(reviews, date_label)
    critical_n = sum(1 for r in reviews if (r.get("ai_priority") or "").lower() == "critical")

    # Root-cause fix (production audit): notifications used to be logged
    # (permanently suppressing these exact reviews from ever being
    # re-considered) BEFORE send_email() was even attempted. A genuine
    # delivery failure (send_email() raising -- bad credentials rejected by
    # Gmail, a network error, anything) would still have already committed
    # the "notified" rows, silently losing that night's entire digest
    # forever with no way to retry. Logging now happens strictly AFTER a
    # send either succeeds or is deliberately skipped for a KNOWN,
    # non-retryable reason (credentials simply not configured yet -- see
    # below) -- never before, and never for an exception raised by
    # send_email() itself.
    if not FROM_ADDR or not APP_PASS:
        # Deliberately still logged: missing credentials is a one-time setup
        # gap, not a transient failure -- treating it as "already digested"
        # prevents tonight's entire backlog from flooding the first run
        # after credentials are finally configured. This exact behavior is
        # covered by test_dedup_across_runs.
        for r in reviews:
            log_notification(conn, NOTIFICATION_TYPE, f"{r['star_rating']}★ at {r['location_name']}",
                              related_review_id=r["id"])
        conn.commit()
        conn.close()
        print(f"[nightly_digest] stage=send result=no_credentials count={len(reviews)}")
        return {"status": "ready_no_credentials", "count": len(reviews)}

    subject = (
        f"Nightly Review Digest — {date_label} "
        f"({len(reviews)} review{'s' if len(reviews) != 1 else ''}"
        + (f", {critical_n} critical" if critical_n else "")
        + ")"
    )
    send_email(subject, html)  # raises on a genuine send failure -- nothing below runs, so these reviews remain eligible for the next run's retry
    print(f"[nightly_digest] stage=send result=success count={len(reviews)} critical={critical_n}")

    for r in reviews:
        log_notification(conn, NOTIFICATION_TYPE, f"{r['star_rating']}★ at {r['location_name']}",
                          related_review_id=r["id"])
    conn.commit()
    conn.close()
    return {"status": "sent", "count": len(reviews), "critical": critical_n}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="Bypass the 10pm ET hour gate (manual/test runs).")
    args = parser.parse_args()
    result = run(force=args.force)
    print(f"nightly_digest.py: {result}")


if __name__ == "__main__":
    main()
