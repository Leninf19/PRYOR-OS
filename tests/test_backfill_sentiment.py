"""
Regression tests for backfill_sentiment.py -- Multi-Tenant Phase 4D closure
finding: this script imports db and calls db.get_connection()/
db.save_ai_classification() (read AND write access to a tenant's real
review database) but was missed by the original Phase 4D audit. Covers
only the tenant-gating behavior added to close that gap; the classification
logic itself is covered by ai_engine.py's/db.py's own tests.

Run directly: py tests/test_backfill_sentiment.py
"""
import subprocess
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import backfill_sentiment
import tenant_keys
import tenant_paths

TEST_TENANT_ID = tenant_keys.DEFAULT_TENANT_ID
REPO_ROOT = Path(__file__).resolve().parent.parent

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def test_cli_requires_tenant_id():
    proc = subprocess.run(
        [sys.executable, str(REPO_ROOT / "backfill_sentiment.py")],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    assert proc.returncode != 0, "the CLI must fail without --tenant-id"
    assert "--tenant-id" in proc.stderr, f"expected argparse to mention --tenant-id, got: {proc.stderr}"


def test_cli_fails_closed_for_an_unknown_tenant_before_any_db_access():
    with mock.patch.object(sys, "argv", ["backfill_sentiment.py", "--tenant-id", "t_never-onboarded"]), \
         mock.patch("db.get_connection") as explosive:
        explosive.side_effect = AssertionError("must never be called for an unknown tenant")
        try:
            backfill_sentiment.main()
        except SystemExit as e:
            assert e.code != 0
        explosive.assert_not_called()


def test_no_implicit_tenant_default_anywhere_in_main():
    text = Path(backfill_sentiment.__file__).read_text(encoding="utf-8")
    assert "default=tenant_keys.DEFAULT_TENANT_ID" not in text
    assert "tenant_id: str = tenant_keys.DEFAULT_TENANT_ID" not in text


def main() -> int:
    run("the CLI requires --tenant-id (argparse fails without it)", test_cli_requires_tenant_id)
    run("the CLI fails closed for an unknown tenant before any DB access", test_cli_fails_closed_for_an_unknown_tenant_before_any_db_access)
    run("no implicit tenant default anywhere in this file", test_no_implicit_tenant_default_anywhere_in_main)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
