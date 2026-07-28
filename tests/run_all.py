"""
Runs every Python regression test in tests/ and reports a pass/fail summary.
The one JS test (test_publish_reply.js) is not included here -- run it
separately with `node tests/test_publish_reply.js`.

Run directly: py tests/run_all.py
"""
import subprocess
import sys
from pathlib import Path

TESTS = [
    "test_retry.py",
    "test_validate.py",
    "test_provider_base.py",
    "test_provider_scraper.py",
    "test_provider_health.py",
    "test_provider_mock.py",
    "test_bootstrap_mock_snapshot.py",
    "test_provider_sync.py",
    "test_sync_reviews.py",
    "test_export_chunks.py",
    "test_location_analytics.py",
    "test_google_api_endpoints.py",
    "test_google_api_redis_token.py",
    "test_db.py",
    "test_gbp_sync.py",
    "test_gbp_import.py",
    "test_critical_alert_check.py",
    "test_nightly_digest.py",
    "test_negative_review_notifications.py",
    "test_notification_pipeline_audit.py",
    "test_local_safety.py",
    "test_check_db_integrity.py",
    "test_auto_update_local_mode.py",
    "test_location_contacts.py",
    "test_health_check.py",
]


def main():
    here = Path(__file__).resolve().parent
    results = {}
    for name in TESTS:
        print(f"=== {name} ===")
        proc = subprocess.run([sys.executable, str(here / name)])
        results[name] = proc.returncode == 0
        print()

    print("=== Summary ===")
    for name, ok in results.items():
        print(f"  {'PASS' if ok else 'FAIL'}: {name}")

    if all(results.values()):
        print(f"\nALL {len(results)} TEST FILES PASSED")
        return 0
    failed = [n for n, ok in results.items() if not ok]
    print(f"\n{len(failed)} of {len(results)} TEST FILES FAILED: {', '.join(failed)}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
