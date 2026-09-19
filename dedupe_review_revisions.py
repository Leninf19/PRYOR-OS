"""
dedupe_review_revisions.py -- one-time (and safely re-runnable) cleanup of
review_revisions rows that are PROVABLY duplicate artifacts of the
review_revisions growth bug (recovery audit, 2026-09-19; see db.py's
upsert_review()/_normalize_text_field() fix).

THE DEFECT THIS CLEANS UP: upsert_review()'s change-detection used to compare
the RAW incoming provider value against the ALREADY-NORMALIZED (.strip()'d)
stored value for review_text/owner_response. Since the UPDATE statement runs
unconditionally on every sync, the stored value converged to its stripped
form after the first sync, while a provider (confirmed: Google Business
Profile API) that returns the SAME reply text with incidental leading/
trailing whitespace on every fetch made this look "changed" on every single
subsequent sync, forever -- one spurious review_revisions row per run, per
affected review. The comparison itself is now fixed (db.py); this script
cleans up the historical backlog that bug already produced.

THE PREDICATE: a row is a PROVABLE DUPLICATE if and only if ITS OWN
old_value and new_value are identical after str.strip() -- the EXACT same
normalization db.py's _normalize_text_field() applies -- i.e., the row
itself records that nothing logically changed at that point in time. This
is a purely mechanical, deterministic check on each row's own two columns,
computed in Python (never SQLite's TRIM(), which only strips ASCII space by
default and would miss the tab/newline whitespace real payloads contained);
it never compares across rows, never infers intent from surrounding
history, and never touches a row where the normalized values genuinely
differ (a real content change, a first-time reply, an edited reply, a
removed/changed rating).

Confirmed against production data before writing this script: 225,137 of
232,183 owner_response revision rows (97.0%) satisfy this predicate exactly;
7,046 do not and are preserved as genuine history. review_text (194 rows)
had zero rows matching this predicate -- the predicate is field-agnostic by
design (it never special-cases owner_response), and it naturally affects
only the field the bug actually corrupted.

SAFETY GUARANTEES (enforced by run_dedupe(), not just documented here):
  - never touches the reviews table's row count or any review's current
    owner_response/review_text/star_rating value
  - never deletes a review, a location, or any row in another table
  - never deletes a review_revisions row whose own old_value/new_value
    differ after normalization (a genuine change)
  - snapshots every genuine row's own id before deleting anything and
    proves, after, that every single one of those ids still exists --
    a stronger guarantee than a mere count match
  - transactional: rolls back completely if any invariant is violated
  - idempotent: a second run finds 0 further rows to delete, since every
    remaining row (by construction) has old_value != new_value

Usage:
    py dedupe_review_revisions.py --tenant-id t_los-tres-amigos                     # preflight report only (dry run)
    py dedupe_review_revisions.py --tenant-id t_los-tres-amigos --apply
    py dedupe_review_revisions.py --tenant-id t_los-tres-amigos --db path/to/scratch.db --apply
"""
import argparse
import sqlite3
from collections import defaultdict
from pathlib import Path

import tenant_keys
import tenant_paths


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _is_provable_duplicate(old_value, new_value) -> bool:
    """The ONE identity check this whole script is built around. Computed in
    Python using the exact same normalization db.py's _normalize_text_field()
    applies (str.strip()) -- deliberately NOT SQLite's TRIM(), which by
    default only strips ASCII space (0x20), missing the tab/newline
    whitespace this bug's real-world payloads actually contained. Using
    anything looser than the app's own real normalization here would either
    under-clean (leave bug artifacts behind) or, worse, risk misclassifying
    a genuine change -- this must match db.py exactly, not approximate it."""
    return (old_value or "").strip() == (new_value or "").strip()


def _fetch_ids_to_delete(conn: sqlite3.Connection) -> set:
    rows = conn.execute("SELECT id, old_value, new_value FROM review_revisions").fetchall()
    return {r["id"] for r in rows if _is_provable_duplicate(r["old_value"], r["new_value"])}


def preflight(conn: sqlite3.Connection) -> dict:
    """Read-only. Never writes anything."""
    rows = conn.execute("SELECT id, field_changed, review_id, old_value, new_value FROM review_revisions").fetchall()
    total = len(rows)
    by_field_total = defaultdict(int)
    by_field_dup = defaultdict(int)
    would_delete = 0
    affected_reviews = set()
    for r in rows:
        by_field_total[r["field_changed"]] += 1
        if _is_provable_duplicate(r["old_value"], r["new_value"]):
            by_field_dup[r["field_changed"]] += 1
            would_delete += 1
            affected_reviews.add(r["review_id"])
    by_field = [
        {"field_changed": f, "c": c, "dup_c": by_field_dup[f]}
        for f, c in sorted(by_field_total.items(), key=lambda kv: -kv[1])
    ]
    integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
    return {
        "total_rows": total,
        "by_field": by_field,
        "would_delete": would_delete,
        "would_remain": total - would_delete,
        "distinct_reviews_affected": len(affected_reviews),
        "integrity_check": integrity,
    }


def print_preflight(report: dict) -> None:
    print("=== Preflight report (review_revisions dedupe) ===")
    print(f"Total review_revisions rows:  {report['total_rows']}")
    print("By field_changed (total / provable-duplicate):")
    for row in report["by_field"]:
        print(f"  {row['field_changed']:<18} {row['c']:>8}  (duplicate: {row['dup_c']})")
    print(f"Rows that would be deleted (provable duplicates): {report['would_delete']}")
    print(f"Rows that would remain (genuine history):          {report['would_remain']}")
    print(f"Distinct reviews with at least one duplicate row:  {report['distinct_reviews_affected']}")
    print("This script never touches the reviews table, never changes a review's "
          "current field values, and never deletes a row whose old_value/new_value "
          "genuinely differ after normalization.")
    print(f"PRAGMA integrity_check: {report['integrity_check']}")


def run_dedupe(conn: sqlite3.Connection) -> dict:
    """Transactional, idempotent, narrowly scoped -- see module docstring's
    Safety Guarantees section. Rolls back completely on any violation."""
    before_reviews = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
    before_locations = conn.execute("SELECT COUNT(*) c FROM locations").fetchone()["c"]
    all_ids_before = {r["id"] for r in conn.execute("SELECT id FROM review_revisions").fetchall()}
    ids_to_delete = _fetch_ids_to_delete(conn)
    before_genuine_ids = all_ids_before - ids_to_delete

    # Batched (SQLite's default bound-parameter limit is well below the
    # ~225k rows a real run deletes) -- still one single transaction overall
    # (no commit() between batches), so the atomicity/rollback guarantee is
    # unaffected: either every batch's delete is committed together at the
    # end, or (on any invariant violation) the whole transaction rolls back.
    BATCH_SIZE = 500
    try:
        deleted = 0
        ids_list = list(ids_to_delete)
        for i in range(0, len(ids_list), BATCH_SIZE):
            batch = ids_list[i:i + BATCH_SIZE]
            placeholders = ",".join("?" * len(batch))
            cur = conn.execute(f"DELETE FROM review_revisions WHERE id IN ({placeholders})", tuple(batch))
            deleted += cur.rowcount

        after_reviews = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
        after_locations = conn.execute("SELECT COUNT(*) c FROM locations").fetchone()["c"]
        after_ids = {r["id"] for r in conn.execute("SELECT id FROM review_revisions").fetchall()}

        if after_reviews != before_reviews:
            raise RuntimeError(f"review count changed ({before_reviews} -> {after_reviews}) -- aborting")
        if after_locations != before_locations:
            raise RuntimeError(f"location count changed ({before_locations} -> {after_locations}) -- aborting")
        missing_genuine = before_genuine_ids - after_ids
        if missing_genuine:
            raise RuntimeError(
                f"{len(missing_genuine)} genuine (non-duplicate) revision row(s) were removed -- aborting"
            )

        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise RuntimeError(f"integrity_check returned {integrity!r} after deletion -- aborting")

        conn.commit()
    except Exception:
        conn.rollback()
        raise

    return {
        "rows_deleted": deleted,
        "reviews_unchanged": after_reviews == before_reviews,
        "locations_unchanged": after_locations == before_locations,
        "genuine_rows_preserved": not missing_genuine,
        "genuine_row_count": len(before_genuine_ids),
        "integrity_after_delete": integrity,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=None,
                         help="Path to the SQLite DB to operate on (default: the --tenant-id's own "
                              "registered review database). Use this to point at a SCRATCH COPY, "
                              "never the real database, for a first dry-run.")
    parser.add_argument("--apply", action="store_true",
                         help="Actually delete (default: preflight report only, no writes)")
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant whose review database to dedupe. REQUIRED -- no "
                              "default. This script never infers a tenant on its own.")
    args = parser.parse_args()

    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::dedupe_review_revisions.py: invalid --tenant-id {args.tenant_id!r}")
        return 1
    try:
        db_path = args.db or tenant_paths.resolve_review_db_path(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::dedupe_review_revisions.py: {e}")
        return 1
    if not db_path.exists():
        print(f"::error::dedupe_review_revisions.py: no database at {db_path}")
        return 1

    conn = _connect(db_path)
    report = preflight(conn)
    print_preflight(report)

    if report["integrity_check"] != "ok":
        print("\n::error::dedupe_review_revisions.py: STOPPING -- integrity_check is not 'ok'.")
        conn.close()
        return 1

    if not args.apply:
        print("\nDRY RUN -- no changes written (pass --apply to commit).")
        conn.close()
        return 0

    size_before = db_path.stat().st_size
    result = run_dedupe(conn)
    print(f"\ndedupe_review_revisions.py: deleted {result['rows_deleted']} provable-duplicate row(s). "
          f"reviews_unchanged={result['reviews_unchanged']} locations_unchanged={result['locations_unchanged']} "
          f"genuine_rows_preserved={result['genuine_rows_preserved']} ({result['genuine_row_count']} genuine rows) "
          f"integrity={result['integrity_after_delete']}")

    size_after_delete = db_path.stat().st_size
    print(f"File size before delete:            {size_before / (1024*1024):.2f} MiB")
    print(f"File size after delete (pre-VACUUM): {size_after_delete / (1024*1024):.2f} MiB "
          f"(SQLite does not shrink a file on DELETE alone -- run a VACUUM step, e.g. via "
          f"prune_validation_flags.py --vacuum, to actually reclaim the space)")

    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
