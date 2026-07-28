"""
Regression tests for db.py's review identity model -- dedup_key,
gbp_review_name, and the interaction between upsert_review() and
link_review_to_gbp().

Reproduces the production incident (2026-07-28): gbp_import.py's
link_review_to_gbp() attaches a real gbp_review_name to an already-known
scraped row but never updates dedup_key, so a later live GBP sync of that
same review computes dedup_key = gbp_review_name, finds no row (the
existing row's dedup_key is still its stale scraper-era value), and
attempts to INSERT a duplicate -- tripping the partial UNIQUE index on
gbp_review_name with a raw sqlite3.IntegrityError that crashes the whole
sync process (nothing in provider_sync.py/sync_reviews.py catches it).

Every test uses a temporary, isolated SQLite DB -- never the real
dashboard/reviews.db.

Run directly: py tests/test_db.py
"""
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db


def _fresh_conn():
    tmpdir = tempfile.mkdtemp(prefix="test_db_identity_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    conn = db.get_connection()
    db.init_schema(conn)
    cur = conn.execute(
        "INSERT INTO locations (name, city, brand) VALUES ('Casa Tequila Testtown', 'Testtown', 'Casa Tequila')"
    )
    conn.commit()
    return conn, cur.lastrowid


def _review_count(conn) -> int:
    return conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]


def _run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        return True
    except AssertionError as e:
        print(f"FAIL: {name} -- {e}")
        return False
    except Exception as e:
        print(f"FAIL: {name} -- unexpected {type(e).__name__}: {e}")
        return False


# ---------------------------------------------------------------------------
# Case 1: a row already linked by the historical import (gbp_review_name set,
# dedup_key still stale) must be UPDATED, not duplicated, the next time a
# live sync sees the same review.
# ---------------------------------------------------------------------------

def test_historically_linked_row_is_updated_not_duplicated():
    conn, loc_id = _fresh_conn()
    now = "2026-07-28T00:00:00Z"

    conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, gbp_review_name, reviewer_name,
           review_date, star_rating, review_text, first_seen_at, last_seen_at)
           VALUES (?, 'legacy-scraper-key', 'reviews/ABC', 'Jane Doe',
           '2026-06-01', 5, 'Great food', ?, ?)""",
        (loc_id, now, now),
    )
    conn.commit()
    assert _review_count(conn) == 1

    row = {
        "gbp_review_name": "reviews/ABC",
        "reviewer_name": "Jane Doe",
        "review_date": "2026-06-01",
        "star_rating": 5,
        "review_text": "Great food",
        "owner_response": "",
        "review_url": "",
        "gbp_update_time": "2026-07-28T00:00:00Z",
    }
    result = db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, now)
    conn.commit()

    assert _review_count(conn) == 1, "a duplicate row was inserted for an already-linked review"
    updated = conn.execute("SELECT * FROM reviews WHERE gbp_review_name = 'reviews/ABC'").fetchone()
    assert updated is not None
    assert updated["dedup_key"] == "reviews/ABC", (
        f"dedup_key was not normalized to the GBP identity, still {updated['dedup_key']!r}"
    )
    assert result in ("edited", "unchanged")


# ---------------------------------------------------------------------------
# Case 2: a genuinely new GBP review inserts cleanly with dedup_key ==
# gbp_review_name from the start.
# ---------------------------------------------------------------------------

def test_new_gbp_review_inserts_with_matching_dedup_key():
    conn, loc_id = _fresh_conn()
    now = "2026-07-28T00:00:00Z"

    row = {
        "gbp_review_name": "reviews/NEW1",
        "reviewer_name": "John Smith",
        "review_date": "2026-07-01",
        "star_rating": 4,
        "review_text": "Good service",
        "owner_response": "",
        "review_url": "",
    }
    result = db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, now)
    conn.commit()

    assert result == "new"
    assert _review_count(conn) == 1
    inserted = conn.execute("SELECT * FROM reviews WHERE gbp_review_name = 'reviews/NEW1'").fetchone()
    assert inserted["dedup_key"] == "reviews/NEW1"


# ---------------------------------------------------------------------------
# Case 3: link_review_to_gbp() must update dedup_key atomically, in the same
# statement, whenever it attaches a gbp_review_name.
# ---------------------------------------------------------------------------

def test_link_review_to_gbp_normalizes_dedup_key_atomically():
    conn, loc_id = _fresh_conn()
    now = "2026-07-28T00:00:00Z"

    cur = conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, reviewer_name, review_date,
           star_rating, review_text, first_seen_at, last_seen_at)
           VALUES (?, 'legacy-scraper-key-2', 'Maria Lopez', '2026-05-01', 3, 'Ok', ?, ?)""",
        (loc_id, now, now),
    )
    conn.commit()
    review_id = cur.lastrowid

    db.link_review_to_gbp(conn, review_id, "reviews/XYZ", gbp_update_time=now)
    conn.commit()

    row = conn.execute("SELECT * FROM reviews WHERE id = ?", (review_id,)).fetchone()
    assert row["gbp_review_name"] == "reviews/XYZ"
    assert row["dedup_key"] == "reviews/XYZ", (
        f"link_review_to_gbp did not normalize dedup_key, still {row['dedup_key']!r}"
    )
    assert row["gbp_review_name"] == row["dedup_key"]


# ---------------------------------------------------------------------------
# Case 4: syncing the same GBP review twice must insert once and update
# thereafter -- never grow the row count on the second pass.
# ---------------------------------------------------------------------------

def test_repeated_sync_never_duplicates():
    conn, loc_id = _fresh_conn()
    now = "2026-07-28T00:00:00Z"

    row = {
        "gbp_review_name": "reviews/REPEAT1",
        "reviewer_name": "Alex Kim",
        "review_date": "2026-07-02",
        "star_rating": 5,
        "review_text": "Loved it",
        "owner_response": "",
        "review_url": "",
    }
    first = db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, now)
    conn.commit()
    assert first == "new"
    assert _review_count(conn) == 1

    second = db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, now)
    conn.commit()
    assert second in ("edited", "unchanged"), f"expected an update on re-sync, got {second!r}"
    assert _review_count(conn) == 1, "re-syncing the same review increased the row count"


# ---------------------------------------------------------------------------
# Case 5: a genuinely unexpected collision (matching logic misses, but the
# database-level constraint still catches it) must surface with enough
# context to identify location/gbp_review_name/intended dedup key -- never
# a bare, unhelpful traceback, and never silently swallowed into a skip.
#
# Forced via a thin connection wrapper that makes BOTH lookup queries report
# "not found" even though a colliding row already exists -- simulating a
# future matching-logic bug or a genuine race, not the already-fixed
# migrated-row case above (which must be resolved via matching, not this
# safety net).
# ---------------------------------------------------------------------------

class _BlindLookupConn:
    """Delegates everything to a real sqlite3.Connection, except it makes the
    two identity-lookup SELECTs in upsert_review() always report no match --
    so the subsequent INSERT hits the real, physical UNIQUE constraint."""
    def __init__(self, real_conn):
        self._real = real_conn

    def execute(self, sql, params=()):
        if "SELECT * FROM reviews WHERE gbp_review_name = ?" in sql or \
           "SELECT * FROM reviews WHERE dedup_key = ?" in sql:
            return _EmptyCursor()
        return self._real.execute(sql, params)

    def __getattr__(self, name):
        return getattr(self._real, name)


class _EmptyCursor:
    def fetchone(self):
        return None


def test_unexpected_collision_surfaces_with_context_not_swallowed():
    real_conn, loc_id = _fresh_conn()
    now = "2026-07-28T00:00:00Z"

    real_conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, gbp_review_name, reviewer_name,
           review_date, star_rating, review_text, first_seen_at, last_seen_at)
           VALUES (?, 'reviews/BLIND', 'reviews/BLIND', 'Existing Reviewer',
           '2026-06-15', 5, 'Already here', ?, ?)""",
        (loc_id, now, now),
    )
    real_conn.commit()
    assert _review_count(real_conn) == 1

    blind = _BlindLookupConn(real_conn)
    row = {
        "gbp_review_name": "reviews/BLIND",
        "reviewer_name": "Existing Reviewer",
        "review_date": "2026-06-15",
        "star_rating": 5,
        "review_text": "Already here",
        "owner_response": "",
        "review_url": "",
    }

    raised = None
    try:
        db.upsert_review(blind, loc_id, "Casa Tequila Testtown", row, now)
    except sqlite3.IntegrityError as e:
        raised = e
    except Exception as e:
        raised = e

    assert raised is not None, "an unexpected collision must not be silently swallowed"
    message = str(raised)
    assert "Casa Tequila Testtown" in message, f"error must name the location, got: {message}"
    assert "reviews/BLIND" in message, f"error must name the gbp_review_name, got: {message}"
    # The row count must not have grown from a partially-applied insert.
    assert _review_count(real_conn) == 1


# ---------------------------------------------------------------------------
# Case 6 (PRIMARY -- reproduces the confirmed production bug): linking a
# scraper row to its GBP identity must preserve the reply Google's own API
# response already carries. Before the fix, link_review_to_gbp() dropped
# owner_response on the floor while still recording gbp_reply_update_time --
# confirmed in production against 77 real rows, some alerted as unanswered
# for over a year after Google's own reply timestamp.
# ---------------------------------------------------------------------------

def test_gbp_import_linking_preserves_reply_text():
    conn, loc_id = _fresh_conn()
    now = "2026-07-28T00:00:00Z"

    # An existing scraper-only row: no reply ever captured (scraper missed
    # it, or it didn't exist yet at scrape time), no GBP identity yet.
    cur = conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, reviewer_name, review_date,
           star_rating, review_text, owner_response, first_seen_at, last_seen_at)
           VALUES (?, 'legacy-scraper-key-6', 'Pat Rivera', '2026-05-15', 1,
           'Bad experience', '', ?, ?)""",
        (loc_id, now, now),
    )
    conn.commit()
    review_id = cur.lastrowid
    assert _review_count(conn) == 1

    # gbp_import.py's row dict for this same review, as parsed from a real
    # Google API response that DOES include reviewReply.
    row = {
        "gbp_review_name": "reviews/HASREPLY1",
        "gbp_update_time": "2026-05-16T00:00:00Z",
        "gbp_reply_update_time": "2026-05-20T09:30:00Z",
        "gbp_language_code": "en",
        "owner_response": "We're sorry to hear that -- please reach out so we can make it right.",
    }
    db.link_review_to_gbp(
        conn, review_id, row["gbp_review_name"], row["gbp_update_time"],
        row["gbp_reply_update_time"], row["gbp_language_code"], owner_response=row["owner_response"],
    )
    conn.commit()

    assert _review_count(conn) == 1, "linking must never change the review count"
    linked = conn.execute("SELECT * FROM reviews WHERE id = ?", (review_id,)).fetchone()
    assert linked["owner_response"] == row["owner_response"], (
        f"the Google reply text was not preserved by linking, got {linked['owner_response']!r}"
    )
    assert linked["gbp_reply_update_time"] == row["gbp_reply_update_time"]
    assert linked["gbp_review_name"] == row["gbp_review_name"]
    assert linked["dedup_key"] == row["gbp_review_name"], "dedup_key must be normalized to the GBP identity"


# ---------------------------------------------------------------------------
# Case 7: an existing non-empty owner_response must never be erased by a
# blank incoming value -- same blank-never-erases rule upsert_review() uses.
# ---------------------------------------------------------------------------

def test_link_review_to_gbp_does_not_erase_existing_reply():
    conn, loc_id = _fresh_conn()
    now = "2026-07-28T00:00:00Z"

    # This time the scraper DID capture a reply already.
    cur = conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, reviewer_name, review_date,
           star_rating, review_text, owner_response, first_seen_at, last_seen_at)
           VALUES (?, 'legacy-scraper-key-7', 'Sam Lee', '2026-05-10', 4,
           'Pretty good', 'Thanks for visiting!', ?, ?)""",
        (loc_id, now, now),
    )
    conn.commit()
    review_id = cur.lastrowid

    # The GBP import's row for this review has no reply text at all (e.g. a
    # partial/blank API field) -- must not blank out the scraper's capture.
    db.link_review_to_gbp(
        conn, review_id, "reviews/BLANKREPLY", "2026-05-11T00:00:00Z",
        gbp_reply_update_time=None, gbp_language_code="en", owner_response="",
    )
    conn.commit()

    linked = conn.execute("SELECT * FROM reviews WHERE id = ?", (review_id,)).fetchone()
    assert linked["owner_response"] == "Thanks for visiting!", (
        "a blank incoming owner_response must never erase an existing reply"
    )


# ---------------------------------------------------------------------------
# Case 8: a GBP reply timestamp with no reply comment is an anomaly, not a
# confirmed reply -- must not be silently marked replied or fabricated.
# ---------------------------------------------------------------------------

def test_reply_timestamp_without_comment_is_not_treated_as_replied():
    conn, loc_id = _fresh_conn()
    now = "2026-07-28T00:00:00Z"

    cur = conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, reviewer_name, review_date,
           star_rating, review_text, owner_response, first_seen_at, last_seen_at)
           VALUES (?, 'legacy-scraper-key-8', 'Jordan Ng', '2026-05-12', 2,
           'Meh', '', ?, ?)""",
        (loc_id, now, now),
    )
    conn.commit()
    review_id = cur.lastrowid

    # Google returned reviewReply.updateTime but an empty/missing comment --
    # exactly the anomaly shape.
    db.link_review_to_gbp(
        conn, review_id, "reviews/TIMEONLY", "2026-05-13T00:00:00Z",
        gbp_reply_update_time="2026-05-14T00:00:00Z", gbp_language_code="en", owner_response="",
    )
    conn.commit()

    linked = conn.execute("SELECT * FROM reviews WHERE id = ?", (review_id,)).fetchone()
    assert not (linked["owner_response"] or "").strip(), (
        "must not fabricate reply text -- owner_response must stay empty"
    )
    assert linked["gbp_reply_update_time"] == "2026-05-14T00:00:00Z", (
        "the timestamp must still be stored so the anomaly is detectable"
    )
    # This is exactly reconcile_gbp_replies.py's matching predicate.
    is_anomaly = linked["gbp_reply_update_time"] is not None and not (linked["owner_response"] or "").strip()
    assert is_anomaly, "row must match the reconciliation utility's anomaly predicate"


# ---------------------------------------------------------------------------
# Case 9: re-running the linking operation with the same data is idempotent.
# ---------------------------------------------------------------------------

def test_link_review_to_gbp_is_idempotent():
    conn, loc_id = _fresh_conn()
    now = "2026-07-28T00:00:00Z"

    cur = conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, reviewer_name, review_date,
           star_rating, review_text, owner_response, first_seen_at, last_seen_at)
           VALUES (?, 'legacy-scraper-key-9', 'Casey Wu', '2026-05-08', 5,
           'Great!', '', ?, ?)""",
        (loc_id, now, now),
    )
    conn.commit()
    review_id = cur.lastrowid

    args = (review_id, "reviews/IDEMPOTENT1", "2026-05-09T00:00:00Z", "2026-05-10T00:00:00Z", "en")
    db.link_review_to_gbp(conn, *args, owner_response="Thank you!")
    conn.commit()
    db.link_review_to_gbp(conn, *args, owner_response="Thank you!")
    conn.commit()

    assert _review_count(conn) == 1, "re-running the link must never insert a duplicate"
    linked = conn.execute("SELECT * FROM reviews WHERE id = ?", (review_id,)).fetchone()
    assert linked["owner_response"] == "Thank you!"
    assert linked["dedup_key"] == "reviews/IDEMPOTENT1"


def main():
    tests = [
        ("Case 1: historically linked row is updated, not duplicated", test_historically_linked_row_is_updated_not_duplicated),
        ("Case 2: new GBP review inserts with dedup_key == gbp_review_name", test_new_gbp_review_inserts_with_matching_dedup_key),
        ("Case 3: link_review_to_gbp() normalizes dedup_key atomically", test_link_review_to_gbp_normalizes_dedup_key_atomically),
        ("Case 4: repeated sync never duplicates", test_repeated_sync_never_duplicates),
        ("Case 5: unexpected collision surfaces with context, not swallowed", test_unexpected_collision_surfaces_with_context_not_swallowed),
        ("Case 6: GBP import linking preserves reply text (PRIMARY)", test_gbp_import_linking_preserves_reply_text),
        ("Case 7: existing reply is not erased by a blank incoming value", test_link_review_to_gbp_does_not_erase_existing_reply),
        ("Case 8: reply timestamp without comment is not treated as replied", test_reply_timestamp_without_comment_is_not_treated_as_replied),
        ("Case 9: link_review_to_gbp() is idempotent", test_link_review_to_gbp_is_idempotent),
    ]
    results = [_run(name, fn) for name, fn in tests]
    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
