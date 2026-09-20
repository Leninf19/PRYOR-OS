"""
Regression tests for the Review Media Feature's authoritative no-backfill
gate (db.upsert_review()'s media_capture_started_at parameter) -- Scale &
No-Backfill Audit, Phase 10. Every test uses a temporary, isolated SQLite
DB -- never the real dashboard/reviews.db -- and no test ever activates a
real tenant or touches Redis with real credentials.

Run directly: py tests/test_review_media_feature.py
"""
import json
import sys
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import provider_gbp
import provider_sync
import tenant_config_store

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def _fresh_conn(prefix="test_review_media_"):
    tmpdir = tempfile.mkdtemp(prefix=prefix)
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    conn = db.get_connection()
    db.init_schema(conn)
    cur = conn.execute(
        "INSERT INTO locations (name, city, brand) VALUES ('Casa Tequila Testtown', 'Testtown', 'Casa Tequila')"
    )
    conn.commit()
    return conn, cur.lastrowid


def _base_row(**overrides):
    row = {
        "reviewer_name": "Synthetic Reviewer", "review_date": "2026-09-20", "star_rating": 5,
        "review_text": "Amazing food", "owner_response": "", "review_url": "",
        "gbp_review_name": "accounts/1/locations/2/reviews/synthetic-abc123",
        "gbp_update_time": "2026-09-20T14:38:16Z",
        "gbp_create_time": "2026-09-20T14:38:16Z",
        "media": [{"thumbnailUrl": "https://lh3.googleusercontent.com/p1", "thumbnailLabel": "Tacos"}],
    }
    row.update(overrides)
    return row


def _stored_media(conn, gbp_review_name):
    r = conn.execute("SELECT gbp_review_media FROM reviews WHERE gbp_review_name = ?", (gbp_review_name,)).fetchone()
    return r["gbp_review_media"]


ACTIVE = "2026-09-01T00:00:00Z"


# --- 1-4: activation-side failure modes -------------------------------------

def test_1_missing_tenant_media_capture_stores_nothing():
    conn, loc_id = _fresh_conn()
    row = _base_row()
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-20T15:00:00Z", media_capture_started_at=None)
    assert _stored_media(conn, row["gbp_review_name"]) is None


def test_2_inactive_media_capture_stores_nothing():
    # "Inactive" is represented identically to "missing" at this layer --
    # the caller (sync orchestration) is what resolves inactive -> None.
    conn, loc_id = _fresh_conn()
    row = _base_row()
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-20T15:00:00Z", media_capture_started_at=None)
    assert _stored_media(conn, row["gbp_review_name"]) is None


def test_3_missing_started_at_stores_nothing():
    conn, loc_id = _fresh_conn()
    row = _base_row()
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-20T15:00:00Z", media_capture_started_at="")
    assert _stored_media(conn, row["gbp_review_name"]) is None


def test_4_invalid_started_at_stores_nothing():
    conn, loc_id = _fresh_conn()
    row = _base_row()
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-20T15:00:00Z", media_capture_started_at="not-a-real-timestamp")
    assert _stored_media(conn, row["gbp_review_name"]) is None


# --- 5-8: createTime vs activation instant -----------------------------------

def test_5_valid_activation_stores_media():
    conn, loc_id = _fresh_conn()
    row = _base_row(gbp_create_time="2026-09-20T14:38:16Z")
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-20T15:00:00Z", media_capture_started_at=ACTIVE)
    stored = json.loads(_stored_media(conn, row["gbp_review_name"]))
    assert len(stored) == 1


def test_6_create_time_before_activation_stores_nothing():
    conn, loc_id = _fresh_conn()
    row = _base_row(gbp_create_time="2026-08-31T23:59:59Z")
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-20T15:00:00Z", media_capture_started_at=ACTIVE)
    assert _stored_media(conn, row["gbp_review_name"]) is None


def test_7_create_time_equal_to_activation_stores_media():
    conn, loc_id = _fresh_conn()
    row = _base_row(gbp_create_time=ACTIVE)
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-20T15:00:00Z", media_capture_started_at=ACTIVE)
    assert _stored_media(conn, row["gbp_review_name"]) is not None
    assert json.loads(_stored_media(conn, row["gbp_review_name"]))


def test_8_create_time_after_activation_stores_media():
    conn, loc_id = _fresh_conn()
    row = _base_row(gbp_create_time="2026-09-21T00:00:00Z")
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-20T15:00:00Z", media_capture_started_at=ACTIVE)
    assert json.loads(_stored_media(conn, row["gbp_review_name"]))


# --- 9-10: edits never change eligibility either direction -------------------

def test_9_old_review_updated_after_activation_remains_ineligible():
    conn, loc_id = _fresh_conn()
    old_create_time = "2026-01-01T00:00:00Z"
    row1 = _base_row(gbp_create_time=old_create_time, gbp_update_time="2026-01-01T00:00:00Z")
    # First sync, before the tenant ever activates -- nothing stored.
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row1, "2026-01-01T00:00:01Z", media_capture_started_at=None)
    assert _stored_media(conn, row1["gbp_review_name"]) is None

    # Tenant activates. A later sync re-fetches this SAME old review (Google
    # never changes createTime on an edit) with a NEW updateTime/edited text.
    row2 = _base_row(
        gbp_create_time=old_create_time, gbp_update_time="2026-09-20T12:00:00Z",
        review_text="Edited text after activation",
    )
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row2, "2026-09-20T15:00:00Z", media_capture_started_at=ACTIVE)
    assert _stored_media(conn, row2["gbp_review_name"]) is None, "an old review must remain ineligible even when edited after activation"


def test_10_eligible_review_edited_later_remains_eligible():
    conn, loc_id = _fresh_conn()
    create_time = "2026-09-25T00:00:00Z"
    row1 = _base_row(gbp_create_time=create_time, gbp_update_time="2026-09-25T00:00:00Z")
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row1, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    assert json.loads(_stored_media(conn, row1["gbp_review_name"]))

    row2 = _base_row(
        gbp_create_time=create_time, gbp_update_time="2026-09-26T00:00:00Z",
        review_text="Edited text, still eligible",
        media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/new-photo"}],
    )
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row2, "2026-09-26T00:00:01Z", media_capture_started_at=ACTIVE)
    stored = json.loads(_stored_media(conn, row2["gbp_review_name"]))
    assert stored[0]["thumbnailUrl"] == "https://lh3.googleusercontent.com/new-photo"


# --- 11-12: default-omitted callers fail closed ------------------------------

def test_11_direct_upsert_with_media_but_no_activation_stores_nothing():
    conn, loc_id = _fresh_conn()
    row = _base_row(gbp_create_time="2026-09-25T00:00:00Z")
    # No media_capture_started_at kwarg at all -- exercises the SAFE DEFAULT.
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z")
    assert _stored_media(conn, row["gbp_review_name"]) is None


def test_12_import_repair_path_omitting_activation_fails_closed():
    # Simulates a hypothetical future import/repair script that calls
    # upsert_review() with the classic 5-positional-argument call shape
    # (exactly like gbp_import.py / repair_review_identity.py's existing
    # call sites) -- never supplying the new keyword at all.
    conn, loc_id = _fresh_conn()
    row = _base_row(gbp_create_time="2026-09-25T00:00:00Z")
    result = db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z")
    assert result == "new"
    assert _stored_media(conn, row["gbp_review_name"]) is None


# --- 13-16: media shape variety flows through the real gate ------------------

def test_13_one_photo_end_to_end():
    conn, loc_id = _fresh_conn()
    row = _base_row(gbp_create_time="2026-09-25T00:00:00Z", media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/p1"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    stored = json.loads(_stored_media(conn, row["gbp_review_name"]))
    assert len(stored) == 1 and stored[0]["type"] == "photo"


def test_14_five_photos_end_to_end():
    conn, loc_id = _fresh_conn()
    media = [{"thumbnailUrl": f"https://lh3.googleusercontent.com/p{i}"} for i in range(5)]
    row = _base_row(gbp_create_time="2026-09-25T00:00:00Z", media=media)
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    stored = json.loads(_stored_media(conn, row["gbp_review_name"]))
    assert len(stored) == 5


def test_15_video_end_to_end():
    conn, loc_id = _fresh_conn()
    row = _base_row(gbp_create_time="2026-09-25T00:00:00Z", media=[
        {"thumbnailUrl": "https://lh3.googleusercontent.com/vthumb", "videoUrl": "https://lh3.googleusercontent.com/v1"},
    ])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    stored = json.loads(_stored_media(conn, row["gbp_review_name"]))
    assert stored[0]["type"] == "video"


def test_16_mixed_media_end_to_end():
    conn, loc_id = _fresh_conn()
    row = _base_row(gbp_create_time="2026-09-25T00:00:00Z", media=[
        {"thumbnailUrl": "https://lh3.googleusercontent.com/p1"},
        {"thumbnailUrl": "https://lh3.googleusercontent.com/vthumb", "videoUrl": "https://lh3.googleusercontent.com/v1"},
    ])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    stored = json.loads(_stored_media(conn, row["gbp_review_name"]))
    assert [s["type"] for s in stored] == ["photo", "video"]


def test_17_duplicate_items_end_to_end():
    conn, loc_id = _fresh_conn()
    row = _base_row(gbp_create_time="2026-09-25T00:00:00Z", media=[
        {"thumbnailUrl": "https://lh3.googleusercontent.com/dup"},
        {"thumbnailUrl": "https://lh3.googleusercontent.com/dup"},
    ])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    stored = json.loads(_stored_media(conn, row["gbp_review_name"]))
    assert len(stored) == 1


def test_18_more_than_20_items_end_to_end():
    conn, loc_id = _fresh_conn()
    media = [{"thumbnailUrl": f"https://lh3.googleusercontent.com/p{i}"} for i in range(30)]
    row = _base_row(gbp_create_time="2026-09-25T00:00:00Z", media=media)
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    stored = json.loads(_stored_media(conn, row["gbp_review_name"]))
    assert len(stored) == 20


def test_19_url_over_2048_chars_end_to_end():
    conn, loc_id = _fresh_conn()
    huge = "https://lh3.googleusercontent.com/" + ("a" * 3000)
    row = _base_row(gbp_create_time="2026-09-25T00:00:00Z", media=[{"thumbnailUrl": huge}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    stored = json.loads(_stored_media(conn, row["gbp_review_name"]))
    assert stored == []


def test_20_unsafe_scheme_urls_end_to_end():
    conn, loc_id = _fresh_conn()
    for scheme_url in ["javascript:alert(1)", "data:image/png;base64,AA", "file:///etc/passwd", "http://lh3.googleusercontent.com/insecure"]:
        conn2, loc_id2 = _fresh_conn()
        row = _base_row(gbp_create_time="2026-09-25T00:00:00Z", media=[{"thumbnailUrl": scheme_url}],
                         gbp_review_name=f"accounts/1/locations/2/reviews/{hash(scheme_url)}")
        db.upsert_review(conn2, loc_id2, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
        stored = json.loads(_stored_media(conn2, row["gbp_review_name"]))
        assert stored == [], f"{scheme_url!r} must be rejected"


def test_21_credential_bearing_url_end_to_end():
    conn, loc_id = _fresh_conn()
    row = _base_row(gbp_create_time="2026-09-25T00:00:00Z", media=[{"thumbnailUrl": "https://user:pass@lh3.googleusercontent.com/p1"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    stored = json.loads(_stored_media(conn, row["gbp_review_name"]))
    assert stored == []


def test_22_label_over_200_chars_end_to_end():
    conn, loc_id = _fresh_conn()
    row = _base_row(gbp_create_time="2026-09-25T00:00:00Z", media=[
        {"thumbnailUrl": "https://lh3.googleusercontent.com/p1", "thumbnailLabel": "x" * 500},
    ])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    stored = json.loads(_stored_media(conn, row["gbp_review_name"]))
    assert len(stored[0]["thumbnailLabel"]) == 200


def test_23_serialized_result_over_8kb_end_to_end():
    conn, loc_id = _fresh_conn()
    media = [{"thumbnailUrl": f"https://lh3.googleusercontent.com/{'p' * 400}{i}"} for i in range(20)]
    row = _base_row(gbp_create_time="2026-09-25T00:00:00Z", media=media)
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    stored_raw = _stored_media(conn, row["gbp_review_name"])
    assert len(stored_raw.encode("utf-8")) <= 8192


def test_24_media_removal_from_eligible_review():
    conn, loc_id = _fresh_conn()
    create_time = "2026-09-25T00:00:00Z"
    row1 = _base_row(gbp_create_time=create_time, media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/p1"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row1, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    assert json.loads(_stored_media(conn, row1["gbp_review_name"]))
    row2 = _base_row(gbp_create_time=create_time, gbp_update_time="2026-09-26T00:00:00Z", media=[])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row2, "2026-09-26T00:00:01Z", media_capture_started_at=ACTIVE)
    assert json.loads(_stored_media(conn, row2["gbp_review_name"])) == []


def test_25_no_fake_owner_response_revision_from_media_only_change():
    conn, loc_id = _fresh_conn()
    create_time = "2026-09-25T00:00:00Z"
    row1 = _base_row(gbp_create_time=create_time, media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/p1"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row1, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    review_id = conn.execute("SELECT id FROM reviews WHERE gbp_review_name = ?", (row1["gbp_review_name"],)).fetchone()["id"]

    # Same text/rating/owner_response, DIFFERENT media only.
    row2 = _base_row(gbp_create_time=create_time, gbp_update_time="2026-09-26T00:00:00Z",
                      media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/p2"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row2, "2026-09-26T00:00:01Z", media_capture_started_at=ACTIVE)

    revisions = conn.execute("SELECT field_changed FROM review_revisions WHERE review_id = ?", (review_id,)).fetchall()
    fields_changed = {r["field_changed"] for r in revisions}
    assert "gbp_review_media" not in fields_changed
    assert fields_changed == set()  # text/rating/owner_response were all identical -- zero revisions


def test_26_legacy_row_with_null_media_readable():
    conn, loc_id = _fresh_conn()
    # Simulates a row inserted before this feature existed -- gbp_review_media
    # was never even in the INSERT statement.
    now = "2026-01-01T00:00:00Z"
    conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, reviewer_name, review_date, star_rating,
           review_text, owner_response, review_url, first_seen_at, last_seen_at)
           VALUES (?, 'legacy-key-1', 'Old Reviewer', '2025-01-01', 4, 'Fine', '', '', ?, ?)""",
        (loc_id, now, now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM reviews WHERE dedup_key = 'legacy-key-1'").fetchone()
    assert row["gbp_review_media"] is None


def test_27_tenant_isolation_separate_databases():
    conn_a, loc_a = _fresh_conn(prefix="test_tenant_a_")
    conn_b, loc_b = _fresh_conn(prefix="test_tenant_b_")
    row_a = _base_row(gbp_create_time="2026-09-25T00:00:00Z", gbp_review_name="accounts/1/locations/2/reviews/tenant-a-review")
    row_b = _base_row(gbp_create_time="2026-09-25T00:00:00Z", gbp_review_name="accounts/1/locations/2/reviews/tenant-b-review",
                       media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/tenant-b-photo"}])
    db.upsert_review(conn_a, loc_a, "Casa Tequila Testtown", row_a, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    db.upsert_review(conn_b, loc_b, "Casa Tequila Testtown", row_b, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    # Tenant A's own database has no knowledge of tenant B's review at all.
    assert conn_a.execute("SELECT COUNT(*) c FROM reviews WHERE gbp_review_name LIKE '%tenant-b%'").fetchone()["c"] == 0
    assert conn_b.execute("SELECT COUNT(*) c FROM reviews WHERE gbp_review_name LIKE '%tenant-a%'").fetchone()["c"] == 0


def test_28_config_lookup_failure_fails_closed_in_sync_orchestration():
    import asyncio
    import os
    from provider_mock import MockProvider

    _fresh_conn()
    # Ensure no UPSTASH_REDIS_REST_URL/TOKEN are configured in this test
    # process -- tenant_config_store.resolve_media_capture_started_at() will
    # then raise TenantConfigStoreUnavailableError; provider_sync.sync_all()
    # must continue the review sync anyway, with media capture disabled,
    # rather than letting a config-store outage block the sync itself.
    env_backup = {k: os.environ.pop(k, None) for k in ("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN")}
    try:
        provider = MockProvider()
        result = asyncio.run(provider_sync.sync_all(provider, fast=False, tenant_id="t_synthetic-config-outage"))
        assert result["status"] in ("ok", "partial"), (
            f"a tenant_config lookup failure must never block the underlying review sync, got status={result['status']!r}"
        )
    finally:
        for k, v in env_backup.items():
            if v is not None:
                os.environ[k] = v


def test_29_no_additional_google_api_call_from_media_processing():
    def poison(*a, **k):
        raise AssertionError("no HTTP request should be made while sanitizing/converting media")

    original = urllib.request.urlopen
    urllib.request.urlopen = poison
    try:
        api_review = {
            "reviewer": {"displayName": "Synthetic Reviewer"}, "createTime": "2026-09-20T14:38:16Z",
            "comment": "Great!", "starRating": "FIVE", "name": "accounts/1/locations/2/reviews/abc",
            "reviewMediaItems": [
                {"thumbnailUrl": "https://lh3.googleusercontent.com/p1"},
                {"thumbnailUrl": "https://lh3.googleusercontent.com/p2", "videoUrl": "https://lh3.googleusercontent.com/v2"},
            ],
        }
        preview = provider_gbp.GBPProvider._to_provider_review(api_review)
        assert preview.media is not None
        assert preview.gbp_create_time == "2026-09-20T14:38:16Z"
    finally:
        urllib.request.urlopen = original


def test_30_no_media_url_fetch_from_media_processing():
    # Same poisoned-network guarantee, exercised via the sanitizer directly
    # with a large, realistic multi-item payload.
    def poison(*a, **k):
        raise AssertionError("no HTTP request should be made while sanitizing media URLs")

    original = urllib.request.urlopen
    urllib.request.urlopen = poison
    try:
        conn, loc_id = _fresh_conn()
        row = _base_row(gbp_create_time="2026-09-25T00:00:00Z", media=[
            {"thumbnailUrl": "https://lh3.googleusercontent.com/p1"},
            {"thumbnailUrl": "https://lh3.googleusercontent.com/p2", "videoUrl": "https://lh3.googleusercontent.com/v2"},
        ])
        db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    finally:
        urllib.request.urlopen = original


def test_31_activation_helper_never_called_by_deploy_onboarding_or_sync():
    source_files = [
        "initial_sync.py", "provision_tenant.py", "gbp_sync.py", "sync_reviews.py",
        "provider_sync.py", "provider_gbp.py", "apply_entitlement_change.py",
    ]
    repo_root = Path(__file__).resolve().parent.parent
    for filename in source_files:
        path = repo_root / filename
        if not path.exists():
            continue
        source = path.read_text(encoding="utf-8")
        assert "activate_media_capture" not in source, (
            f"{filename} must never call tenant_config_store.activate_media_capture() -- "
            f"activation is a separate, explicit, future operator action only"
        )


def test_32_resolve_media_capture_started_at_never_writes():
    # A pure read -- calling it must never touch upsert_tenant_config at all.
    # Verified structurally: it only ever calls get_tenant_config() internally.
    import inspect
    source = inspect.getsource(tenant_config_store.resolve_media_capture_started_at)
    assert "upsert_tenant_config" not in source
    assert "activate_media_capture" not in source


# ---------------------------------------------------------------------------
# Pre-Integration Audit -- three-way write model (PRESERVE / REPLACE-empty /
# REPLACE-media). These tests specifically target the bug found by direct
# code review: an UNCONDITIONAL `gbp_review_media = ?` on every UPDATE meant
# a review that was ONCE eligible with real stored media could have that
# media silently ERASED to NULL by any later, merely-ineligible call --
# including a purely transient tenant-config/Redis lookup failure. Every
# "existing media ... preserved" test below reads the column's value BEFORE
# and AFTER the second call and asserts byte-for-byte equality, not just
# "still truthy."
# ---------------------------------------------------------------------------

def _media_column(conn, gbp_review_name):
    return conn.execute("SELECT gbp_review_media FROM reviews WHERE gbp_review_name = ?", (gbp_review_name,)).fetchone()["gbp_review_media"]


def test_pa_1_legacy_null_plus_inactive_remains_null():
    conn, loc_id = _fresh_conn()
    row = _base_row(gbp_create_time="2026-09-25T00:00:00Z")
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z", media_capture_started_at=None)
    assert _stored_media(conn, row["gbp_review_name"]) is None


def test_pa_2_legacy_null_plus_missing_config_remains_null():
    conn, loc_id = _fresh_conn()
    row = _base_row(gbp_create_time="2026-09-25T00:00:00Z")
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z", media_capture_started_at="")
    assert _stored_media(conn, row["gbp_review_name"]) is None


def test_pa_3_legacy_null_plus_invalid_config_remains_null():
    conn, loc_id = _fresh_conn()
    row = _base_row(gbp_create_time="2026-09-25T00:00:00Z")
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z", media_capture_started_at="garbage")
    assert _stored_media(conn, row["gbp_review_name"]) is None


def test_pa_4_legacy_null_plus_redis_lookup_failure_remains_null():
    # At the db.py layer, a lookup failure is represented identically to
    # "missing" -- media_capture_started_at=None -- since provider_sync.py
    # collapses every non-active reason to None before ever calling
    # upsert_review(). See test_28 for the orchestration-layer proof that
    # a real TenantConfigStoreUnavailableError produces exactly this None.
    conn, loc_id = _fresh_conn()
    row = _base_row(gbp_create_time="2026-09-25T00:00:00Z")
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z", media_capture_started_at=None)
    assert _stored_media(conn, row["gbp_review_name"]) is None


def test_pa_5_legacy_null_plus_pre_activation_review_remains_null():
    conn, loc_id = _fresh_conn()
    row = _base_row(gbp_create_time="2026-08-01T00:00:00Z")
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    assert _stored_media(conn, row["gbp_review_name"]) is None


def test_pa_6_existing_media_survives_config_lookup_failure():
    conn, loc_id = _fresh_conn()
    create_time = "2026-09-25T00:00:00Z"
    row1 = _base_row(gbp_create_time=create_time, media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/real-photo"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row1, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    before = _media_column(conn, row1["gbp_review_name"])
    assert json.loads(before)  # sanity: real media is genuinely stored

    # A later sync where the tenant-config/Redis lookup failed -- represented,
    # exactly like provider_sync.py represents it, as media_capture_started_at=None.
    row2 = _base_row(gbp_create_time=create_time, gbp_update_time="2026-09-26T00:00:00Z", media=None)
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row2, "2026-09-26T00:00:01Z", media_capture_started_at=None)
    after = _media_column(conn, row1["gbp_review_name"])
    assert after == before, (
        "a config/Redis lookup failure must NEVER erase previously-stored eligible media -- "
        f"before={before!r} after={after!r}"
    )


def test_pa_7_existing_media_survives_tenant_going_inactive():
    conn, loc_id = _fresh_conn()
    create_time = "2026-09-25T00:00:00Z"
    row1 = _base_row(gbp_create_time=create_time, media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/real-photo"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row1, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    before = _media_column(conn, row1["gbp_review_name"])

    row2 = _base_row(gbp_create_time=create_time, gbp_update_time="2026-09-26T00:00:00Z", media=None)
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row2, "2026-09-26T00:00:01Z", media_capture_started_at=None)
    after = _media_column(conn, row1["gbp_review_name"])
    assert after == before, "media capture being (re-)reported inactive must never erase already-stored media"


def test_pa_8_existing_media_survives_a_pre_activation_shaped_call():
    conn, loc_id = _fresh_conn()
    create_time = "2026-09-25T00:00:00Z"
    row1 = _base_row(gbp_create_time=create_time, media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/real-photo"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row1, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    before = _media_column(conn, row1["gbp_review_name"])

    # A subsequent call for the SAME review that this time carries no valid
    # activation context at all (simulating a caller that hasn't resolved
    # tenant config for this particular invocation).
    row2 = _base_row(gbp_create_time=create_time, gbp_update_time="2026-09-27T00:00:00Z", media=None)
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row2, "2026-09-27T00:00:01Z", media_capture_started_at="")
    after = _media_column(conn, row1["gbp_review_name"])
    assert after == before


def test_pa_9_eligible_existing_media_google_removes_it_becomes_empty_array():
    conn, loc_id = _fresh_conn()
    create_time = "2026-09-25T00:00:00Z"
    row1 = _base_row(gbp_create_time=create_time, media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/p1"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row1, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    assert json.loads(_media_column(conn, row1["gbp_review_name"]))

    row2 = _base_row(gbp_create_time=create_time, gbp_update_time="2026-09-26T00:00:00Z", media=[])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row2, "2026-09-26T00:00:01Z", media_capture_started_at=ACTIVE)
    after = _media_column(conn, row1["gbp_review_name"])
    assert after == "[]", f"an eligible review whose media Google removed must become '[]', got {after!r}"


def test_pa_10_eligible_empty_then_new_media_becomes_array():
    conn, loc_id = _fresh_conn()
    create_time = "2026-09-25T00:00:00Z"
    row1 = _base_row(gbp_create_time=create_time, media=[])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row1, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    assert _media_column(conn, row1["gbp_review_name"]) == "[]"

    row2 = _base_row(gbp_create_time=create_time, gbp_update_time="2026-09-26T00:00:00Z",
                      media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/newly-added"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row2, "2026-09-26T00:00:01Z", media_capture_started_at=ACTIVE)
    stored = json.loads(_media_column(conn, row1["gbp_review_name"]))
    assert stored[0]["thumbnailUrl"] == "https://lh3.googleusercontent.com/newly-added"


def test_pa_11_eligible_media_changed_url_replaced():
    conn, loc_id = _fresh_conn()
    create_time = "2026-09-25T00:00:00Z"
    row1 = _base_row(gbp_create_time=create_time, media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/old-url"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row1, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)

    row2 = _base_row(gbp_create_time=create_time, gbp_update_time="2026-09-26T00:00:00Z",
                      media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/rotated-url"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row2, "2026-09-26T00:00:01Z", media_capture_started_at=ACTIVE)
    stored = json.loads(_media_column(conn, row1["gbp_review_name"]))
    assert len(stored) == 1
    assert stored[0]["thumbnailUrl"] == "https://lh3.googleusercontent.com/rotated-url"


def test_pa_12_direct_upsert_without_activation_argument_preserves_existing():
    conn, loc_id = _fresh_conn()
    create_time = "2026-09-25T00:00:00Z"
    row1 = _base_row(gbp_create_time=create_time, media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/p1"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row1, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    before = _media_column(conn, row1["gbp_review_name"])

    # No media_capture_started_at kwarg AT ALL -- the classic import/repair
    # call shape (5 positional args only).
    row2 = _base_row(gbp_create_time=create_time, gbp_update_time="2026-09-26T00:00:00Z", media=None)
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row2, "2026-09-26T00:00:01Z")
    after = _media_column(conn, row1["gbp_review_name"])
    assert after == before

    # And the NULL variant: a legacy row that never had media, touched by
    # an activation-omitting caller, must still end up NULL, not '[]'.
    conn2, loc_id2 = _fresh_conn(prefix="test_review_media_null_")
    row3 = _base_row(gbp_create_time=create_time, media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/irrelevant"}],
                      gbp_review_name="accounts/1/locations/2/reviews/never-activated")
    db.upsert_review(conn2, loc_id2, "Casa Tequila Testtown", row3, "2026-09-25T00:00:01Z")  # no kwarg at all
    assert _media_column(conn2, row3["gbp_review_name"]) is None


def test_pa_13_historical_malicious_media_cannot_bypass_gate_even_with_existing_media():
    conn, loc_id = _fresh_conn()
    create_time = "2026-09-25T00:00:00Z"
    row1 = _base_row(gbp_create_time=create_time, media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/legit"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row1, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    before = _media_column(conn, row1["gbp_review_name"])

    # A later, INELIGIBLE call (createTime now claims to be pre-activation --
    # which can't legitimately happen for the same review, but proves the
    # gate is driven by eligibility, not by whatever `media` merely contains)
    # bearing an attacker-shaped payload must neither replace the existing
    # real media NOR ever reach the sanitizer's output.
    row2 = _base_row(gbp_create_time="2020-01-01T00:00:00Z", gbp_update_time="2026-09-26T00:00:00Z",
                      media=[{"thumbnailUrl": "javascript:alert(1)"}, {"thumbnailUrl": "https://evil.example.com/p1"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row2, "2026-09-26T00:00:01Z", media_capture_started_at=ACTIVE)
    after = _media_column(conn, row1["gbp_review_name"])
    assert after == before, "an ineligible call's media payload must never replace existing eligible media, malicious or not"


def test_pa_14_update_time_after_activation_cannot_qualify_an_old_review_with_no_existing_media():
    conn, loc_id = _fresh_conn()
    row1 = _base_row(gbp_create_time="2020-01-01T00:00:00Z", gbp_update_time="2026-09-26T00:00:00Z",
                      media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/p1"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row1, "2026-09-26T00:00:01Z", media_capture_started_at=ACTIVE)
    assert _media_column(conn, row1["gbp_review_name"]) is None


def test_pa_15_create_time_equality_still_qualifies():
    conn, loc_id = _fresh_conn()
    row1 = _base_row(gbp_create_time=ACTIVE, media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/p1"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row1, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    assert json.loads(_media_column(conn, row1["gbp_review_name"]))


def test_pa_16_no_owner_response_revision_from_any_media_transition():
    conn, loc_id = _fresh_conn()
    create_time = "2026-09-25T00:00:00Z"
    row1 = _base_row(gbp_create_time=create_time, media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/p1"}])
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row1, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    review_id = conn.execute("SELECT id FROM reviews WHERE gbp_review_name = ?", (row1["gbp_review_name"],)).fetchone()["id"]

    transitions = [
        _base_row(gbp_create_time=create_time, gbp_update_time="2026-09-26T00:00:00Z", media=[]),  # -> REPLACE_EMPTY
        _base_row(gbp_create_time=create_time, gbp_update_time="2026-09-27T00:00:00Z",
                   media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/p2"}]),  # -> REPLACE_MEDIA
    ]
    now = "2026-09-28T00:00:01Z"
    for i, row in enumerate(transitions):
        db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row, f"2026-09-2{6+i}T00:00:01Z", media_capture_started_at=ACTIVE)
    # Also a PRESERVE transition.
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown",
                      _base_row(gbp_create_time=create_time, gbp_update_time="2026-09-29T00:00:00Z", media=None),
                      now, media_capture_started_at=None)

    revisions = conn.execute("SELECT field_changed FROM review_revisions WHERE review_id = ?", (review_id,)).fetchall()
    assert {r["field_changed"] for r in revisions} == set(), (
        "no media transition (REPLACE_EMPTY, REPLACE_MEDIA, or PRESERVE) may ever create a review_revisions row"
    )


def test_pa_17_tenant_isolation_media_preservation():
    conn_a, loc_a = _fresh_conn(prefix="test_pa_tenant_a_")
    conn_b, loc_b = _fresh_conn(prefix="test_pa_tenant_b_")
    row_a = _base_row(gbp_create_time="2026-09-25T00:00:00Z", gbp_review_name="accounts/1/locations/2/reviews/pa-tenant-a",
                       media=[{"thumbnailUrl": "https://lh3.googleusercontent.com/tenant-a-photo"}])
    db.upsert_review(conn_a, loc_a, "Casa Tequila Testtown", row_a, "2026-09-25T00:00:01Z", media_capture_started_at=ACTIVE)
    # Tenant B's own database has no row at all for tenant A's review --
    # a lookup for it must find nothing, not tenant A's stored media.
    missing = conn_b.execute("SELECT gbp_review_media FROM reviews WHERE gbp_review_name = ?", (row_a["gbp_review_name"],)).fetchone()
    assert missing is None


def test_pa_18_normal_fields_still_update_while_media_is_preserved():
    conn, loc_id = _fresh_conn()
    create_time = "2026-08-01T00:00:00Z"  # permanently pre-activation
    row1 = _base_row(gbp_create_time=create_time, review_text="Original text", star_rating=3)
    db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row1, "2026-08-01T00:00:01Z", media_capture_started_at=ACTIVE)
    assert _media_column(conn, row1["gbp_review_name"]) is None

    row2 = _base_row(gbp_create_time=create_time, gbp_update_time="2026-09-26T00:00:00Z",
                      review_text="Edited text after the fact", star_rating=1, media=None)
    result = db.upsert_review(conn, loc_id, "Casa Tequila Testtown", row2, "2026-09-26T00:00:01Z", media_capture_started_at=ACTIVE)
    assert result == "edited"
    updated = conn.execute("SELECT review_text, star_rating, gbp_review_media FROM reviews WHERE gbp_review_name = ?",
                            (row1["gbp_review_name"],)).fetchone()
    assert updated["review_text"] == "Edited text after the fact"
    assert updated["star_rating"] == 1
    assert updated["gbp_review_media"] is None, "media stays PRESERVED (NULL) even though other fields updated normally"


def main() -> int:
    tests = [
        ("1: missing tenant mediaCapture stores nothing", test_1_missing_tenant_media_capture_stores_nothing),
        ("2: inactive mediaCapture stores nothing", test_2_inactive_media_capture_stores_nothing),
        ("3: missing startedAt stores nothing", test_3_missing_started_at_stores_nothing),
        ("4: invalid startedAt stores nothing", test_4_invalid_started_at_stores_nothing),
        ("5: valid activation stores media", test_5_valid_activation_stores_media),
        ("6: createTime before activation stores nothing", test_6_create_time_before_activation_stores_nothing),
        ("7: createTime equal to activation stores media (inclusive)", test_7_create_time_equal_to_activation_stores_media),
        ("8: createTime after activation stores media", test_8_create_time_after_activation_stores_media),
        ("9: old review updated after activation remains ineligible", test_9_old_review_updated_after_activation_remains_ineligible),
        ("10: eligible review edited later remains eligible", test_10_eligible_review_edited_later_remains_eligible),
        ("11: direct upsert with media but no activation stores nothing", test_11_direct_upsert_with_media_but_no_activation_stores_nothing),
        ("12: import/repair path omitting activation fails closed", test_12_import_repair_path_omitting_activation_fails_closed),
        ("13: one photo end-to-end", test_13_one_photo_end_to_end),
        ("14: five photos end-to-end", test_14_five_photos_end_to_end),
        ("15: video end-to-end", test_15_video_end_to_end),
        ("16: mixed media end-to-end", test_16_mixed_media_end_to_end),
        ("17: duplicate items end-to-end", test_17_duplicate_items_end_to_end),
        ("18: more than 20 items end-to-end", test_18_more_than_20_items_end_to_end),
        ("19: URL over 2048 chars end-to-end", test_19_url_over_2048_chars_end_to_end),
        ("20: unsafe-scheme URLs end-to-end", test_20_unsafe_scheme_urls_end_to_end),
        ("21: credential-bearing URL end-to-end", test_21_credential_bearing_url_end_to_end),
        ("22: label over 200 chars end-to-end", test_22_label_over_200_chars_end_to_end),
        ("23: serialized result over 8KB end-to-end", test_23_serialized_result_over_8kb_end_to_end),
        ("24: media removal from an eligible review", test_24_media_removal_from_eligible_review),
        ("25: no fake owner-response revision from a media-only change", test_25_no_fake_owner_response_revision_from_media_only_change),
        ("26: legacy row with NULL media is readable", test_26_legacy_row_with_null_media_readable),
        ("27: tenant isolation across separate databases", test_27_tenant_isolation_separate_databases),
        ("28: config lookup failure fails closed, sync continues", test_28_config_lookup_failure_fails_closed_in_sync_orchestration),
        ("29: no additional Google API call from media processing", test_29_no_additional_google_api_call_from_media_processing),
        ("30: no media URL fetch from media processing", test_30_no_media_url_fetch_from_media_processing),
        ("31: activation helper never called by deploy/onboarding/sync", test_31_activation_helper_never_called_by_deploy_onboarding_or_sync),
        ("32: resolve_media_capture_started_at() never writes", test_32_resolve_media_capture_started_at_never_writes),
        # --- Pre-Integration Audit: three-way write model (PRESERVE fix) ---
        ("PA-1: legacy NULL + inactive remains NULL", test_pa_1_legacy_null_plus_inactive_remains_null),
        ("PA-2: legacy NULL + missing config remains NULL", test_pa_2_legacy_null_plus_missing_config_remains_null),
        ("PA-3: legacy NULL + invalid config remains NULL", test_pa_3_legacy_null_plus_invalid_config_remains_null),
        ("PA-4: legacy NULL + Redis lookup failure remains NULL", test_pa_4_legacy_null_plus_redis_lookup_failure_remains_null),
        ("PA-5: legacy NULL + pre-activation review remains NULL", test_pa_5_legacy_null_plus_pre_activation_review_remains_null),
        ("PA-6: existing media survives a config/Redis lookup failure", test_pa_6_existing_media_survives_config_lookup_failure),
        ("PA-7: existing media survives the tenant going inactive", test_pa_7_existing_media_survives_tenant_going_inactive),
        ("PA-8: existing media survives a pre-activation-shaped call", test_pa_8_existing_media_survives_a_pre_activation_shaped_call),
        ("PA-9: eligible existing media -- Google removes it -> becomes []", test_pa_9_eligible_existing_media_google_removes_it_becomes_empty_array),
        ("PA-10: eligible [] -> new media becomes an array", test_pa_10_eligible_empty_then_new_media_becomes_array),
        ("PA-11: eligible media with a changed URL is replaced", test_pa_11_eligible_media_changed_url_replaced),
        ("PA-12: direct upsert without the activation argument preserves existing/NULL", test_pa_12_direct_upsert_without_activation_argument_preserves_existing),
        ("PA-13: historical malicious media cannot bypass the gate or erase existing media", test_pa_13_historical_malicious_media_cannot_bypass_gate_even_with_existing_media),
        ("PA-14: updateTime after activation cannot qualify an old review", test_pa_14_update_time_after_activation_cannot_qualify_an_old_review_with_no_existing_media),
        ("PA-15: createTime equality still qualifies", test_pa_15_create_time_equality_still_qualifies),
        ("PA-16: no owner-response revision from any media transition (REPLACE_EMPTY/REPLACE_MEDIA/PRESERVE)", test_pa_16_no_owner_response_revision_from_any_media_transition),
        ("PA-17: tenant isolation of preserved media", test_pa_17_tenant_isolation_media_preservation),
        ("PA-18: normal review fields still update while media is preserved", test_pa_18_normal_fields_still_update_while_media_is_preserved),
    ]
    for name, fn in tests:
        run(name, fn)
    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
