"""
bootstrap_mock_snapshot.py -- Phase 3 Milestone 3: creates (or refreshes) the
local, gitignored snapshot database MockProvider reads from, by copying the
real dashboard/reviews.db. Never writes back to the real file -- this is a
one-way, point-in-time copy.

Reuses local_safety.ensure_safe_for_local_mode() (the same guard
auto_update.py --local uses) so this can never run under CI/Vercel/production
env vars -- it's uncaught here deliberately, matching auto_update.py's own
convention of letting an unsafe-environment failure crash loudly rather than
being silently swallowed.

Usage:
    py bootstrap_mock_snapshot.py            # refuses if a snapshot already exists
    py bootstrap_mock_snapshot.py --force     # overwrites an existing snapshot
"""
import argparse
import shutil
import sqlite3
from pathlib import Path

import local_safety
from provider_mock import DEFAULT_SNAPSHOT_PATH

BASE_DIR = Path(__file__).parent
SOURCE_DB_PATH = BASE_DIR / "dashboard" / "reviews.db"


def bootstrap(source_path: Path = SOURCE_DB_PATH, snapshot_path: Path = DEFAULT_SNAPSHOT_PATH,
              force: bool = False) -> tuple[bool, str]:
    """Returns (ok, message). Never raises for an expected failure mode --
    every failure is reported through the return value, matching
    check_db_integrity.py's check_integrity() convention."""
    if not source_path.exists():
        return False, f"{source_path} does not exist -- nothing to snapshot."
    if snapshot_path.exists() and not force:
        return False, f"{snapshot_path} already exists -- refusing to overwrite without --force."

    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_path, snapshot_path)

    conn = sqlite3.connect(str(snapshot_path))
    try:
        counts = {
            "locations": conn.execute("SELECT COUNT(*) FROM locations").fetchone()[0],
            "reviews": conn.execute("SELECT COUNT(*) FROM reviews WHERE is_deleted = 0").fetchone()[0],
        }
    finally:
        conn.close()

    return True, f"Snapshot created at {snapshot_path} -- {counts['locations']} locations, {counts['reviews']} reviews."


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="Overwrite an existing snapshot if one already exists")
    args = parser.parse_args()

    local_safety.ensure_safe_for_local_mode()

    # Looked up as module globals at call time (not passed via bootstrap()'s
    # own default parameter values, which would otherwise be frozen at import
    # time) so tests can monkeypatch SOURCE_DB_PATH/DEFAULT_SNAPSHOT_PATH and
    # have main() actually honor the patched paths.
    ok, message = bootstrap(SOURCE_DB_PATH, DEFAULT_SNAPSHOT_PATH, force=args.force)
    print(message if ok else f"::error::{message}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
