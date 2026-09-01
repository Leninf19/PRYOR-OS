"""
Weekly review summary email. Runs every Monday via GitHub Actions.
Reads a tenant's reviews.csv (no scraping needed).

Multi-Tenant Phase 4D revision: --tenant-id is REQUIRED. REVIEWS_CSV is no
longer a hardcoded module constant -- it is resolved per-tenant via
tenant_paths.resolve_review_csv_path(), the exact same derivation
export_chunks.py's export_reviews_csv() writes through, so the two can
never disagree about where this file lives. For Los Tres Amigos this
remains byte-identical to the pre-Phase-4D dashboard/reviews.csv path.
"""
import argparse
import csv
import os
import re
import smtplib
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

import tenant_keys
import tenant_paths

BASE_DIR   = Path(__file__).parent
TO_ADDR    = "advertising@l3amigos.com"
FROM_ADDR  = os.environ.get("GMAIL_USER", "")
APP_PASS   = os.environ.get("GMAIL_APP_PASSWORD", "")

STOP_WORDS = {
    'a','an','the','is','are','was','were','be','been','have','has','had',
    'do','does','did','will','would','could','should','to','of','in','for',
    'on','with','at','by','from','and','or','but','not','this','that','it',
    'its','we','you','he','she','they','i','me','us','him','her','our',
    'just','got','go','get','came','come','also','very','really','good',
    'great','nice','bad','ok','okay','food','place','restaurant','time',
    'service','staff','always','never','still','now','even','back','out',
}


def load_reviews(csv_path: Path):
    with csv_path.open(encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        try:
            r["star_rating"] = int(r["star_rating"])
        except (ValueError, KeyError):
            r["star_rating"] = 0
    return rows


def top_complaint_words(reviews, n=8):
    words = Counter()
    for r in reviews:
        text = (r.get("review_text") or "").lower()
        text = re.sub(r"[^a-z\s]", " ", text)
        for w in text.split():
            if len(w) > 3 and w not in STOP_WORDS:
                words[w] += 1
    return words.most_common(n)


def stars_html(n):
    return "&#9733;" * n + "&#9734;" * (5 - n)


def build_html(data):  # noqa: C901
    week_str   = data["week_str"]
    total      = data["total_new"]
    by_loc     = data["by_location"]
    avg_now    = data["avg_now"]
    avg_prev   = data["avg_prev"]
    unanswered = data["unanswered"]
    complaints = data["complaints"]

    generated_at = datetime.now().strftime("%B %d, %Y at %I:%M %p EST")
    year_now     = datetime.now().year
    active_locs  = len(by_loc)

    # Trend counts across all locations that have data for both windows
    improving = sum(1 for loc in avg_now if avg_prev.get(loc) and avg_now[loc] - avg_prev[loc] >= 0.1)
    declining = sum(1 for loc in avg_now if avg_prev.get(loc) and avg_now[loc] - avg_prev[loc] <= -0.1)

    # ── Executive summary sentence ────────────────────────────────────────────
    if total == 0:
        exec_summary = (
            "No new Google reviews were detected in your data this week. "
            "This could mean no customers left reviews, or the dashboard needs to be refreshed."
        )
    else:
        parts = [
            f"Your restaurants received <strong>{total} new Google review{'s' if total != 1 else ''}</strong> "
            f"across <strong>{active_locs} location{'s' if active_locs != 1 else ''}</strong> this week."
        ]
        if unanswered == 0:
            parts.append("All negative reviews have been responded to &#8212; great job!")
        else:
            parts.append(
                f"<strong style='color:#dc2626'>"
                f"{unanswered} low-star review{'s' if unanswered != 1 else ''} "
                f"still need{'s' if unanswered == 1 else ''} a reply.</strong>"
            )
        if declining > 0:
            parts.append(
                f"{declining} location{'s are' if declining != 1 else ' is'} showing a "
                "declining rating trend compared to last month."
            )
        exec_summary = " ".join(parts)

    # ── KPI card styles ───────────────────────────────────────────────────────
    if unanswered > 0:
        kpi2_bg, kpi2_border, kpi2_color = "#fff1f2", "#fecaca", "#991b1b"
        kpi2_icon, kpi2_val, kpi2_sub = "&#9888;&#65039;", str(unanswered), "Need a reply"
    else:
        kpi2_bg, kpi2_border, kpi2_color = "#f0fdf4", "#bbf7d0", "#166534"
        kpi2_icon, kpi2_val, kpi2_sub = "&#9989;", "None", "All clear"

    if declining > 0:
        kpi3_bg, kpi3_border, kpi3_color = "#fff1f2", "#fecaca", "#991b1b"
        kpi3_icon, kpi3_val, kpi3_label = "&#128201;", str(declining), "Declining"
    elif improving > 0:
        kpi3_bg, kpi3_border, kpi3_color = "#f0fdf4", "#bbf7d0", "#166534"
        kpi3_icon, kpi3_val, kpi3_label = "&#128200;", str(improving), "Improving"
    else:
        kpi3_bg, kpi3_border, kpi3_color = "#f8fafc", "#e2e8f0", "#475569"
        kpi3_icon, kpi3_val, kpi3_label = "&#128205;", str(active_locs), "Active"

    # ── Location table rows ───────────────────────────────────────────────────
    loc_rows_html = ""
    for idx, (loc, cnt) in enumerate(sorted(by_loc.items(), key=lambda x: -x[1])):
        row_bg = "#ffffff" if idx % 2 == 0 else "#fafafa"
        short  = (loc.replace("Los Tres Amigos ", "LTA ")
                     .replace("Los Tres Mex Grill ", "LT Mex ")
                     .replace("Mi Lindo San Blas ", "Mi Lindo "))
        cur    = avg_now.get(loc)
        prev   = avg_prev.get(loc)

        if cur:
            filled     = int(round(cur))
            star_icons = "&#9733;" * filled + "&#9734;" * (5 - filled)
            rating_td  = (
                f'<span style="color:#f59e0b;font-size:16px;letter-spacing:1px">{star_icons}</span>'
                f'<br><span style="font-size:11px;font-weight:700;color:#0f172a">{cur:.2f} / 5.00</span>'
            )
        else:
            rating_td = '<span style="color:#94a3b8;font-size:12px">No data</span>'

        if cur and prev:
            delta = cur - prev
            if delta >= 0.1:
                trend_td = (
                    f'<span style="background:#dcfce7;color:#166534;padding:4px 10px;'
                    f'border-radius:20px;font-size:12px;font-weight:700;white-space:nowrap">'
                    f'&#9650; +{delta:.2f}</span>'
                )
            elif delta <= -0.1:
                trend_td = (
                    f'<span style="background:#fee2e2;color:#991b1b;padding:4px 10px;'
                    f'border-radius:20px;font-size:12px;font-weight:700;white-space:nowrap">'
                    f'&#9660; {delta:.2f}</span>'
                )
            else:
                trend_td = (
                    '<span style="background:#f1f5f9;color:#64748b;padding:4px 10px;'
                    'border-radius:20px;font-size:12px;white-space:nowrap">&#8212; Stable</span>'
                )
        elif cur:
            trend_td = '<span style="color:#94a3b8;font-size:12px">First month</span>'
        else:
            trend_td = '<span style="color:#94a3b8;font-size:12px">&#8212;</span>'

        badge_bg  = "#d97706" if cnt >= 5 else "#94a3b8"
        loc_rows_html += (
            f'<tr style="background:{row_bg}">'
            f'<td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;color:#0f172a">{short}</td>'
            f'<td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;text-align:center">'
            f'<span style="background:{badge_bg};color:white;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:700">{cnt}</span></td>'
            f'<td style="padding:14px 16px;border-bottom:1px solid #f1f5f9">{rating_td}</td>'
            f'<td style="padding:14px 16px;border-bottom:1px solid #f1f5f9">{trend_td}</td>'
            f'</tr>'
        )

    # ── Complaint keyword chips ───────────────────────────────────────────────
    chips_html = ""
    for word, cnt in complaints:
        chips_html += (
            f'<span style="display:inline-block;background:#fff1f2;color:#be123c;'
            f'border:1.5px solid #fecdd3;border-radius:8px;padding:7px 14px;margin:4px;'
            f'font-size:13px;font-weight:600">{word}'
            f'<span style="opacity:0.5;font-weight:400"> &times;{cnt}</span></span>'
        )

    # ── Alert block ───────────────────────────────────────────────────────────
    alert_block = ""
    if unanswered > 0:
        rev_word = "review" if unanswered == 1 else "reviews"
        alert_block = (
            '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">'
            '<tr><td style="background:#fff1f2;border:1.5px solid #fecaca;border-radius:12px;padding:20px 24px">'
            '<table width="100%" cellpadding="0" cellspacing="0"><tr>'
            '<td style="width:40px;vertical-align:top;padding-top:3px;font-size:24px">&#9888;&#65039;</td>'
            '<td style="padding-left:12px;vertical-align:middle">'
            f'<p style="margin:0 0 5px;font-size:16px;font-weight:700;color:#991b1b">Action Required</p>'
            f'<p style="margin:0;font-size:13px;line-height:1.6;color:#7f1d1d">'
            f'You have <strong>{unanswered} unanswered 1&#8211;2 star {rev_word}</strong>. '
            f'Responding to unhappy customers protects your reputation and improves your Google ranking. '
            f'<strong>Aim to reply within 24 hours.</strong></p>'
            '</td></tr></table>'
            '</td></tr></table>'
        )

    # ── No-new-reviews block ──────────────────────────────────────────────────
    no_new_block = ""
    if total == 0:
        no_new_block = (
            '<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">'
            '<tr><td style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;'
            'padding:32px;text-align:center">'
            '<p style="margin:0 0 8px;font-size:36px">&#128564;</p>'
            '<p style="margin:0 0 4px;font-size:16px;font-weight:700;color:#0f172a">No new reviews this week</p>'
            '<p style="margin:0;font-size:13px;color:#64748b;line-height:1.6">'
            'No new Google reviews were detected. Consider running an update, or encourage '
            'satisfied customers to leave a review after their visit.</p>'
            '</td></tr></table>'
        )

    # ── Location table section ────────────────────────────────────────────────
    loc_section = ""
    if by_loc:
        loc_section = (
            '<h2 style="margin:0 0 4px;font-size:17px;font-weight:700;color:#0f172a">'
            '&#128205; New Reviews by Location</h2>'
            '<p style="margin:0 0 16px;font-size:13px;color:#64748b;line-height:1.6">'
            "Each location's new review count this week, their current Google rating "
            "(30-day average), and whether they're trending up or down vs. the prior 30 days.</p>"
            '<table width="100%" cellpadding="0" cellspacing="0" '
            'style="border-collapse:collapse;border:1.5px solid #e2e8f0;border-radius:12px;'
            'overflow:hidden;margin-bottom:8px">'
            '<thead><tr style="background:#f8fafc">'
            '<th style="padding:12px 16px;text-align:left;font-size:11px;font-weight:700;'
            'color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1.5px solid #e2e8f0">Location</th>'
            '<th style="padding:12px 16px;text-align:center;font-size:11px;font-weight:700;'
            'color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1.5px solid #e2e8f0">New Reviews</th>'
            '<th style="padding:12px 16px;text-align:left;font-size:11px;font-weight:700;'
            'color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1.5px solid #e2e8f0">30-Day Rating</th>'
            '<th style="padding:12px 16px;text-align:left;font-size:11px;font-weight:700;'
            'color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1.5px solid #e2e8f0">Trend</th>'
            f'</tr></thead><tbody>{loc_rows_html}</tbody></table>'
            '<p style="margin:6px 0 32px;font-size:11px;color:#94a3b8;line-height:1.5">'
            '&#9650; Improving / &#9660; Declining = current 30-day avg vs. prior 30 days. '
            'Requires review data in both windows to calculate.</p>'
        )

    # ── Complaints section ────────────────────────────────────────────────────
    complaints_section = ""
    if complaints:
        complaints_section = (
            '<h2 style="margin:0 0 4px;font-size:17px;font-weight:700;color:#0f172a">'
            '&#128269; Complaint Keywords This Week</h2>'
            '<p style="margin:0 0 16px;font-size:13px;color:#64748b;line-height:1.6">'
            'These words appeared most often in 1&#8211;2 star reviews this week. '
            "They point to recurring issues customers are frustrated about &#8212; "
            'worth discussing with your location managers.</p>'
            '<div style="background:#fff8f8;border:1.5px solid #fecaca;border-radius:12px;'
            f'padding:18px 14px;margin-bottom:32px">{chips_html}</div>'
        )

    # ── Next steps section ────────────────────────────────────────────────────
    steps = []
    if unanswered > 0:
        steps.append(("Open the dashboard", f"Go to <strong>Action Items</strong> to see all {unanswered} unanswered low-star reviews."))
        steps.append(("Reply professionally", "Respond to each negative review calmly and quickly. Aim to reply within 24 hours to show customers &#8212; and Google &#8212; that you care."))
    if complaints:
        steps.append(("Share with managers", "Forward the complaint keywords above to your location managers so recurring problems can be addressed in-store."))
    if not steps:
        steps.append(("Keep the momentum going!", "No urgent action needed this week. Consider asking satisfied customers to leave a Google review after their visit."))

    steps_rows = ""
    for num, (title, desc) in enumerate(steps, 1):
        steps_rows += (
            '<tr>'
            '<td style="width:36px;vertical-align:top;padding:10px 12px 10px 0">'
            f'<span style="display:inline-block;width:28px;height:28px;border-radius:50%;background:#f59e0b;'
            f'color:white;font-size:13px;font-weight:800;text-align:center;line-height:28px">{num}</span></td>'
            '<td style="vertical-align:top;padding:10px 0;border-bottom:1px solid #fef3c7">'
            f'<p style="margin:0 0 3px;font-size:14px;font-weight:700;color:#92400e">{title}</p>'
            f'<p style="margin:0;font-size:13px;color:#1e293b;line-height:1.6">{desc}</p>'
            '</td></tr>'
        )

    next_steps_section = (
        '<div style="background:#fffbeb;border:1.5px solid #fde68a;border-radius:12px;padding:24px">'
        '<h2 style="margin:0 0 16px;font-size:17px;font-weight:700;color:#92400e">&#9989; Suggested Next Steps</h2>'
        f'<table width="100%" cellpadding="0" cellspacing="0">{steps_rows}</table>'
        '</div>'
    )

    # ── Assemble final HTML ───────────────────────────────────────────────────
    return (
        '<!DOCTYPE html>'
        '<html lang="en">'
        '<head>'
        '<meta charset="UTF-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1.0">'
        '<title>Weekly Review Summary</title>'
        '</head>'
        '<body style="margin:0;padding:0;background:#f1f5f9;'
        'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'Helvetica Neue\',Arial,sans-serif;'
        '-webkit-text-size-adjust:100%">'

        '<div style="max-width:640px;margin:0 auto;padding:24px 12px">'

        # ── Header ──────────────────────────────────────────────────────────
        '<div style="background:#0f172a;border-radius:16px 16px 0 0;padding:32px 36px;text-align:center">'
        '<p style="margin:0 0 8px;font-size:10px;font-weight:800;letter-spacing:3px;color:#f59e0b;text-transform:uppercase">Future Marketing Studio</p>'
        '<h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:white;letter-spacing:-0.3px">Weekly Review Summary</h1>'
        f'<p style="margin:0 0 8px;font-size:15px;color:#94a3b8;font-weight:500">{week_str}</p>'
        f'<p style="margin:0;font-size:11px;color:#334155">Generated on {generated_at}</p>'
        '</div>'

        # ── Executive summary ─────────────────────────────────────────────
        '<div style="background:white;padding:20px 36px;border-left:4px solid #f59e0b">'
        f'<p style="margin:0;font-size:14px;line-height:1.75;color:#334155">{exec_summary}</p>'
        '</div>'

        # ── KPI cards ─────────────────────────────────────────────────────
        '<div style="background:white;padding:20px 36px 28px">'
        '<table width="100%" cellpadding="0" cellspacing="0">'
        '<tr>'

        '<td width="33%" style="padding-right:6px;vertical-align:top">'
        '<div style="background:#fffbeb;border:1.5px solid #fde68a;border-radius:12px;padding:18px 12px;text-align:center">'
        '<p style="margin:0 0 6px;font-size:22px;line-height:1">&#128202;</p>'
        f'<p style="margin:0;font-size:30px;font-weight:800;color:#d97706;line-height:1.1">{total}</p>'
        '<p style="margin:6px 0 2px;font-size:10px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.08em">New Reviews</p>'
        '<p style="margin:0;font-size:11px;color:#a16207">This week</p>'
        '</div></td>'

        f'<td width="33%" style="padding-left:3px;padding-right:3px;vertical-align:top">'
        f'<div style="background:{kpi2_bg};border:1.5px solid {kpi2_border};border-radius:12px;padding:18px 12px;text-align:center">'
        f'<p style="margin:0 0 6px;font-size:22px;line-height:1">{kpi2_icon}</p>'
        f'<p style="margin:0;font-size:30px;font-weight:800;color:{kpi2_color};line-height:1.1">{kpi2_val}</p>'
        f'<p style="margin:6px 0 2px;font-size:10px;font-weight:700;color:{kpi2_color};text-transform:uppercase;letter-spacing:0.08em">Need Reply</p>'
        f'<p style="margin:0;font-size:11px;color:#64748b">{kpi2_sub}</p>'
        '</div></td>'

        f'<td width="33%" style="padding-left:6px;vertical-align:top">'
        f'<div style="background:{kpi3_bg};border:1.5px solid {kpi3_border};border-radius:12px;padding:18px 12px;text-align:center">'
        f'<p style="margin:0 0 6px;font-size:22px;line-height:1">{kpi3_icon}</p>'
        f'<p style="margin:0;font-size:30px;font-weight:800;color:{kpi3_color};line-height:1.1">{kpi3_val}</p>'
        f'<p style="margin:6px 0 2px;font-size:10px;font-weight:700;color:{kpi3_color};text-transform:uppercase;letter-spacing:0.08em">{kpi3_label}</p>'
        '<p style="margin:0;font-size:11px;color:#64748b">Locations</p>'
        '</div></td>'

        '</tr></table>'
        '</div>'

        # ── Divider ───────────────────────────────────────────────────────
        '<div style="background:white;padding:0 36px"><div style="height:1px;background:#f1f5f9"></div></div>'

        # ── Main content ──────────────────────────────────────────────────
        '<div style="background:white;padding:28px 36px 32px">'
        + alert_block
        + no_new_block
        + loc_section
        + complaints_section
        + next_steps_section
        + '</div>'

        # ── Footer ────────────────────────────────────────────────────────
        '<div style="background:#0f172a;border-radius:0 0 16px 16px;padding:24px 36px;text-align:center">'
        '<p style="margin:0 0 2px;font-size:11px;font-weight:700;color:#f59e0b;letter-spacing:2px;text-transform:uppercase">Future Marketing Studio</p>'
        '<p style="margin:0 0 14px;font-size:11px;color:#475569">LTA Review Intelligence Dashboard</p>'
        f'<p style="margin:0;font-size:10px;color:#334155;line-height:1.8">'
        'This report is automatically sent every Monday at 8&nbsp;AM&nbsp;EST.<br>'
        'Data reflects Google reviews collected via the LTA Review Dashboard.<br>'
        f'&copy; {year_now} Future Marketing Studio. All rights reserved.</p>'
        '</div>'

        '</div>'  # max-width wrapper
        '</body>'
        '</html>'
    )


def send_email(subject, html, to_addr, from_addr, password):
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = f"LTA Review Dashboard <{from_addr}>"
    msg["To"]      = to_addr
    msg.attach(MIMEText(html, "html"))
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(from_addr, password)
        smtp.sendmail(from_addr, to_addr, msg.as_string())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant whose reviews.csv to report on. REQUIRED -- no "
                              "default. This script never infers a tenant on its own.")
    args = parser.parse_args()
    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::weekly_report.py: invalid --tenant-id {args.tenant_id!r}")
        sys.exit(1)
    try:
        csv_path = tenant_paths.resolve_review_csv_path(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::weekly_report.py: {e}")
        sys.exit(1)

    if not FROM_ADDR or not APP_PASS:
        print("Missing GMAIL_USER or GMAIL_APP_PASSWORD env vars")
        return

    reviews = load_reviews(csv_path)
    today   = datetime.now()
    d7      = (today - timedelta(days=7)).strftime("%Y-%m-%d")
    d30     = (today - timedelta(days=30)).strftime("%Y-%m-%d")
    d60     = (today - timedelta(days=60)).strftime("%Y-%m-%d")
    today_s = today.strftime("%Y-%m-%d")

    new_reviews  = [r for r in reviews if r["review_date"] >= d7]
    by_location  = dict(Counter(r["location_name"] for r in new_reviews))

    # 30-day avg per location now vs prior 30 days
    avg_now  = {}
    avg_prev = {}
    for loc in set(r["location_name"] for r in reviews):
        cur  = [r for r in reviews if r["location_name"] == loc and r["review_date"] >= d30]
        prev = [r for r in reviews if r["location_name"] == loc and r["review_date"] >= d60 and r["review_date"] < d30]
        if cur:  avg_now[loc]  = sum(r["star_rating"] for r in cur)  / len(cur)
        if prev: avg_prev[loc] = sum(r["star_rating"] for r in prev) / len(prev)

    unanswered = sum(1 for r in reviews if r["star_rating"] <= 2 and not (r.get("owner_response") or "").strip())

    neg_this_week = [r for r in new_reviews if r["star_rating"] <= 2]
    complaints    = top_complaint_words(neg_this_week) if neg_this_week else []

    week_str = f"Week of {(today - timedelta(days=7)).strftime('%B %d')} – {today.strftime('%B %d, %Y')}"

    html = build_html({
        "week_str":    week_str,
        "total_new":   len(new_reviews),
        "by_location": by_location,
        "avg_now":     avg_now,
        "avg_prev":    avg_prev,
        "unanswered":  unanswered,
        "complaints":  complaints,
    })

    subject = f"Weekly Review Report – {len(new_reviews)} new reviews – {today.strftime('%b %d')}"
    send_email(subject, html, TO_ADDR, FROM_ADDR, APP_PASS)
    print(f"Email sent to {TO_ADDR}: {len(new_reviews)} new reviews, {unanswered} unanswered")


if __name__ == "__main__":
    main()
