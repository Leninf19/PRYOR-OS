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

Multi-Tenant Phase 4D revision: this script reads the REAL, tenant-owned
review database as its copy source, so --tenant-id is REQUIRED -- the
source path is resolved via tenant_paths.resolve_review_db_path(), never
the old hardcoded SOURCE_DB_PATH constant (removed).

Usage:
    py bootstrap_mock_snapshot.py --tenant-id t_los-tres-amigos             # refuses if a snapshot already exists
    py bootstrap_mock_snapshot.py --tenant-id t_los-tres-amigos --force     # overwrites an existing snapshot
"""
import argparse
import shutil
import sqlite3
from pathlib import Path

import local_safety
import tenant_keys
import tenant_paths
from provider_mock import DEFAULT_SNAPSHOT_PATH

BASE_DIR = Path(__file__).parent


def bootstrap(source_path: Path, snapshot_path: Path = DEFAULT_SNAPSHOT_PATH,
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
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant whose review database to snapshot. REQUIRED -- no "
                              "default. This script never infers a tenant on its own.")
    args = parser.parse_args()

    # The CI/production safety guard runs before anything tenant-related --
    # this tool must never even attempt to resolve a tenant's database
    # inside an automated environment, valid --tenant-id or not.
    local_safety.ensure_safe_for_local_mode()

    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::bootstrap_mock_snapshot.py: invalid --tenant-id {args.tenant_id!r}")
        return 1
    try:
        source_path = tenant_paths.resolve_review_db_path(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::bootstrap_mock_snapshot.py: {e}")
        return 1

    # DEFAULT_SNAPSHOT_PATH looked up as a module global at call time (not
    # passed via bootstrap()'s own default parameter value, which would
    # otherwise be frozen at import time) so tests can monkeypatch it and
    # have main() actually honor the patched path.
    ok, message = bootstrap(source_path, DEFAULT_SNAPSHOT_PATH, force=args.force)
    print(message if ok else f"::error::{message}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
