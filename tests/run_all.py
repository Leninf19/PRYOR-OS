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
    "test_google_api_endpoints.py",
    "test_gbp_sync.py",
    "test_gbp_import.py",
    "test_critical_alert_check.py",
    "test_nightly_digest.py",
    "test_negative_review_notifications.py",
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
