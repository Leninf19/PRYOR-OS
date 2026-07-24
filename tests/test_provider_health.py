"""
Regression tests for provider_health.py (Phase 3 Milestone 2) -- the
provider-neutral health model (healthy/warning/degraded/failed/offline).

`now` is always injected explicitly so these tests never depend on the real
wall clock. Run directly: py tests/test_provider_health.py
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from provider_health import compute_health, STATE_OFFLINE, STATE_FAILED, STATE_DEGRADED, STATE_WARNING, STATE_HEALTHY

results = []
NOW = datetime(2026, 7, 20, 12, 0, 0, tzinfo=timezone.utc)


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def _run(minutes_ago, status="ok", attempted=10, succeeded=10, failed=0):
    return {
        "status": status,
        "started_at": (NOW - timedelta(minutes=minutes_ago)).isoformat(),
        "locations_attempted": attempted,
        "locations_succeeded": succeeded,
        "locations_failed": failed,
        "error_summary": None,
    }


# --- Offline ----------------------------------------------------------------

def test_offline_when_not_configured():
    result = compute_health("gbp", False, [_run(5)], 15, now=NOW)
    assert result["state"] == STATE_OFFLINE


def test_offline_when_no_runs_ever_recorded():
    result = compute_health("scraper", True, [], 360, now=NOW)
    assert result["state"] == STATE_OFFLINE


def test_offline_when_only_run_ever_is_still_running():
    result = compute_health("scraper", True, [_run(5, status="running")], 360, now=NOW)
    assert result["state"] == STATE_OFFLINE


# --- Failed ------------------------------------------------------------------

def test_failed_when_latest_completed_run_failed():
    runs = [_run(5, status="failed", succeeded=0, failed=10), _run(370, status="ok")]
    result = compute_health("scraper", True, runs, 360, now=NOW)
    assert result["state"] == STATE_FAILED


def test_failed_ignores_a_currently_running_row_and_looks_at_last_completed():
    runs = [_run(1, status="running"), _run(5, status="failed", succeeded=0, failed=10)]
    result = compute_health("scraper", True, runs, 360, now=NOW)
    assert result["state"] == STATE_FAILED


def test_failed_when_latest_completed_run_timed_out():
    """A 'timed_out' row (health_check.py's watchdog reconciliation --
    provider_sync.reconcile_stuck_runs()) is exactly as much current evidence
    of trouble as an explicit 'failed' row when it's genuinely the most
    recent run: nothing has succeeded since, so the scraper really is in a
    bad state right now."""
    runs = [_run(5, status="timed_out", succeeded=0, failed=0)]
    result = compute_health("scraper", True, runs, 360, now=NOW)
    assert result["state"] == STATE_FAILED
    assert "timed out" in result["reason"]


def test_failed_when_latest_completed_run_was_cancelled():
    runs = [_run(5, status="cancelled", succeeded=0, failed=0)]
    result = compute_health("scraper", True, runs, 360, now=NOW)
    assert result["state"] == STATE_FAILED
    assert "cancelled" in result["reason"]


def test_old_reconciled_run_does_not_count_as_current_failure_once_superseded():
    """The core guarantee behind 'do not classify an old abandoned run as
    evidence the current scraper is failing': a 'timed_out' row that has
    since been superseded by real completed runs must not affect the
    verdict -- health is judged from the *latest* run (by position in the
    list, i.e. by when it started), not from the fact that some older row
    happens to have been reconciled recently. Reconciling run #159 today
    does not make it "the latest run" -- it stays in its original
    chronological slot, several runs back."""
    runs = [
        _run(5, status="ok"),
        _run(365, status="ok"),
        _run(725, status="ok"),
        _run(1085, status="timed_out", succeeded=0, failed=0),  # the old, since-superseded abandoned run
        _run(1445, status="ok"),
    ]
    result = compute_health("scraper", True, runs, 360, now=NOW)
    assert result["state"] == STATE_HEALTHY, result


def test_degraded_counts_a_recent_timed_out_run_in_the_trailing_window():
    """The flip side: if a 'timed_out' row genuinely falls within the recent
    trailing window (not yet superseded by enough later runs), it must still
    count toward "degraded" -- otherwise a scraper stuck in a crash loop
    would misreport as healthy just because each crash eventually got
    reconciled."""
    runs = [
        _run(5, status="ok"),
        _run(365, status="timed_out", succeeded=0, failed=0),
        _run(725, status="ok"),
        _run(1085, status="cancelled", succeeded=0, failed=0),
        _run(1445, status="ok"),
    ]
    result = compute_health("scraper", True, runs, 360, now=NOW)
    assert result["state"] == STATE_DEGRADED, result


# --- Degraded ----------------------------------------------------------------

def test_degraded_when_two_of_last_five_runs_were_failed_or_partial():
    runs = [
        _run(5, status="ok"),
        _run(365, status="partial", succeeded=8, failed=2),
        _run(725, status="ok"),
        _run(1085, status="failed", succeeded=0, failed=10),
        _run(1445, status="ok"),
    ]
    result = compute_health("scraper", True, runs, 360, now=NOW)
    assert result["state"] == STATE_DEGRADED


def test_degraded_when_latest_partial_with_high_location_failure_ratio():
    runs = [_run(5, status="partial", attempted=10, succeeded=6, failed=4)]  # 40% failed > 25%
    result = compute_health("scraper", True, runs, 360, now=NOW)
    assert result["state"] == STATE_DEGRADED


# --- Warning -------------------------------------------------------------------

def test_warning_when_latest_partial_but_isolated_low_failure_ratio():
    runs = [_run(5, status="partial", attempted=20, succeeded=19, failed=1)]  # 5% failed, isolated
    result = compute_health("scraper", True, runs, 360, now=NOW)
    assert result["state"] == STATE_WARNING


def test_warning_when_latest_succeeded_but_stale():
    # 600 minutes ago, cadence 360 -> 1.67x cadence, > 1.5x threshold
    runs = [_run(600, status="ok")]
    result = compute_health("scraper", True, runs, 360, now=NOW)
    assert result["state"] == STATE_WARNING


def test_not_stale_just_under_the_1_5x_threshold():
    runs = [_run(500, status="ok")]  # 500 < 360*1.5=540
    result = compute_health("scraper", True, runs, 360, now=NOW)
    assert result["state"] == STATE_HEALTHY


# --- Healthy -------------------------------------------------------------------

def test_healthy_when_latest_run_succeeded_and_fresh():
    runs = [_run(5, status="ok")]
    result = compute_health("gbp", True, runs, 15, now=NOW)
    assert result["state"] == STATE_HEALTHY


def test_never_stale_when_no_expected_cadence_declared():
    """expected_cadence_minutes=None means "no fixed expectation" -- a very
    old successful run must never be judged stale in that case (e.g. a
    future on-demand Mock Provider)."""
    runs = [_run(100_000, status="ok")]
    result = compute_health("mock", True, runs, None, now=NOW)
    assert result["state"] == STATE_HEALTHY


# --- Export/serialization shape ------------------------------------------------

def test_result_is_a_plain_json_serializable_dict_with_state_and_reason():
    import json
    result = compute_health("scraper", True, [_run(5)], 360, now=NOW)
    assert set(result.keys()) == {"state", "reason"}
    json.dumps(result)  # must not raise


def main():
    tests = [
        ("offline when not configured", test_offline_when_not_configured),
        ("offline when no runs ever recorded", test_offline_when_no_runs_ever_recorded),
        ("offline when the only run ever is still running", test_offline_when_only_run_ever_is_still_running),
        ("failed when the latest completed run failed", test_failed_when_latest_completed_run_failed),
        ("failed correctly skips a currently-running row to find the last completed one", test_failed_ignores_a_currently_running_row_and_looks_at_last_completed),
        ("failed when the latest completed run timed out (watchdog-reconciled)", test_failed_when_latest_completed_run_timed_out),
        ("failed when the latest completed run was cancelled", test_failed_when_latest_completed_run_was_cancelled),
        ("an old reconciled/timed-out run does not count as current failure once superseded", test_old_reconciled_run_does_not_count_as_current_failure_once_superseded),
        ("a recent timed-out run still counts toward degraded", test_degraded_counts_a_recent_timed_out_run_in_the_trailing_window),
        ("degraded when 2 of the last 5 runs were failed/partial", test_degraded_when_two_of_last_five_runs_were_failed_or_partial),
        ("degraded when latest partial run has >25% location failure ratio", test_degraded_when_latest_partial_with_high_location_failure_ratio),
        ("warning when latest partial run is an isolated, low-ratio blip", test_warning_when_latest_partial_but_isolated_low_failure_ratio),
        ("warning when latest run succeeded but is stale (>1.5x cadence)", test_warning_when_latest_succeeded_but_stale),
        ("healthy (not warning) just under the 1.5x staleness threshold", test_not_stale_just_under_the_1_5x_threshold),
        ("healthy when latest run succeeded and is fresh", test_healthy_when_latest_run_succeeded_and_fresh),
        ("never stale when no expected cadence is declared (None)", test_never_stale_when_no_expected_cadence_declared),
        ("result is a plain, JSON-serializable {state, reason} dict", test_result_is_a_plain_json_serializable_dict_with_state_and_reason),
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
