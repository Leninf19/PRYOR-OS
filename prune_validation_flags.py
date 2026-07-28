"""
prune_validation_flags.py -- retention maintenance for validation_flags.

validate.py (fixed 2026-07-28) no longer creates a new row every run for a
persisting condition -- but 575,864 rows already exist from before that fix,
56.6 MiB (57%) of the committed database, almost entirely already-resolved
duplicates of the same handful of persisting conditions. This script is the
one-time (and safely re-runnable) cleanup of that backlog. It is limited,
by design, to exactly one thing: deleting RESOLVED validation_flags rows
older than a retention window. It never touches reviews, locations, review
revisions, GBP identities, review responses, or any open (unresolved) flag.

Retention default and evidence: traced every reader of this table --
notify.py's duplicate_review_url alert and export_chunks.py's
export_validation() both query `WHERE resolved_at IS NULL` exclusively.
dashboard/src/pages/DataValidation.jsx computes its own report client-side
and does not even read the exported validation.json. No current feature
anywhere consumes resolved-flag history for trend reporting, auditing,
executive analytics, location comparisons, operational accountability, or
debugging. The default below (7 days) is therefore chosen only as a short,
human-debugging grace period -- long enough to look back at something
noticed within the past week, not tied to any actual product requirement --
and is fully overridable via --retention-days.

Usage:
    py prune_validation_flags.py                         # preflight report only (dry run)
    py prune_validation_flags.py --retention-days 7 --apply
    py prune_validation_flags.py --db path/to/scratch.db --apply --vacuum
"""
import argparse
import hashlib
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import db

DEFAULT_RETENTION_DAYS = 7

AGE_BUCKETS_DAYS = [7, 30, 90, 365]  # boundaries; see _age_bucket_label()


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _age_bucket_label(days: float) -> str:
    for boundary in AGE_BUCKETS_DAYS:
        if days <= boundary:
            return f"<= {boundary}d"
    return f"> {AGE_BUCKETS_DAYS[-1]}d"


def preflight(conn: sqlite3.Connection, db_path: Path, retention_days: int) -> dict:
    """Read-only. Never writes anything."""
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=retention_days)).isoformat()

    file_size = db_path.stat().st_size
    total_reviews = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
    total_locations = conn.execute("SELECT COUNT(*) c FROM locations").fetchone()["c"]
    total_flags = conn.execute("SELECT COUNT(*) c FROM validation_flags").fetchone()["c"]
    open_flags = conn.execute("SELECT COUNT(*) c FROM validation_flags WHERE resolved_at IS NULL").fetchone()["c"]
    resolved_flags = total_flags - open_flags

    by_type = conn.execute(
        "SELECT flag_type, COUNT(*) c, SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) open_c "
        "FROM validation_flags GROUP BY flag_type ORDER BY c DESC"
    ).fetchall()

    # Age buckets, computed from resolved_at for resolved rows (what the
    # retention rule actually operates on).
    resolved_rows = conn.execute(
        "SELECT resolved_at FROM validation_flags WHERE resolved_at IS NOT NULL"
    ).fetchall()
    age_buckets: dict = {}
    for r in resolved_rows:
        try:
            resolved_dt = datetime.fromisoformat(r["resolved_at"])
            if resolved_dt.tzinfo is None:
                resolved_dt = resolved_dt.replace(tzinfo=timezone.utc)
            age_days = (now - resolved_dt).total_seconds() / 86400
        except (ValueError, TypeError):
            age_days = float("inf")
        label = _age_bucket_label(age_days)
        age_buckets[label] = age_buckets.get(label, 0) + 1

    would_delete = conn.execute(
        "SELECT COUNT(*) c FROM validation_flags WHERE resolved_at IS NOT NULL AND resolved_at < ?",
        (cutoff,),
    ).fetchone()["c"]
    would_remain = total_flags - would_delete

    # Estimate resulting size proportionally to rows removed -- a real
    # number only comes from actually running VACUUM; this is a preflight
    # estimate, clearly labeled as such.
    estimated_after = int(file_size * (would_remain / total_flags)) if total_flags else file_size

    integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
    db_hash = file_hash(db_path)

    return {
        "file_size_bytes": file_size,
        "total_reviews": total_reviews,
        "total_locations": total_locations,
        "total_flags": total_flags,
        "open_flags": open_flags,
        "resolved_flags": resolved_flags,
        "by_flag_type": [dict(r) for r in by_type],
        "age_buckets_resolved": age_buckets,
        "retention_days": retention_days,
        "cutoff": cutoff,
        "would_delete": would_delete,
        "would_remain": would_remain,
        "estimated_size_after_bytes": estimated_after,
        "features_losing_history": [],  # see print_preflight()'s hardcoded note -- traced, not guessed
        "integrity_check": integrity,
        "file_hash": db_hash,
    }


def print_preflight(report: dict) -> None:
    print("=== Preflight report ===")
    print(f"Database file size:        {report['file_size_bytes'] / (1024*1024):.2f} MiB")
    print(f"Total review count:        {report['total_reviews']}")
    print(f"Total location count:      {report['total_locations']}")
    print(f"Total validation flags:    {report['total_flags']}")
    print(f"  open:                    {report['open_flags']}")
    print(f"  resolved:                {report['resolved_flags']}")
    print("Counts by flag_type (total / open):")
    for row in report["by_flag_type"]:
        print(f"  {row['flag_type']:<22} {row['c']:>8}  (open: {row['open_c']})")
    print("Resolved-row age distribution:")
    for label, count in sorted(report["age_buckets_resolved"].items()):
        print(f"  {label:<10} {count}")
    print(f"Retention window: {report['retention_days']} days (cutoff {report['cutoff']})")
    print(f"Rows that would be deleted:  {report['would_delete']}")
    print(f"Rows that would remain:      {report['would_remain']}")
    print(f"Estimated size after (pre-VACUUM proportional estimate): "
          f"{report['estimated_size_after_bytes'] / (1024*1024):.2f} MiB")
    print("Features that would lose accessible history: none -- traced every reader "
          "(notify.py, export_chunks.py, DataValidation.jsx); all query open flags only, "
          "none read resolved-flag history.")
    print(f"PRAGMA integrity_check: {report['integrity_check']}")
    print(f"File hash (sha256): {report['file_hash']}")


def run_prune(conn: sqlite3.Connection, retention_days: int) -> dict:
    """Transactional, idempotent, narrowly scoped: deletes ONLY
    validation_flags rows where resolved_at IS NOT NULL AND resolved_at is
    older than the retention window. Never touches any other table, never
    touches an open flag, never touches a resolved flag inside the window.
    Rolls back completely on any error."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()

    before_reviews = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
    before_locations = conn.execute("SELECT COUNT(*) c FROM locations").fetchone()["c"]
    before_open = conn.execute("SELECT COUNT(*) c FROM validation_flags WHERE resolved_at IS NULL").fetchone()["c"]

    try:
        cur = conn.execute(
            "DELETE FROM validation_flags WHERE resolved_at IS NOT NULL AND resolved_at < ?",
            (cutoff,),
        )
        deleted = cur.rowcount

        after_reviews = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
        after_locations = conn.execute("SELECT COUNT(*) c FROM locations").fetchone()["c"]
        after_open = conn.execute("SELECT COUNT(*) c FROM validation_flags WHERE resolved_at IS NULL").fetchone()["c"]

        if after_reviews != before_reviews:
            raise RuntimeError(f"review count changed ({before_reviews} -> {after_reviews}) -- aborting")
        if after_locations != before_locations:
            raise RuntimeError(f"location count changed ({before_locations} -> {after_locations}) -- aborting")
        if after_open != before_open:
            raise RuntimeError(f"open flag count changed ({before_open} -> {after_open}) -- aborting")

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
        "open_flags_unchanged": after_open == before_open,
        "integrity_after_delete": integrity,
    }


def compact(conn: sqlite3.Connection) -> dict:
    """Only call after run_prune() has succeeded and its post-conditions
    have been verified. Records size/time before and after."""
    start = time.monotonic()
    conn.execute("VACUUM")
    elapsed = time.monotonic() - start
    return {"vacuum_seconds": elapsed}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=None,
                         help="Path to the SQLite DB to operate on (default: db.DB_PATH)")
    parser.add_argument("--retention-days", type=int, default=DEFAULT_RETENTION_DAYS,
                         help=f"Delete resolved flags older than this many days (default: {DEFAULT_RETENTION_DAYS})")
    parser.add_argument("--apply", action="store_true",
                         help="Actually delete (default: preflight report only, no writes)")
    parser.add_argument("--vacuum", action="store_true",
                         help="Run VACUUM after a successful --apply (ignored without --apply)")
    args = parser.parse_args()

    db_path = args.db or db.DB_PATH
    if not db_path.exists():
        print(f"::error::prune_validation_flags.py: no database at {db_path}")
        return 1

    conn = _connect(db_path)
    report = preflight(conn, db_path, args.retention_days)
    print_preflight(report)

    if report["integrity_check"] != "ok":
        print("\n::error::prune_validation_flags.py: STOPPING -- integrity_check is not 'ok'.")
        conn.close()
        return 1

    if not args.apply:
        print("\nDRY RUN -- no changes written (pass --apply to commit).")
        conn.close()
        return 0

    size_before = db_path.stat().st_size
    result = run_prune(conn, args.retention_days)
    print(f"\nprune_validation_flags.py: deleted {result['rows_deleted']} resolved row(s). "
          f"reviews_unchanged={result['reviews_unchanged']} "
          f"locations_unchanged={result['locations_unchanged']} "
          f"open_flags_unchanged={result['open_flags_unchanged']} "
          f"integrity={result['integrity_after_delete']}")

    size_after_delete = db_path.stat().st_size
    print(f"File size before delete:              {size_before / (1024*1024):.2f} MiB")
    print(f"File size after delete (pre-VACUUM):   {size_after_delete / (1024*1024):.2f} MiB "
          f"(SQLite does not shrink a file on DELETE alone -- expected to be ~unchanged until VACUUM)")

    if args.vacuum:
        vac = compact(conn)
        size_after_vacuum = db_path.stat().st_size
        final_hash = file_hash(db_path)
        print(f"File size after VACUUM:               {size_after_vacuum / (1024*1024):.2f} MiB")
        print(f"VACUUM time:                          {vac['vacuum_seconds']:.2f}s")
        print(f"Final file hash (sha256):             {final_hash}")

    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
