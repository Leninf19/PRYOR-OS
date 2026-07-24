"""
Regression tests for the scraper-run-lifecycle/stuck-run-watchdog audit
(the "run #159 appears stuck" incident):

Root causes fixed:
1. auto_update.py::_scrape_and_write() and provider_sync.py::sync_all() could
   both leave a scraper_runs row at status='running' forever if an exception
   escaped mid-run -- neither had a try/except/finally guaranteeing a
   terminal status. Fixed in both (see test_provider_sync.py for the
   sync_all() coverage; auto_update.py's analogous fix has no dedicated
   Playwright-level test since _scrape_and_write() isn't unit-testable
   without a real browser -- the shared logic it now mirrors is proven here
   and in test_provider_sync.py).
2. health_check.py::check_stuck_run() had no watchdog to ever move a row out
   of 'running', and deduped alerts on a blanket 20h time window rather than
   per-run identity -- so the *same* permanently-open row either kept
   re-alerting forever (once the window elapsed) or silently suppressed a
   genuinely *different* newly-stuck run (while the window was still open).
   Fixed by: provider_sync.reconcile_stuck_runs() (called from
   health_check.py's main(), before any alerting) converting old 'running'
   rows to a terminal 'timed_out', and check_stuck_run() deduping via a new
   notifications_log.related_run_id column -- alerted once per run id, ever.

Run directly: py tests/test_health_check.py
"""
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import health_check

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def _fresh_db():
    tmpdir = tempfile.mkdtemp(prefix="health_check_test_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    conn = db.get_connection()
    db.init_schema(conn)
    conn.close()


def _insert_running_run(conn, started_hours_ago: float) -> int:
    now = datetime.now(timezone.utc)
    started = (now - timedelta(hours=started_hours_ago)).isoformat()
    return conn.execute(
        "INSERT INTO scraper_runs (started_at, mode, status) VALUES (?, 'cloud', 'running')",
        (started,),
    ).lastrowid


# --- check_stuck_run: detection + per-run dedup -------------------------------

def test_check_stuck_run_alerts_on_a_row_past_the_threshold():
    _fresh_db()
    conn = db.get_connection()
    run_id = _insert_running_run(conn, 3)  # past the 2h STUCK_RUN_THRESHOLD
    conn.commit()

    now = datetime.now(timezone.utc)
    html = health_check.check_stuck_run(conn, now)
    conn.commit()
    conn.close()
    assert f"run #{run_id}" in html
    assert "appears stuck" in html


def test_check_stuck_run_ignores_a_row_not_yet_past_the_threshold():
    _fresh_db()
    conn = db.get_connection()
    _insert_running_run(conn, 0.5)  # 30 minutes -- well under the 2h threshold
    conn.commit()

    html = health_check.check_stuck_run(conn, datetime.now(timezone.utc))
    conn.close()
    assert html == ""


def test_check_stuck_run_alerts_only_once_per_run_id():
    """The core fix for 'the same run generates recurring alerts': calling
    check_stuck_run() repeatedly for the same still-'running' row must only
    ever alert the first time -- no time-window re-alerting."""
    _fresh_db()
    conn = db.get_connection()
    run_id = _insert_running_run(conn, 3)
    conn.commit()

    now = datetime.now(timezone.utc)
    first = health_check.check_stuck_run(conn, now)
    conn.commit()
    second = health_check.check_stuck_run(conn, now + timedelta(hours=1))
    conn.commit()
    third = health_check.check_stuck_run(conn, now + timedelta(days=5))
    conn.close()

    assert f"run #{run_id}" in first
    assert second == "", "the same still-running run must not alert a second time"
    assert third == "", "must not alert again even many days later while nothing has changed"


def test_check_stuck_run_alerts_independently_on_a_second_distinct_run():
    """The other half of the old bug: a blanket time-window dedup could
    silence a genuinely *new* stuck run just because an unrelated one had
    already alerted recently. Each run id must be judged on its own."""
    _fresh_db()
    conn = db.get_connection()
    run_a = _insert_running_run(conn, 3)
    conn.commit()

    now = datetime.now(timezone.utc)
    first = health_check.check_stuck_run(conn, now)
    conn.commit()
    assert f"run #{run_a}" in first

    run_b = _insert_running_run(conn, 3)
    conn.commit()
    second = health_check.check_stuck_run(conn, now + timedelta(minutes=10))
    conn.close()

    assert f"run #{run_a}" not in second, "must not re-alert the already-notified run"
    assert f"run #{run_b}" in second, "a distinct newly-stuck run must still alert"


def test_check_stuck_run_reports_every_simultaneously_stuck_run_not_just_the_latest():
    _fresh_db()
    conn = db.get_connection()
    run_a = _insert_running_run(conn, 4)
    run_b = _insert_running_run(conn, 3)
    conn.commit()

    html = health_check.check_stuck_run(conn, datetime.now(timezone.utc))
    conn.close()
    assert f"run #{run_a}" in html
    assert f"run #{run_b}" in html


# --- Watchdog reconciliation wired into main()'s flow -------------------------

def test_reconciled_run_stops_matching_check_stuck_run_entirely():
    """Once provider_sync.reconcile_stuck_runs() (wired into health_check.py's
    main(), ahead of any alerting) marks a row 'timed_out', it must never be
    surfaced by check_stuck_run() again -- it no longer matches
    `status = 'running'` at all. This is *why* reconciliation permanently
    ends the recurring-alert problem, on top of check_stuck_run's own
    per-run dedup."""
    import provider_sync
    _fresh_db()
    conn = db.get_connection()
    _insert_running_run(conn, 8)  # past both the 2h alert and 6h reconcile thresholds
    conn.commit()

    now = datetime.now(timezone.utc)
    reconciled = provider_sync.reconcile_stuck_runs(conn, now=now)
    conn.commit()
    assert len(reconciled) == 1

    html = health_check.check_stuck_run(conn, now)
    conn.close()
    assert html == "", "a reconciled (now 'timed_out') run must not also be alerted as still-stuck"


def main():
    tests = [
        ("check_stuck_run alerts on a row past the stuck threshold", test_check_stuck_run_alerts_on_a_row_past_the_threshold),
        ("check_stuck_run ignores a row not yet past the threshold", test_check_stuck_run_ignores_a_row_not_yet_past_the_threshold),
        ("check_stuck_run alerts only once per run id, never again while unchanged", test_check_stuck_run_alerts_only_once_per_run_id),
        ("check_stuck_run alerts independently on a second, distinct stuck run", test_check_stuck_run_alerts_independently_on_a_second_distinct_run),
        ("check_stuck_run reports every simultaneously-stuck run, not just the latest", test_check_stuck_run_reports_every_simultaneously_stuck_run_not_just_the_latest),
        ("a reconciled ('timed_out') run stops matching check_stuck_run entirely", test_reconciled_run_stops_matching_check_stuck_run_entirely),
    ]
    for name, fn in tests:
        run(name, fn)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
