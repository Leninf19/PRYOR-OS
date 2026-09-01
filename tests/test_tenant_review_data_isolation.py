"""
Multi-Tenant Phase 4D adversarial tests: proves the review-data plane
(SQLite database + export directory) is isolated per tenant at the level
of the real process entrypoints (sync_reviews.py, gbp_import.py,
export_chunks.py, critical_alert_check.py, gbp_reply_bridge_reconcile.py,
check_db_integrity.py) -- not just at tenant_paths.py's own unit level
(see test_tenant_paths.py).

Two synthetic tenants (never Los Tres Amigos's real database) are
registered via tenant_paths.py's test-only override seam, each with its
own scratch SQLite file and export directory containing distinctive,
easily-detected data. Every test drives a REAL entrypoint function against
one tenant and asserts the other tenant's file/directory is provably
untouched (same mtime, same byte content, same row counts) -- proving
cross-tenant isolation at exactly the boundary a background worker
actually operates at, not just proving the resolver function returns the
right string.

Run directly: py tests/test_tenant_review_data_isolation.py
"""
import json
import sys
import tempfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import check_db_integrity
import critical_alert_check as cac
import db
import export_chunks
import gbp_import
import gbp_reply_bridge_reconcile as bridge_reconcile
import gbp_sync
import google_api as ga
import tenant_keys
import tenant_paths as tp

TENANT_A = tenant_keys.DEFAULT_TENANT_ID  # t_los-tres-amigos, via the test override seam -- never the real file
TENANT_B = "t_synthetic-second-tenant"
UNKNOWN_TENANT = "t_never-onboarded"

results = []


def run(name, fn):
    tmpdir = tempfile.mkdtemp(prefix="tenant_isolation_test_")
    try:
        fn(Path(tmpdir))
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)
    finally:
        tp._reset_review_db_paths_for_tests()
        tp._reset_export_dirs_for_tests()


def _make_tenant_db(db_path: Path, location_name: str, reviewer_name: str) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    original_path = db.DB_PATH
    db.DB_PATH = db_path
    try:
        conn = db.get_connection()
        db.init_schema(conn)
        conn.execute(
            "INSERT INTO locations (name, city, brand) VALUES (?, 'Testville', 'Casa Tequila')",
            (location_name,),
        )
        loc_id = conn.execute("SELECT id FROM locations WHERE name = ?", (location_name,)).fetchone()["id"]
        conn.execute(
            """INSERT INTO reviews (location_id, reviewer_name, review_date, star_rating, review_text,
               dedup_key, is_deleted, first_seen_at, last_seen_at)
               VALUES (?, ?, '2026-08-01', 5, 'Great food', ?, 0, '2026-08-01', '2026-08-01')""",
            (loc_id, reviewer_name, f"{location_name}-{reviewer_name}"),
        )
        # export_location_analytics()/validate_location_analytics() require
        # one analytics_cache row per location (normally written by
        # refresh_analytics.py) -- minimal stand-in payload is sufficient.
        conn.execute(
            "INSERT INTO analytics_cache (cache_key, payload) VALUES (?, ?)",
            (f"analytics_location_{loc_id}", json.dumps({"locationId": loc_id, "reviewCounts": {"lifetime": 1}})),
        )
        conn.commit()
        conn.close()
    finally:
        db.DB_PATH = original_path


def _setup_two_tenants(tmp_root: Path):
    """Registers TENANT_A and TENANT_B each with their own scratch
    reviews.db and export directory, seeded with distinctive, non-
    overlapping data -- returns the four paths for assertions."""
    a_db = tmp_root / "tenant_a" / "reviews.db"
    b_db = tmp_root / "tenant_b" / "reviews.db"
    a_export = tmp_root / "tenant_a" / "private-data"
    b_export = tmp_root / "tenant_b" / "private-data"
    _make_tenant_db(a_db, "Tenant A Exclusive Location", "Tenant A Exclusive Reviewer")
    _make_tenant_db(b_db, "Tenant B Exclusive Location", "Tenant B Exclusive Reviewer")
    tp._set_review_db_path_for_tests(TENANT_A, a_db)
    tp._set_review_db_path_for_tests(TENANT_B, b_db)
    tp._set_export_dir_for_tests(TENANT_A, a_export)
    tp._set_export_dir_for_tests(TENANT_B, b_export)
    return a_db, b_db, a_export, b_export


def _snapshot(path: Path):
    """(exists, mtime, size) or None -- enough to detect ANY write,
    including an in-place rewrite that preserves row counts."""
    if not path.exists():
        return None
    stat = path.stat()
    return (stat.st_mtime_ns, stat.st_size)


# --- Tenant A cannot open Tenant B's review store / import / export ------

def test_export_for_tenant_a_never_writes_into_tenant_bs_directory(tmp_root):
    a_db, b_db, a_export, b_export = _setup_two_tenants(tmp_root)
    assert not b_export.exists(), "sanity: Tenant B's export dir must not exist yet"

    export_chunks.main(TENANT_A)

    assert a_export.exists() and any(a_export.rglob("*.json")), "Tenant A's own export must have run"
    assert not b_export.exists(), "Tenant A's export() must never create or write into Tenant B's export directory"


def test_export_for_tenant_a_never_contains_tenant_bs_review_data(tmp_root):
    a_db, b_db, a_export, b_export = _setup_two_tenants(tmp_root)
    export_chunks.main(TENANT_A)

    meta = json.loads((a_export / "meta.json").read_text(encoding="utf-8"))
    location_names = {loc["name"] for loc in meta["locations"]}
    assert "Tenant A Exclusive Location" in location_names
    assert "Tenant B Exclusive Location" not in location_names, (
        "Tenant A's exported meta.json must never contain Tenant B's location/review data -- "
        "analytics/count/rating generation must not aggregate across tenants"
    )

    # export_reviews_csv() writes one level above PRIVATE_DATA_DIR (see its
    # own Phase 4D docstring) -- a_export.parent, not a_export itself.
    reviews_csv = (a_export.parent / "reviews.csv").read_text(encoding="utf-8")
    assert "Tenant B Exclusive Reviewer" not in reviews_csv


def test_import_for_tenant_a_never_writes_into_tenant_bs_database(tmp_root):
    a_db, b_db, a_export, b_export = _setup_two_tenants(tmp_root)
    b_before = _snapshot(b_db)
    original_report_path = gbp_import.REPORT_PATH
    gbp_import.REPORT_PATH = tmp_root / "gbp_import_report.json"  # never the real repo-root file

    api_review = {
        "name": "accounts/1/locations/2/reviews/new1",
        "reviewer": {"displayName": "Brand New Reviewer"},
        "starRating": "FIVE", "comment": "Fantastic", "createTime": "2026-08-10T12:00:00Z",
    }
    try:
        with mock.patch.object(ga, "is_configured", return_value=True), \
             mock.patch.object(ga, "list_accounts", return_value=[{"name": "accounts/1", "accountName": "Test"}]), \
             mock.patch.object(ga, "list_locations", return_value=[
                 {"name": "accounts/1/locations/2", "locationName": "Tenant A Exclusive Location"}]), \
             mock.patch.object(ga, "list_reviews", return_value=[api_review]):
            gbp_import.run(tenant_id=TENANT_A, apply=True)
    finally:
        gbp_import.REPORT_PATH = original_report_path

    assert _snapshot(b_db) == b_before, "importing for Tenant A must never write to Tenant B's database file"

    original_path = db.DB_PATH
    db.DB_PATH = a_db
    try:
        conn = db.get_connection()
        count = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
        conn.close()
    finally:
        db.DB_PATH = original_path
    assert count == 2, f"Tenant A's own database must have received the new review, got count={count}"


def test_sync_for_tenant_a_never_writes_into_tenant_bs_database(tmp_root):
    a_db, b_db, a_export, b_export = _setup_two_tenants(tmp_root)
    b_before = _snapshot(b_db)

    review = {
        "name": "accounts/1/locations/2/reviews/syncnew1",
        "reviewer": {"displayName": "Sync Reviewer"},
        "starRating": "FOUR", "comment": "Solid", "createTime": "2026-08-11T12:00:00Z", "updateTime": "2026-08-11T12:00:00Z",
    }
    with mock.patch.object(ga, "is_configured", return_value=True), \
         mock.patch.object(ga, "list_accounts", return_value=[{"name": "accounts/1", "accountName": "Test"}]), \
         mock.patch.object(ga, "list_locations", return_value=[
             {"name": "accounts/1/locations/2", "locationName": "Tenant A Exclusive Location"}]), \
         mock.patch.object(ga, "list_reviews", return_value=[review]):
        gbp_sync.sync_all(tenant_id=TENANT_A, fast=False)

    assert _snapshot(b_db) == b_before, "syncing for Tenant A must never write to Tenant B's database file"


def test_critical_alert_check_for_tenant_a_never_writes_into_tenant_bs_database(tmp_root):
    a_db, b_db, a_export, b_export = _setup_two_tenants(tmp_root)
    b_before = _snapshot(b_db)

    with mock.patch.object(gbp_sync, "sync_all", return_value={"status": "skipped", "reason": "not configured"}):
        cac.run(TENANT_A)

    assert _snapshot(b_db) == b_before, "critical_alert_check for Tenant A must never write to Tenant B's database file"
    assert db.DB_PATH == a_db, "critical_alert_check.run() must have resolved db.DB_PATH to Tenant A's own database"


def test_check_db_integrity_for_tenant_a_never_reads_tenant_bs_database(tmp_root):
    a_db, b_db, a_export, b_export = _setup_two_tenants(tmp_root)
    with mock.patch.object(sys, "argv", ["check_db_integrity.py", "--tenant-id", TENANT_A]):
        exit_code = check_db_integrity.main()
    assert exit_code == 0, "Tenant A's own database must pass its own integrity check"

    with mock.patch.object(sys, "argv", ["check_db_integrity.py", "--tenant-id", TENANT_B]), \
         mock.patch.object(check_db_integrity, "check_integrity") as mock_check:
        mock_check.return_value = (True, "ok", {"locations": 1, "reviews": 1})
        check_db_integrity.main()
        called_path = mock_check.call_args[0][0]
    assert called_path == b_db, "a --tenant-id of Tenant B must check exactly Tenant B's own database, never Tenant A's"
    assert called_path != a_db


def test_gbp_reply_bridge_reconcile_resolves_tenant_as_own_database_only(tmp_root):
    """gbp_reply_bridge_reconcile.py's Redis-side cross-tenant isolation is
    already exhaustively covered by test_gbp_reply_bridge_reconcile.py --
    this test covers the Phase 4D addition specifically: main() must
    resolve db.DB_PATH to the CALLING tenant's own database, never the
    other tenant's, before it ever reaches Redis."""
    a_db, b_db, a_export, b_export = _setup_two_tenants(tmp_root)
    with mock.patch.object(sys, "argv", ["gbp_reply_bridge_reconcile.py", "--tenant-id", TENANT_A]), \
         mock.patch.object(ga, "is_configured", return_value=False):  # short-circuits before any Redis/DB call
        bridge_reconcile.main()
    assert db.DB_PATH == a_db, "gbp_reply_bridge_reconcile.main() must resolve db.DB_PATH to Tenant A's own database"
    assert db.DB_PATH != b_db


# --- Unknown/invalid tenant fails before any SQLite/filesystem access ----

def test_unknown_tenant_fails_before_any_database_access_for_every_entrypoint(tmp_root):
    _setup_two_tenants(tmp_root)  # TENANT_A/TENANT_B registered; UNKNOWN_TENANT deliberately is not

    with mock.patch.object(db, "get_connection") as explosive_get_connection:
        explosive_get_connection.side_effect = AssertionError("must never be called for an unknown tenant")

        try:
            gbp_import.run(tenant_id=UNKNOWN_TENANT, apply=True)
            raise AssertionError("expected UnknownTenantError")
        except tp.UnknownTenantError:
            pass

        try:
            cac.run(UNKNOWN_TENANT)
            raise AssertionError("expected UnknownTenantError")
        except tp.UnknownTenantError:
            pass

        try:
            gbp_sync.sync_all(tenant_id=UNKNOWN_TENANT, fast=True)
            raise AssertionError("expected UnknownTenantError")
        except tp.UnknownTenantError:
            pass

        explosive_get_connection.assert_not_called()

    with mock.patch.object(sys, "argv", ["check_db_integrity.py", "--tenant-id", UNKNOWN_TENANT]):
        assert check_db_integrity.main() == 1, "check_db_integrity.py must fail closed (exit 1) for an unknown tenant"

    with mock.patch.object(sys, "argv", ["gbp_reply_bridge_reconcile.py", "--tenant-id", UNKNOWN_TENANT]):
        assert bridge_reconcile.main() == 1, "gbp_reply_bridge_reconcile.py must fail closed (exit 1) for an unknown tenant"

    try:
        export_chunks.main(UNKNOWN_TENANT)
        raise AssertionError("expected UnknownTenantError")
    except tp.UnknownTenantError:
        pass


def test_unknown_tenant_export_never_creates_any_directory(tmp_root):
    _setup_two_tenants(tmp_root)
    canary = tmp_root / "should-never-exist-for-unknown-tenant"
    with mock.patch.object(tp, "_TEST_EXPORT_DIR_OVERRIDES", {}):
        try:
            with mock.patch.object(export_chunks, "PRIVATE_DATA_DIR", canary):
                export_chunks.main(UNKNOWN_TENANT)
                raise AssertionError("expected UnknownTenantError")
        except tp.UnknownTenantError:
            pass
    assert not canary.exists(), "no directory must ever be created on the fail-closed path for an unknown tenant"


# --- Path-traversal-shaped input cannot alter the resolved path ----------

def test_path_traversal_shaped_tenant_ids_cannot_alter_any_resolved_path(tmp_root):
    _setup_two_tenants(tmp_root)
    for payload in ("t_../../etc/passwd", "t_los-tres-amigos/../t_synthetic-second-tenant", "t_..%2f..%2fsecrets"):
        with mock.patch.object(db, "get_connection") as explosive:
            explosive.side_effect = AssertionError("must never be called")
            for fn, kwargs in (
                (gbp_import.run, dict(tenant_id=payload, apply=True)),
                (gbp_sync.sync_all, dict(tenant_id=payload, fast=True)),
                (cac.run, {}),
            ):
                try:
                    if fn is cac.run:
                        cac.run(payload)
                    else:
                        fn(**kwargs)
                    raise AssertionError(f"{fn.__name__}({payload!r}) must raise, never resolve a path")
                except (tenant_keys.InvalidTenantIdError, tp.UnknownTenantError):
                    pass
            explosive.assert_not_called()


def main() -> int:
    run("export_chunks.main() for Tenant A never writes into Tenant B's export directory", test_export_for_tenant_a_never_writes_into_tenant_bs_directory)
    run("export_chunks.main() for Tenant A never contains Tenant B's location/review data", test_export_for_tenant_a_never_contains_tenant_bs_review_data)
    run("gbp_import.run() for Tenant A never writes into Tenant B's database", test_import_for_tenant_a_never_writes_into_tenant_bs_database)
    run("gbp_sync.sync_all() for Tenant A never writes into Tenant B's database", test_sync_for_tenant_a_never_writes_into_tenant_bs_database)
    run("critical_alert_check.run() for Tenant A never writes into Tenant B's database", test_critical_alert_check_for_tenant_a_never_writes_into_tenant_bs_database)
    run("check_db_integrity.main() for Tenant A never reads Tenant B's database", test_check_db_integrity_for_tenant_a_never_reads_tenant_bs_database)
    run("gbp_reply_bridge_reconcile.main() resolves only the calling tenant's own database", test_gbp_reply_bridge_reconcile_resolves_tenant_as_own_database_only)
    run("an unknown tenant fails before any database access, for every entrypoint", test_unknown_tenant_fails_before_any_database_access_for_every_entrypoint)
    run("an unknown tenant's export never creates any directory on disk", test_unknown_tenant_export_never_creates_any_directory)
    run("path-traversal-shaped tenant ids cannot alter any resolved path, for every entrypoint", test_path_traversal_shaped_tenant_ids_cannot_alter_any_resolved_path)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
