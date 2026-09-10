"""
backfill_sentiment.py — one-time historical AI sentiment/priority classification.

refresh_analytics.py classifies at most CLASSIFY_LIMIT_PER_RUN reviews per
6-hour pipeline run (so a normal run stays fast and cheap). This script
instead walks the *entire* unclassified backlog in batches, committing after
every batch so it's safe to Ctrl-C and re-run -- get_reviews_needing_classification()
only ever returns rows whose ai_hash doesn't match their current content, so
already-classified reviews are skipped automatically on a re-run.

Multi-Tenant Phase 4D revision: --tenant-id is REQUIRED. This script reads
AND writes the real, tenant-owned review database (db.save_ai_classification()
below), so it gets the same fail-closed treatment as every other
production-capable entrypoint -- resolved via tenant_paths.py before any DB
connection is opened.

Usage:
    python backfill_sentiment.py --tenant-id t_los-tres-amigos              # classify everything unclassified
    python backfill_sentiment.py --tenant-id t_los-tres-amigos --limit 500  # classify at most 500 reviews
"""
import argparse
import sys
import time

import ai_engine
import db
import tenant_keys
import tenant_paths


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=None, help="Max reviews to classify this run")
    parser.add_argument("--batch-size", type=int, default=20, help="Reviews per Claude call")
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant whose review database to classify. REQUIRED -- no "
                              "default. This script never infers a tenant on its own.")
    args = parser.parse_args()

    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::backfill_sentiment.py: invalid --tenant-id {args.tenant_id!r}")
        sys.exit(1)
    try:
        db.DB_PATH = tenant_paths.resolve_review_db_path(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::backfill_sentiment.py: {e}")
        sys.exit(1)

    if not ai_engine.is_available():
        print("ANTHROPIC_API_KEY not set -- nothing to do.")
        sys.exit(1)

    conn = db.get_connection()
    db.init_schema(conn)

    to_classify = db.get_reviews_needing_classification(conn, limit=args.limit)
    total = len(to_classify)
    if total == 0:
        print("Nothing to classify -- all reviews already have current AI sentiment.")
        return

    print(f"Classifying {total} reviews in batches of {args.batch_size}...")
    ai_engine._CLASSIFY_BATCH_SIZE = args.batch_size  # honor --batch-size override

    classified_count = 0
    start = time.time()
    for i in range(0, total, args.batch_size):
        chunk = to_classify[i:i + args.batch_size]
        results = ai_engine.classify_reviews_batch(chunk)
        for r in chunk:
            result = results.get(r["id"])
            if not result:
                continue
            content_hash = db.review_content_hash(r["review_text"], r["star_rating"])
            db.save_ai_classification(
                conn, r["id"], result["sentiment"], result["reason"], result["priority"], content_hash,
            )
        conn.commit()
        classified_count += len(results)
        done = min(i + args.batch_size, total)
        elapsed = time.time() - start
        print(f"  {done}/{total} reviews processed ({classified_count} classified) — {elapsed:.0f}s elapsed")

    conn.close()
    print(f"Done. Classified {classified_count}/{total} reviews.")


if __name__ == "__main__":
    main()
