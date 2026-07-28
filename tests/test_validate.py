"""
Regression tests for validate.py's flag lifecycle.

Reproduces the production bloat incident (2026-07-28): every run of
validate.py resolved every currently-open flag of its own check types and
then unconditionally re-inserted a fresh row for every review still failing
a check -- so a single, permanently-true condition (e.g. a star-rating-only
review with no text, a completely normal and legitimate state) accumulated
one new row every single pipeline run, forever, with no deduplication.
validation_flags grew to 575,864 rows (56.6 MiB, 57% of the committed
database) this way, almost entirely resolved-but-never-deleted duplicates
of the same handful of persisting conditions.

The fixed model: a validation run diffs the currently-detected problems
against the previously OPEN flags (identity = review_id, location_id,
flag_type -- confirmed via every insert_flag() call site, and confirmed via
notify.py/export_chunks.py that nothing anywhere reads resolved-flag
history, only currently-open flags). A persisting problem leaves its
existing open flag untouched. A cleared problem gets marked resolved. A
problem that returns after being resolved gets a genuinely new row.

Every test uses a temporary, isolated SQLite DB -- never the real
dashboard/reviews.db.

Run directly: py tests/test_validate.py
"""
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import validate


def _fresh_conn():
    tmpdir = tempfile.mkdtemp(prefix="test_validate_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    conn = db.get_connection()
    db.init_schema(conn)
    return conn


def _add_location(conn, name="Casa Tequila Testtown", brand="Casa Tequila", city="Testtown"):
    cur = conn.execute("INSERT INTO locations (name, city, brand) VALUES (?, ?, ?)", (name, city, brand))
    conn.commit()
    return cur.lastrowid


def _add_review(conn, loc_id, review_text="", reviewer_name="Jane Doe", star_rating=5,
                 review_date="2026-06-01", review_url="https://example.com/review"):
    # review_url defaults to non-empty specifically so tests targeting one
    # check (e.g. missing_text) don't also incidentally trigger missing_url
    # on the same review -- pass review_url="" explicitly if a test wants
    # that condition too.
    now = "2026-07-28T00:00:00Z"
    key = f"key-{reviewer_name}-{review_date}-{star_rating}-{review_text[:10]}-{review_url}"
    cur = conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, reviewer_name, review_date, star_rating,
           review_text, review_url, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (loc_id, key, reviewer_name, review_date, star_rating, review_text, review_url, now, now),
    )
    conn.commit()
    return cur.lastrowid


def _open_flags(conn, review_id=None, location_id=None, flag_type=None):
    q = "SELECT * FROM validation_flags WHERE resolved_at IS NULL"
    params = []
    if review_id is not None:
        q += " AND review_id = ?"
        params.append(review_id)
    if location_id is not None:
        q += " AND location_id = ?"
        params.append(location_id)
    if flag_type is not None:
        q += " AND flag_type = ?"
        params.append(flag_type)
    return conn.execute(q, params).fetchall()


def _all_flags(conn, review_id=None):
    q = "SELECT * FROM validation_flags"
    params = []
    if review_id is not None:
        q += " WHERE review_id = ?"
        params.append(review_id)
    return conn.execute(q, params).fetchall()


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
# Case: repeated validation must not grow open-flag count after the first run
# ---------------------------------------------------------------------------

def test_repeated_validation_does_not_grow_open_flags():
    conn = _fresh_conn()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id, review_text="")  # missing_text, permanently

    validate.run(conn)
    after_first = _open_flags(conn, review_id=review_id, flag_type="missing_text")
    assert len(after_first) == 1, f"expected exactly 1 open flag after first run, got {len(after_first)}"

    for _ in range(5):
        validate.run(conn)

    after_many = _open_flags(conn, review_id=review_id, flag_type="missing_text")
    assert len(after_many) == 1, (
        f"open flag count grew after repeated validation runs: {len(after_many)} "
        f"(this is the exact production bloat bug)"
    )
    all_rows = _all_flags(conn, review_id=review_id)
    assert len(all_rows) == 1, f"total flag rows for this review grew to {len(all_rows)} across repeated runs"


# ---------------------------------------------------------------------------
# Case: resolution -- fixing the underlying issue must resolve the flag
# ---------------------------------------------------------------------------

def test_fixed_issue_resolves_the_flag():
    conn = _fresh_conn()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id, review_text="")

    validate.run(conn)
    assert len(_open_flags(conn, review_id=review_id, flag_type="missing_text")) == 1

    conn.execute("UPDATE reviews SET review_text = 'Now has real text' WHERE id = ?", (review_id,))
    conn.commit()

    validate.run(conn)
    open_after_fix = _open_flags(conn, review_id=review_id, flag_type="missing_text")
    assert len(open_after_fix) == 0, "flag remained open after the underlying issue was fixed"

    resolved = conn.execute(
        "SELECT * FROM validation_flags WHERE review_id = ? AND flag_type = 'missing_text' AND resolved_at IS NOT NULL",
        (review_id,),
    ).fetchall()
    assert len(resolved) == 1, "the original flag should be marked resolved, not deleted or left open"


# ---------------------------------------------------------------------------
# Case: recurrence -- the same problem returning after resolution must create
# a genuinely new flag occurrence, not be permanently suppressed.
# ---------------------------------------------------------------------------

def test_recurrence_after_resolution_creates_new_flag():
    conn = _fresh_conn()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id, review_text="")

    validate.run(conn)  # flags missing_text
    conn.execute("UPDATE reviews SET review_text = 'temporarily fixed' WHERE id = ?", (review_id,))
    conn.commit()
    validate.run(conn)  # resolves it
    assert len(_open_flags(conn, review_id=review_id, flag_type="missing_text")) == 0

    conn.execute("UPDATE reviews SET review_text = '' WHERE id = ?", (review_id,))
    conn.commit()
    validate.run(conn)  # the problem is back

    open_now = _open_flags(conn, review_id=review_id, flag_type="missing_text")
    assert len(open_now) == 1, "recurrence must create a new open flag, not stay permanently suppressed"

    all_rows = _all_flags(conn, review_id=review_id)
    assert len(all_rows) == 2, (
        f"expected 2 total rows (1 resolved incident + 1 new open incident), got {len(all_rows)}"
    )
    ids = sorted(r["id"] for r in all_rows)
    assert ids[0] != ids[1], "the recurrence must be a distinct row, not the same one reopened"


# ---------------------------------------------------------------------------
# Case: isolation -- same type on different reviews, and different types on
# the same review, must never interfere with each other.
# ---------------------------------------------------------------------------

def test_isolation_across_reviews_and_flag_types():
    conn = _fresh_conn()
    loc_id = _add_location(conn)
    review_a = _add_review(conn, loc_id, review_text="", reviewer_name="Alice")
    review_b = _add_review(conn, loc_id, review_text="", reviewer_name="Bob")

    validate.run(conn)
    assert len(_open_flags(conn, review_id=review_a, flag_type="missing_text")) == 1
    assert len(_open_flags(conn, review_id=review_b, flag_type="missing_text")) == 1

    conn.execute("UPDATE reviews SET review_text = 'fixed' WHERE id = ?", (review_a,))
    conn.commit()
    validate.run(conn)

    assert len(_open_flags(conn, review_id=review_a, flag_type="missing_text")) == 0, (
        "resolving review A's issue must not be affected by review B's still-open one"
    )
    assert len(_open_flags(conn, review_id=review_b, flag_type="missing_text")) == 1, (
        "review B's flag must be untouched by review A's resolution"
    )

    # Different flag types on the SAME review.
    conn2 = _fresh_conn()
    loc2 = _add_location(conn2)
    review_c = _add_review(conn2, loc2, review_text="", reviewer_name="Carol", star_rating=0)
    validate.run(conn2)
    assert len(_open_flags(conn2, review_id=review_c, flag_type="missing_text")) == 1
    assert len(_open_flags(conn2, review_id=review_c, flag_type="bad_star_rating")) == 1

    conn2.execute("UPDATE reviews SET review_text = 'now has text' WHERE id = ?", (review_c,))
    conn2.commit()
    validate.run(conn2)
    assert len(_open_flags(conn2, review_id=review_c, flag_type="missing_text")) == 0
    assert len(_open_flags(conn2, review_id=review_c, flag_type="bad_star_rating")) == 1, (
        "resolving missing_text must not resolve the unrelated bad_star_rating flag on the same review"
    )


# ---------------------------------------------------------------------------
# Case: existing duplicates -- the new logic must behave predictably (and
# self-heal) when the database already contains more than one simultaneously
# OPEN row for the same identity, a pre-existing anomaly from before this fix.
# ---------------------------------------------------------------------------

def test_preexisting_duplicate_open_flags_self_heal():
    conn = _fresh_conn()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id, review_text="")
    now = "2026-07-01T00:00:00Z"

    # Simulate a pre-existing anomaly from before this fix shipped: two
    # simultaneously open rows for the identical identity. The defense-in-
    # depth partial unique index (schema v18) would itself prevent this from
    # ever being newly created going forward -- dropped here only to
    # reconstruct the historical pre-migration state this test targets. The
    # actual invariant under test is validate.py's own application-level
    # self-healing, which does not depend on the index at all.
    conn.execute("DROP INDEX IF EXISTS idx_validation_flags_open_identity")
    conn.execute(
        "INSERT INTO validation_flags (review_id, location_id, flag_type, detail, detected_at) "
        "VALUES (?, ?, 'missing_text', NULL, ?)",
        (review_id, loc_id, now),
    )
    conn.execute(
        "INSERT INTO validation_flags (review_id, location_id, flag_type, detail, detected_at) "
        "VALUES (?, ?, 'missing_text', NULL, ?)",
        (review_id, loc_id, now),
    )
    conn.commit()
    assert len(_open_flags(conn, review_id=review_id, flag_type="missing_text")) == 2

    validate.run(conn)

    open_after = _open_flags(conn, review_id=review_id, flag_type="missing_text")
    assert len(open_after) == 1, (
        f"pre-existing duplicate open flags must self-heal down to exactly one, got {len(open_after)}"
    )

    # The partial unique index was dropped above to construct the anomaly,
    # and db.init_schema() was never called again in this test until now --
    # so validate.run() itself must be what re-creates it once self-healing
    # has actually cleared the violation (not just leave it missing).
    idx = conn.execute(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_validation_flags_open_identity'"
    ).fetchone()
    assert idx is not None, "the defense-in-depth index must be (re)created once self-healing clears the violation"
    assert "COALESCE(review_id, 0)" in idx["sql"] and "location_id" in idx["sql"] and "flag_type" in idx["sql"]

    try:
        conn.execute(
            "INSERT INTO validation_flags (review_id, location_id, flag_type, detail, detected_at) "
            "VALUES (?, ?, 'missing_text', NULL, ?)",
            (review_id, loc_id, now),
        )
        conn.commit()
        assert False, "a duplicate open flag must be rejected now that the index has been recreated"
    except sqlite3.IntegrityError:
        conn.rollback()


# ---------------------------------------------------------------------------
# Case: if self-healing somehow fails to clear a duplicate-open-flag
# violation, validate.run() must raise loudly rather than silently leaving
# the defense-in-depth index unenforced.
# ---------------------------------------------------------------------------

def test_run_raises_if_index_still_blocked_after_self_heal():
    conn = _fresh_conn()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id, review_text="")
    now = "2026-07-01T00:00:00Z"

    conn.execute("DROP INDEX IF EXISTS idx_validation_flags_open_identity")
    for _ in range(2):
        conn.execute(
            "INSERT INTO validation_flags (review_id, location_id, flag_type, detail, detected_at) "
            "VALUES (?, ?, 'missing_text', NULL, ?)",
            (review_id, loc_id, now),
        )
    conn.commit()

    # Force self-healing to do nothing, simulating a bug in it, so the
    # duplicate survives the run and the post-heal index re-check is still
    # blocked -- proving the raise path is real and reachable, not
    # theoretical.
    real_get_open_flags = validate.get_open_flags
    validate.get_open_flags = lambda c: {}
    try:
        raised = False
        try:
            validate.run(conn)
        except RuntimeError:
            raised = True
        assert raised, (
            "validate.run() must raise RuntimeError when the defense-in-depth index "
            "still cannot be created after self-healing has (supposedly) run"
        )
    finally:
        validate.get_open_flags = real_get_open_flags


def main():
    tests = [
        ("Repeated validation does not grow open-flag count", test_repeated_validation_does_not_grow_open_flags),
        ("A fixed issue resolves the flag", test_fixed_issue_resolves_the_flag),
        ("Recurrence after resolution creates a new flag", test_recurrence_after_resolution_creates_new_flag),
        ("Isolation across reviews and flag types", test_isolation_across_reviews_and_flag_types),
        ("Pre-existing duplicate open flags self-heal", test_preexisting_duplicate_open_flags_self_heal),
        ("run() raises if the index is still blocked after self-heal", test_run_raises_if_index_still_blocked_after_self_heal),
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
