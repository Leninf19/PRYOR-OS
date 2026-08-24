"""
Regression tests for gbp_reply_bridge_reconcile.py (Recovery Milestone 6B,
Part 7/9/11).

Covers: a bridge record whose review now has a real Google reply gets
reconciled into reviews.db (owner_response/gbp_reply_update_time) and its
Redis key deleted; a still-pending record is left untouched; a record whose
review already has owner_response locally (self-healed by the full sync)
just gets its now-redundant bridge record cleared without a spurious
Google call; a fetch failure leaves everything untouched; a malformed
record with no gbpReviewName is skipped; nothing outside these exact rows
is ever written; --dry-run performs zero writes/deletes while still
reporting what it would have done.

Every test uses a temporary, isolated SQLite DB -- never the real
dashboard/reviews.db. Redis and Google are always injected fakes -- no
test in this file ever makes a real network call.

Run directly: py tests/test_gbp_reply_bridge_reconcile.py
"""
import json
import sys
import tempfile
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import gbp_reply_bridge_reconcile as reconcile


def _fresh_db():
    tmpdir = tempfile.mkdtemp(prefix="test_bridge_reconcile_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    conn = db.get_connection()
    db.init_schema(conn)
    return conn


def _add_location(conn, name="Casa Tequila Testtown"):
    cur = conn.execute("INSERT INTO locations (name, city, brand) VALUES (?, 'Testtown', 'Casa Tequila')", (name,))
    conn.commit()
    return cur.lastrowid


def _add_review(conn, loc_id, gbp_review_name, owner_response="", reviewer_name="Jane Doe"):
    now = "2026-08-22T12:00:00Z"
    cur = conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, gbp_review_name, reviewer_name, review_date,
           star_rating, review_text, owner_response, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, '2026-08-07', 5, 'Great food', ?, ?, ?)""",
        (loc_id, gbp_review_name, gbp_review_name, reviewer_name, owner_response, now, now),
    )
    conn.commit()
    return cur.lastrowid


def _bridge_record(gbp_review_name="accounts/1/locations/2/reviews/abc", response_text="Thank you!"):
    return {
        "localReviewId": "r1", "gbpReviewName": gbp_review_name, "responseText": response_text,
        "publishedAt": "2026-08-22T13:45:00Z", "source": "future_insights",
        "status": "pending_google_reconciliation", "locationName": "Casa Tequila Testtown",
        "reviewerName": "Jane Doe", "reviewDate": "2026-08-07",
    }


def _run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        return True
    except AssertionError as e:
        print(f"FAIL: {name} -- {e}")
        return False


def test_confirmed_reply_reconciles_db_and_clears_bridge():
    conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id, "accounts/1/locations/2/reviews/abc")
    deleted = []

    def fake_fetch(name):
        return {"reviewReply": {"comment": "Thank you so much!", "updateTime": "2026-08-22T13:50:00Z"}}

    counts = reconcile.run_reconcile(
        conn, dry_run=False,
        list_keys=lambda: ["publish_bridge:v1:r1"],
        get_record=lambda k: _bridge_record(),
        fetch_review=fake_fetch,
        delete_record=lambda k: deleted.append(k),
    )
    row = conn.execute("SELECT owner_response, gbp_reply_update_time FROM reviews WHERE id = ?", (review_id,)).fetchone()
    assert counts["confirmed"] == 1, counts
    assert row["owner_response"] == "Thank you so much!", row["owner_response"]
    assert row["gbp_reply_update_time"] == "2026-08-22T13:50:00Z"
    assert deleted == ["publish_bridge:v1:r1"], deleted


def test_still_pending_leaves_row_and_bridge_untouched():
    conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id, "accounts/1/locations/2/reviews/abc")
    deleted = []

    counts = reconcile.run_reconcile(
        conn, dry_run=False,
        list_keys=lambda: ["publish_bridge:v1:r1"],
        get_record=lambda k: _bridge_record(),
        fetch_review=lambda name: {},  # no reviewReply at all
        delete_record=lambda k: deleted.append(k),
    )
    row = conn.execute("SELECT owner_response FROM reviews WHERE id = ?", (review_id,)).fetchone()
    assert counts["still_pending"] == 1, counts
    assert row["owner_response"] == "", row["owner_response"]
    assert deleted == [], deleted


def test_already_answered_locally_clears_stale_bridge_without_google_call():
    conn = _fresh_db()
    loc_id = _add_location(conn)
    _add_review(conn, loc_id, "accounts/1/locations/2/reviews/abc", owner_response="Already replied via full sync")
    deleted = []
    fetch_calls = []

    counts = reconcile.run_reconcile(
        conn, dry_run=False,
        list_keys=lambda: ["publish_bridge:v1:r1"],
        get_record=lambda k: _bridge_record(),
        fetch_review=lambda name: fetch_calls.append(name) or {},
        delete_record=lambda k: deleted.append(k),
    )
    assert counts["confirmed"] == 1, counts
    assert deleted == ["publish_bridge:v1:r1"], deleted
    assert fetch_calls == [], "must not call Google when reviews.db is already reconciled"


def test_fetch_failure_leaves_everything_untouched():
    conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id, "accounts/1/locations/2/reviews/abc")
    deleted = []

    def fake_fetch(name):
        raise RuntimeError("network error")

    counts = reconcile.run_reconcile(
        conn, dry_run=False,
        list_keys=lambda: ["publish_bridge:v1:r1"],
        get_record=lambda k: _bridge_record(),
        fetch_review=fake_fetch,
        delete_record=lambda k: deleted.append(k),
    )
    row = conn.execute("SELECT owner_response FROM reviews WHERE id = ?", (review_id,)).fetchone()
    assert counts["fetch_failed"] == 1, counts
    assert row["owner_response"] == ""
    assert deleted == []


def test_no_gbp_review_name_is_skipped_not_crashed():
    conn = _fresh_db()
    record = _bridge_record()
    record["gbpReviewName"] = None
    counts = reconcile.run_reconcile(
        conn, dry_run=False,
        list_keys=lambda: ["publish_bridge:v1:r1"],
        get_record=lambda k: record,
        fetch_review=lambda name: (_ for _ in ()).throw(AssertionError("must not be called")),
        delete_record=lambda k: (_ for _ in ()).throw(AssertionError("must not be called")),
    )
    assert counts["skipped_no_gbp_id"] == 1, counts


def test_review_not_found_locally_is_skipped_not_crashed():
    conn = _fresh_db()
    _add_location(conn)  # no matching review row at all
    counts = reconcile.run_reconcile(
        conn, dry_run=False,
        list_keys=lambda: ["publish_bridge:v1:r1"],
        get_record=lambda k: _bridge_record(gbp_review_name="accounts/1/locations/2/reviews/does-not-exist"),
        fetch_review=lambda name: (_ for _ in ()).throw(AssertionError("must not be called")),
        delete_record=lambda k: (_ for _ in ()).throw(AssertionError("must not be called")),
    )
    assert counts["skipped_not_found_locally"] == 1, counts


def test_dry_run_performs_zero_writes_or_deletes():
    conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id, "accounts/1/locations/2/reviews/abc")
    deleted = []

    counts = reconcile.run_reconcile(
        conn, dry_run=True,
        list_keys=lambda: ["publish_bridge:v1:r1"],
        get_record=lambda k: _bridge_record(),
        fetch_review=lambda name: {"reviewReply": {"comment": "Thank you!", "updateTime": "2026-08-22T13:50:00Z"}},
        delete_record=lambda k: deleted.append(k),
    )
    row = conn.execute("SELECT owner_response FROM reviews WHERE id = ?", (review_id,)).fetchone()
    assert counts["confirmed"] == 1, "dry-run should still REPORT what it would confirm"
    assert row["owner_response"] == "", "dry-run must never actually write"
    assert deleted == [], "dry-run must never actually delete the bridge record"


def test_only_the_matching_row_is_ever_touched():
    conn = _fresh_db()
    loc_id = _add_location(conn)
    target_id = _add_review(conn, loc_id, "accounts/1/locations/2/reviews/abc")
    other_id = _add_review(conn, loc_id, "accounts/1/locations/2/reviews/xyz", reviewer_name="Other Person")

    reconcile.run_reconcile(
        conn, dry_run=False,
        list_keys=lambda: ["publish_bridge:v1:r1"],
        get_record=lambda k: _bridge_record(gbp_review_name="accounts/1/locations/2/reviews/abc"),
        fetch_review=lambda name: {"reviewReply": {"comment": "Thanks!", "updateTime": "2026-08-22T13:50:00Z"}},
        delete_record=lambda k: None,
    )
    target = conn.execute("SELECT owner_response, review_text, star_rating FROM reviews WHERE id = ?", (target_id,)).fetchone()
    other = conn.execute("SELECT owner_response FROM reviews WHERE id = ?", (other_id,)).fetchone()
    assert target["owner_response"] == "Thanks!"
    assert target["review_text"] == "Great food", "must never touch review_text"
    assert target["star_rating"] == 5, "must never touch star_rating"
    assert other["owner_response"] == "", "must never touch an unrelated row"


# --- URL-encoding fix regression coverage -----------------------------------
#
# Production bug: get_bridge_record()/delete_bridge_record() used to
# interpolate the raw Redis key directly into an HTTP path segment
# (f"{base_url}/get/{key}"). Any key containing a space (the
# `${review_date}-${reviewer_name}` fallback id publishBridgeStore.js uses
# when a review has neither a canonical review_id nor a review_url --
# see dashboard/src/utils/dataUtils.js's reviewId()) crashed with
# `http.client.InvalidURL: URL can't contain control characters`, which
# aborted the whole critical-alert-check.yml run (its later "Verify database
# integrity"/"Commit updated data" steps never even ran on a failed run,
# since GitHub Actions steps after a failing one are skipped by default).
#
# Fix: urllib.parse.quote(key, safe='') applied ONLY at the point each HTTP
# path is built (get_bridge_record/delete_bridge_record) -- the logical key
# threaded through run_reconcile/reconcile_one (used for dict lookups, log
# lines, and as the dry-run/deleted-keys assertion value in the tests above)
# is never touched. list_bridge_keys()'s KEYS pattern is deliberately left
# UNencoded (see its own docstring) -- it's a glob pattern, not a specific
# key, and quoting the literal '*' would break the wildcard scan.
#
# FakeUpstash below mimics the real Upstash REST API's own behavior closely
# enough to catch a real encoding bug: it receives the (possibly encoded)
# last path segment exactly as the real service would, and looks up its
# store by the DECODED value -- so these tests prove the full round trip
# end-to-end (get_bridge_record()/delete_bridge_record() -> _redis_get() ->
# HTTP path -> decoded back to the exact original logical key), not just
# that quote() produces *a* valid URL.

SPECIAL_KEYS = [
    ("space", "publish_bridge:v1:2026-08-16-Chuck Spieser"),
    ("apostrophe", "publish_bridge:v1:2026-08-16-O'Brien"),
    ("ampersand", "publish_bridge:v1:2026-08-16-Smith & Sons"),
    ("forward slash", "publish_bridge:v1:https://maps.google.com/x/1"),
    ("plus sign", "publish_bridge:v1:2026-08-16-John+Doe"),
    ("percent sign", "publish_bridge:v1:2026-08-16-100%25 Great"),
    ("accented character", "publish_bridge:v1:2026-08-16-José Núñez"),
    ("unicode/non-Latin", "publish_bridge:v1:2026-08-16-田中太郎"),
]


class FakeUpstash:
    """A tiny in-memory stand-in for Upstash's REST API, keyed exactly the
    way the real service is: GET/DEL/KEYS all address a record by the
    DECODED value of the request path's last segment. Records the raw
    (possibly encoded) path of every call it receives, so a test can assert
    on what was actually sent over the wire, not just what quote() returns
    in isolation."""

    def __init__(self, initial=None):
        self.store = dict(initial or {})
        self.calls = []  # list of raw path strings, in order

    def handle(self, path, _token):
        self.calls.append(path)
        # path looks like "https://fake-upstash/<command>/<segment...>"
        after_host = path.split("://", 1)[1].split("/", 1)[1]
        command, _, encoded_segment = after_host.partition("/")
        if command == "get":
            key = urllib.parse.unquote(encoded_segment)
            value = self.store.get(key)
            return {"result": json.dumps(value) if value is not None else None}
        if command == "del":
            key = urllib.parse.unquote(encoded_segment)
            existed = key in self.store
            self.store.pop(key, None)
            return {"result": 1 if existed else 0}
        if command == "keys":
            # Only the fixed publish_bridge:v1:* pattern is ever used --
            # a real prefix+glob match, not exercised by these key-encoding
            # tests, but included so an accidental future KEYS-path bug
            # would still surface here rather than silently passing.
            prefix = encoded_segment.rstrip("*")
            return {"result": [k for k in self.store if k.startswith(prefix)]}
        raise AssertionError(f"unexpected command in fake Upstash path: {path}")


def _with_fake_upstash(store, fn):
    """Monkeypatches reconcile._redis_get for the duration of fn(), pointed
    at a fresh FakeUpstash seeded with `store`. Returns the FakeUpstash
    instance afterward so the test can inspect .calls/.store."""
    fake = FakeUpstash(store)
    original_redis_get = reconcile._redis_get
    original_base_url = reconcile._redis_base_url
    reconcile._redis_get = lambda path, token: fake.handle(path, token)
    reconcile._redis_base_url = lambda: ("https://fake-upstash", "fake-token")
    try:
        fn(fake)
    finally:
        reconcile._redis_get = original_redis_get
        reconcile._redis_base_url = original_base_url


def test_quote_key_round_trips_every_special_character_exactly():
    for label, key in SPECIAL_KEYS:
        encoded = reconcile._quote_key(key)
        assert " " not in encoded, f"{label}: encoded path must never contain a raw space -- {encoded!r}"
        assert urllib.parse.unquote(encoded) == key, f"{label}: round-trip must reproduce the exact original key"
    # A normal, all-ASCII key (the overwhelmingly common case) must still
    # round-trip exactly and produce a valid path segment -- NOT byte-
    # identical output, since ':' (present in every real key via the
    # "publish_bridge:v1:" prefix) is a reserved character quote(safe='')
    # correctly encodes too; get_bridge_record's own fake-Upstash tests
    # below already prove this round-trips correctly end-to-end in
    # production use, this just confirms the same for the prefix alone.
    plain = "publish_bridge:v1:r1"
    encoded_plain = reconcile._quote_key(plain)
    assert " " not in encoded_plain and ":" not in encoded_plain, f"a normal key's colons must be percent-encoded too (': ' is reserved, not unreserved) -- got {encoded_plain!r}"
    assert urllib.parse.unquote(encoded_plain) == plain, "a normal ASCII key must still round-trip to itself exactly"


def test_get_bridge_record_fetches_correctly_for_every_special_key():
    for label, key in SPECIAL_KEYS:
        record = {"gbpReviewName": "accounts/1/locations/2/reviews/x", "responseText": "hi"}

        def run(fake):
            result = reconcile.get_bridge_record(key)
            assert result == record, f"{label}: expected the exact stored record back, got {result}"
            assert " " not in fake.calls[-1], f"{label}: the raw HTTP path must never contain a literal space -- {fake.calls[-1]!r}"

        _with_fake_upstash({key: record}, run)


def test_delete_bridge_record_deletes_correctly_for_every_special_key():
    for label, key in SPECIAL_KEYS:
        def run(fake):
            reconcile.delete_bridge_record(key)
            assert key not in fake.store, f"{label}: the record must be gone from the store after delete"
            assert len(fake.store) == 0, f"{label}: delete must remove exactly the one matching record, no duplicate/stray key left ({fake.store!r})"

        _with_fake_upstash({key: {"x": 1}}, run)


def test_list_bridge_keys_pattern_is_sent_unencoded():
    def run(fake):
        reconcile.list_bridge_keys()
        sent_path = fake.calls[-1]
        assert sent_path.endswith("/keys/publish_bridge:v1:*"), f"the KEYS glob pattern must be sent with a literal, unencoded '*' and ':' -- got {sent_path!r}"

    _with_fake_upstash({}, run)


def test_full_reconcile_round_trip_with_a_space_containing_key_never_crashes():
    # The exact production scenario from the bug report: a bridge record
    # whose key is the date+reviewer-name fallback (no review_id/review_url
    # available), run through the REAL get_bridge_record/delete_bridge_record
    # (not the lambda-injected fakes the earlier tests in this file use) --
    # this is what actually failed in production before the fix.
    conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id, "accounts/1/locations/2/reviews/abc")
    key = "publish_bridge:v1:2026-08-16-Chuck Spieser"
    record = _bridge_record(gbp_review_name="accounts/1/locations/2/reviews/abc")

    def run(fake):
        counts = reconcile.run_reconcile(
            conn, dry_run=False,
            list_keys=lambda: [key],
            get_record=reconcile.get_bridge_record,  # the REAL function, not a lambda fake
            fetch_review=lambda name: {"reviewReply": {"comment": "Thanks!", "updateTime": "2026-08-22T13:50:00Z"}},
            delete_record=reconcile.delete_bridge_record,  # the REAL function, not a lambda fake
        )
        assert counts["confirmed"] == 1, counts
        row = conn.execute("SELECT owner_response FROM reviews WHERE id = ?", (review_id,)).fetchone()
        assert row["owner_response"] == "Thanks!", "the review must be reconciled correctly despite the key's space"
        assert key not in fake.store, "the space-containing key must be deleted from the store, not left behind"
        assert len(fake.store) == 0, "no duplicate bridge record must be created under a mangled/different key"

    _with_fake_upstash({key: record}, run)


def main() -> int:
    tests = [
        ("confirmed reply reconciles reviews.db and clears the bridge", test_confirmed_reply_reconciles_db_and_clears_bridge),
        ("still-pending record leaves the row and bridge untouched", test_still_pending_leaves_row_and_bridge_untouched),
        ("already-answered locally clears a stale bridge without calling Google", test_already_answered_locally_clears_stale_bridge_without_google_call),
        ("a fetch failure leaves everything untouched", test_fetch_failure_leaves_everything_untouched),
        ("a record with no gbpReviewName is skipped, not crashed", test_no_gbp_review_name_is_skipped_not_crashed),
        ("a review not found locally is skipped, not crashed", test_review_not_found_locally_is_skipped_not_crashed),
        ("--dry-run performs zero writes or deletes", test_dry_run_performs_zero_writes_or_deletes),
        ("only the exact matching row is ever touched", test_only_the_matching_row_is_ever_touched),
        ("_quote_key round-trips every special character exactly (space/apostrophe/&//,+,%,accented,unicode)", test_quote_key_round_trips_every_special_character_exactly),
        ("get_bridge_record fetches correctly for every special-character key", test_get_bridge_record_fetches_correctly_for_every_special_key),
        ("delete_bridge_record deletes correctly for every special-character key, no duplicate left behind", test_delete_bridge_record_deletes_correctly_for_every_special_key),
        ("list_bridge_keys' KEYS glob pattern is sent unencoded (never quoted)", test_list_bridge_keys_pattern_is_sent_unencoded),
        ("full reconcile round-trip with a space-containing key never crashes (the exact production bug)", test_full_reconcile_round_trip_with_a_space_containing_key_never_crashes),
    ]
    results = [_run(name, fn) for name, fn in tests]
    passed = sum(results)
    print(f"\n{passed}/{len(results)} tests passed" if passed == len(results) else f"\n{len(results) - passed} of {len(results)} TESTS FAILED")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
