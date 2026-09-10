"""
repair_review_identity.py -- one-time, repeatable backfill that restores the
review-identity invariant db.py now upholds going forward:

    whenever reviews.gbp_review_name IS NOT NULL, dedup_key must equal it.

Rows linked by gbp_import.py's historical reconciliation (via
db.link_review_to_gbp(), before its own dedup_key fix) violate this: they
have a real gbp_review_name but a stale, pre-GBP dedup_key. This is exactly
what caused the 2026-07-28 production incident (a live gbp_sync upsert
computed dedup_key = gbp_review_name, found no row, and attempted a
duplicate insert that violated the partial UNIQUE index on gbp_review_name).

This script only ever backfills dedup_key for already-linked rows. It never
deletes, merges, or guesses -- if any collision would make that backfill
itself violate dedup_key's own UNIQUE constraint, it stops and reports the
exact rows involved instead of choosing one automatically.

Multi-Tenant Phase 4D revision: --tenant-id is REQUIRED. --db still exists
to point at a scratch copy for a safe first dry-run, but its default is now
the tenant's own registered database (tenant_paths.py), never a bare
db.DB_PATH global.

Usage:
    py repair_review_identity.py --tenant-id t_los-tres-amigos                # preflight report only (dry run)
    py repair_review_identity.py --tenant-id t_los-tres-amigos --apply        # actually runs the backfill
    py repair_review_identity.py --tenant-id t_los-tres-amigos --db path/to/scratch.db [--apply]
"""
import argparse
import sqlite3
import sys
from pathlib import Path

import tenant_keys
import tenant_paths


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def preflight(conn: sqlite3.Connection) -> dict:
    """Read-only report. Never writes anything. Returns a dict with every
    count the task's preflight requirements ask for, plus the exact list of
    any collision that would block the migration."""
    total_reviews = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
    gbp_linked = conn.execute(
        "SELECT COUNT(*) c FROM reviews WHERE gbp_review_name IS NOT NULL"
    ).fetchone()["c"]
    violating = conn.execute(
        "SELECT COUNT(*) c FROM reviews WHERE gbp_review_name IS NOT NULL AND dedup_key != gbp_review_name"
    ).fetchone()["c"]

    dup_gbp_names = conn.execute(
        """SELECT gbp_review_name, COUNT(*) c FROM reviews
           WHERE gbp_review_name IS NOT NULL
           GROUP BY gbp_review_name HAVING COUNT(*) > 1"""
    ).fetchall()

    # The exact collision this task calls out explicitly: a row R that needs
    # dedup_key := R.gbp_review_name, where some OTHER row S already holds
    # that exact string as ITS dedup_key. Applying the backfill to R would
    # violate dedup_key's own UNIQUE constraint via S.
    violating_rows = conn.execute(
        """SELECT id, location_id, dedup_key, gbp_review_name FROM reviews
           WHERE gbp_review_name IS NOT NULL AND dedup_key != gbp_review_name"""
    ).fetchall()

    collisions = []
    for r in violating_rows:
        blocker = conn.execute(
            "SELECT id, gbp_review_name FROM reviews WHERE dedup_key = ? AND id != ?",
            (r["gbp_review_name"], r["id"]),
        ).fetchone()
        if blocker is not None:
            collisions.append({
                "row_to_migrate": r["id"],
                "row_to_migrate_current_dedup_key": r["dedup_key"],
                "target_gbp_review_name": r["gbp_review_name"],
                "blocking_row": blocker["id"],
                "blocking_row_gbp_review_name": blocker["gbp_review_name"],
            })

    return {
        "total_reviews": total_reviews,
        "gbp_linked_reviews": gbp_linked,
        "invariant_violations": violating,
        "duplicate_gbp_review_names": [dict(r) for r in dup_gbp_names],
        "collisions": collisions,
    }


def print_preflight(report: dict) -> None:
    print("=== Preflight report ===")
    print(f"Total review rows:                    {report['total_reviews']}")
    print(f"Rows with non-null gbp_review_name:    {report['gbp_linked_reviews']}")
    print(f"Rows violating the identity invariant: {report['invariant_violations']}")
    print(f"Duplicate non-null gbp_review_name values: {len(report['duplicate_gbp_review_names'])}")
    for d in report["duplicate_gbp_review_names"]:
        print(f"  !! gbp_review_name={d['gbp_review_name']!r} appears on {d['c']} rows")
    print(f"Collisions (target gbp_review_name already used as another row's dedup_key): {len(report['collisions'])}")
    for c in report["collisions"]:
        print(f"  !! row {c['row_to_migrate']} (dedup_key={c['row_to_migrate_current_dedup_key']!r}) "
              f"wants dedup_key={c['target_gbp_review_name']!r}, "
              f"but row {c['blocking_row']} (gbp_review_name={c['blocking_row_gbp_review_name']!r}) already holds it")


def run_backfill(conn: sqlite3.Connection) -> dict:
    """Transactional, idempotent, additive-only: UPDATE reviews SET dedup_key
    = gbp_review_name for exactly the rows that violate the invariant. Never
    deletes or merges a row. Rolls back completely on any error."""
    report = preflight(conn)
    if report["collisions"]:
        raise RuntimeError(
            f"{len(report['collisions'])} collision(s) detected -- refusing to migrate automatically. "
            "See print_preflight() output for the exact rows involved."
        )
    if report["duplicate_gbp_review_names"]:
        raise RuntimeError(
            "Duplicate non-null gbp_review_name values exist -- this should be structurally impossible "
            "under the partial UNIQUE index and indicates a deeper problem. Refusing to migrate."
        )

    examined = report["invariant_violations"]
    try:
        cur = conn.execute(
            "UPDATE reviews SET dedup_key = gbp_review_name "
            "WHERE gbp_review_name IS NOT NULL AND dedup_key != gbp_review_name"
        )
        changed = cur.rowcount
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    return {"rows_examined": examined, "rows_changed": changed}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=None,
                         help="Path to the SQLite DB to operate on (default: the --tenant-id's own "
                              "registered review database -- see tenant_paths.py). Use this to point "
                              "at a SCRATCH COPY, never the real database, for a first dry-run.")
    parser.add_argument("--apply", action="store_true",
                         help="Actually run the backfill (default: preflight report only, no writes)")
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant whose review database to repair. REQUIRED -- no "
                              "default. This script never infers a tenant on its own.")
    args = parser.parse_args()

    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::repair_review_identity.py: invalid --tenant-id {args.tenant_id!r}")
        return 1
    try:
        db_path = args.db or tenant_paths.resolve_review_db_path(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::repair_review_identity.py: {e}")
        return 1
    if not db_path.exists():
        print(f"::error::repair_review_identity.py: no database at {db_path}")
        return 1

    conn = _connect(db_path)
    report = preflight(conn)
    print_preflight(report)

    if report["collisions"] or report["duplicate_gbp_review_names"]:
        print("\nrepair_review_identity.py: STOPPING -- collisions/duplicates must be resolved by hand first.")
        conn.close()
        return 1

    if not args.apply:
        print("\nDRY RUN -- no changes written (pass --apply to commit).")
        conn.close()
        return 0

    result = run_backfill(conn)
    print(f"\nrepair_review_identity.py: examined {result['rows_examined']} violating row(s), "
          f"changed {result['rows_changed']}.")

    post = preflight(conn)
    if post["invariant_violations"] != 0:
        print(f"::error::repair_review_identity.py: {post['invariant_violations']} violation(s) remain after migration!")
        conn.close()
        return 1

    print("repair_review_identity.py: invariant now holds -- 0 violations remain.")
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
