"""
notify.py - Notify Agent (Milestone 2).

Runs after validate.py/refresh_analytics.py in the pipeline and sends a
single digest email covering whatever needs a human's attention right now:
scraper failures, new low-star reviews, per-location rating drops, and
structural data bugs (duplicate review URLs). Every alert type is deduped
via notifications_log so the same underlying issue doesn't re-notify every
~6h run -- only genuinely new information re-triggers an email.

Reuses weekly_report.py's exact Gmail SMTP pattern (same env vars, same
"from" display name) rather than inventing a second mailer.
"""
import os
import smtplib
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import db

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


def _notify_safe(s):
    import html as _h
    return _h.escape(str(s or ""), quote=False)


def _notify_stars_bar(n):
    n = max(0, min(5, int(n or 0)))
    return (
        '<span style="color:#f59e0b;font-size:17px;letter-spacing:2px">' + "&#9733;" * n + "</span>"
        + '<span style="color:#d1d5db;font-size:17px;letter-spacing:2px">' + "&#9734;" * (5 - n) + "</span>"
    )


def _notify_fmt_date(s):
    try:
        from datetime import date as _d
        return _d.fromisoformat(str(s or "")[:10]).strftime("%B %d, %Y")
    except Exception:
        return str(s or "Unknown date")


def _notify_nl2p(text):
    """HTML-escape and convert newlines to paragraphs — never truncates."""
    import html as _h
    import re as _re
    escaped = _h.escape(str(text or ""), quote=False)
    normalized = _re.sub(r'\n{2,}', '\n\n', escaped.strip())
    parts = [p.strip() for p in normalized.split('\n\n') if p.strip()]
    if not parts:
        return '<span style="color:#94a3b8;font-style:normal">No written content.</span>'
    if len(parts) == 1:
        return parts[0].replace('\n', '<br>')
    return "".join(
        f'<p style="margin:0 0 12px 0">{p.replace(chr(10), "<br>")}</p>'
        for p in parts
    )


_NOTIFY_TOPIC_MAP = [
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
_NOTIFY_ACTION_MAP = [
    (["server", "staff", "waiter", "waitress", "employee"],    "Identify the staff member involved and follow up with management."),
    (["wrong order", "wrong dish", "incorrect", "messed up"],  "Review order accuracy procedures with the kitchen team."),
    (["refill"],                                                "Reinforce refill and table-check standards with front-of-house staff."),
    (["card machine", "payment", "receipt"],                    "Inspect payment terminals and ensure receipts are available on request."),
    (["dirty", "filthy", "cockroach", "roach", "rat", "pest"], "Schedule an immediate deep-clean and pest inspection."),
    (["sick", "food poison", "vomit", "hospital"],              "Escalate to management — potential food safety issue. Contact advertising@l3amigos.com."),
    (["wait", "slow", "long time", "forever"],                  "Review staffing levels and service pace during peak hours."),
    (["rude", "hostile", "disrespectful"],                      "Address customer service standards with the team."),
]


def _notify_topics(text):
    if not text:
        return []
    lower = text.lower()
    return [t for t, kws in _NOTIFY_TOPIC_MAP if any(kw in lower for kw in kws)][:6]


def _notify_actions(text, stars):
    if not text:
        return []
    lower = text.lower()
    found = [a for kws, a in _NOTIFY_ACTION_MAP if any(kw in lower for kw in kws)]
    if int(stars or 0) == 1:
        found.append("Consider reaching out directly to the customer to offer a resolution.")
    return found[:5] or ["Draft a professional, empathetic reply on Google."]


def _notify_review_card(r):
    """Build a premium HTML card for one low-star review — full text, never truncated."""
    reviewer = _notify_safe(r["reviewer_name"] or "Anonymous")
    stars    = int(r["star_rating"] or 0)
    location = _notify_safe(r["location_name"] or "")
    date_s   = _notify_fmt_date(r["review_date"])
    text     = (r["review_text"] or "").strip()
    url      = r["review_url"] if "review_url" in r.keys() else ""
    maps_url = r["maps_url"] if "maps_url" in r.keys() else ""

    if stars <= 1:
        accent, badge_bg, sentiment = '#dc2626', '#fff1f2', 'Very Negative'
    else:
        accent, badge_bg, sentiment = '#f97316', '#fff7ed', 'Negative'

    topics  = _notify_topics(text)
    actions = _notify_actions(text, stars)

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
            f'<a href="{_notify_safe(url)}" '
            'style="display:inline-block;background:#0f172a;color:white;text-decoration:none;'
            'border-radius:7px;padding:9px 16px;font-size:12px;font-weight:600;'
            'margin-right:8px;margin-bottom:6px">&#128279;&nbsp;View Review</a>'
        )
    if maps_url:
        links += (
            f'<a href="{_notify_safe(maps_url)}" '
            'style="display:inline-block;background:#f59e0b;color:#0f172a;text-decoration:none;'
            'border-radius:7px;padding:9px 16px;font-size:12px;font-weight:600;'
            'margin-bottom:6px">&#128205;&nbsp;View on Google Maps</a>'
        )

    no_text_fallback = '<span style="color:#94a3b8;font-style:normal">Rating only — no written review.</span>'
    review_body = _notify_nl2p(text) if text else no_text_fallback

    return "".join([
        '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;'
        'border:1.5px solid #e2e8f0;border-radius:12px;overflow:hidden;background:white;'
        'border-collapse:separate">',

        # Header: location name + sentiment badge
        '<tr><td style="background:#0f172a;padding:16px 22px;border-radius:12px 12px 0 0">',
        '<table width="100%" cellpadding="0" cellspacing="0"><tr>',
        f'<td><p style="margin:0 0 2px;font-size:12px;font-weight:700;color:#f59e0b;'
        'text-transform:uppercase;letter-spacing:.06em">New Low-Star Review</p>',
        f'<p style="margin:0;font-size:15px;font-weight:700;color:white">{location}</p></td>',
        '<td style="text-align:right;white-space:nowrap">',
        f'<span style="background:{badge_bg};color:{accent};border-radius:6px;'
        f'padding:5px 12px;font-size:12px;font-weight:700">{stars}&#9733;&nbsp;{sentiment}</span>',
        '</td></tr></table></td></tr>',

        # Reviewer + date + stars
        '<tr><td style="padding:10px 22px 12px;background:#f8fafc;border-bottom:1px solid #f1f5f9">',
        '<table width="100%" cellpadding="0" cellspacing="0"><tr>',
        f'<td style="font-size:13px;color:#0f172a;font-weight:600">{reviewer}</td>',
        f'<td style="text-align:right;font-size:12px;color:#64748b">{date_s}</td>',
        '</tr></table>',
        f'<div style="margin-top:6px">{_notify_stars_bar(stars)}',
        f'<span style="font-size:12px;color:#64748b;font-weight:600;vertical-align:middle;margin-left:8px">{stars} / 5</span></div>',
        '</td></tr>',

        # Full review — never truncated
        '<tr><td style="padding:16px 22px;border-bottom:1px solid #f1f5f9">',
        '<p style="margin:0 0 8px;font-size:10px;font-weight:700;color:#64748b;'
        'text-transform:uppercase;letter-spacing:.08em">Full Review</p>',
        f'<div style="background:#f8fafc;border-left:3px solid {accent};'
        'border-radius:0 8px 8px 0;padding:14px 16px;font-size:14px;'
        'color:#1e293b;line-height:1.8;font-style:italic">',
        review_body,
        '</div></td></tr>',

        # Detected topics
        '<tr><td style="padding:14px 22px;border-bottom:1px solid #f1f5f9">',
        '<p style="margin:0 0 8px;font-size:10px;font-weight:700;color:#64748b;'
        'text-transform:uppercase;letter-spacing:.08em">Detected Topics</p>',
        f'<div>{chips}</div></td></tr>',

        # Recommended actions
        actions_section,

        # Quick links
        f'<tr><td style="padding:14px 22px">{links}</td></tr>',

        '</table>',
    ])


def check_low_star_reviews(conn) -> str:
    rows = conn.execute(
        """SELECT r.id, r.reviewer_name, r.review_text, r.star_rating, r.review_date,
                  r.review_url, l.name AS location_name, l.city, l.maps_url
           FROM reviews r JOIN locations l ON l.id = r.location_id
           WHERE r.is_deleted = 0 AND r.star_rating IS NOT NULL AND r.star_rating <= 2
           ORDER BY r.review_date DESC"""
    ).fetchall()

    fresh = []
    for r in rows:
        if already_notified(conn, "low_star_review", related_review_id=r["id"]):
            continue
        fresh.append(r)
        log_notification(conn, "low_star_review", f"{r['star_rating']}★ at {r['location_name']}",
                         related_review_id=r["id"])
    if not fresh:
        return ""

    d1    = (datetime.now(timezone.utc) - timedelta(days=1)).date().isoformat()
    spike = sum(1 for r in fresh if r["review_date"] and r["review_date"] >= d1)
    spike_note = (
        f'<div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:8px;'
        f'padding:12px 16px;margin-bottom:20px;font-size:13px;color:#991b1b;font-weight:600">'
        f'&#9888;&#65039;&nbsp;<strong>{spike} reviews arrived in the last 24 hours</strong> — possible spike. Investigate immediately.'
        f'</div>'
    ) if spike >= 3 else ""

    MAX_CARDS = 10
    shown  = fresh[:MAX_CARDS]
    hidden = len(fresh) - len(shown)

    overflow_note = (
        f'<p style="text-align:center;font-size:13px;color:#64748b;margin:0 0 16px;'
        f'padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">'
        f'&#43; {hidden} more low-star review{"s" if hidden != 1 else ""} — open the dashboard to see all.</p>'
    ) if hidden > 0 else ""

    cards = "".join(_notify_review_card(r) for r in shown)

    count = len(fresh)
    return (
        f'<h2 style="margin:0 0 4px;font-size:17px;font-weight:700;color:#0f172a">'
        f'&#9888;&#65039;&nbsp;New Low-Star Reviews ({count})</h2>'
        f'<p style="margin:0 0 20px;font-size:13px;color:#64748b;line-height:1.6">'
        f'{"These reviews were" if count != 1 else "This review was"} not previously seen — '
        f'respond within 24 hours to protect your reputation.</p>'
        + spike_note
        + cards
        + overflow_note
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
    conn = db.get_connection()
    db.init_schema(conn)

    sections = [
        check_scraper_failure(conn),
        check_low_star_reviews(conn),
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
