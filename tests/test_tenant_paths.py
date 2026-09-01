"""
Regression tests for tenant_paths.py -- the Multi-Tenant Phase 4D canonical
resolver from a validated tenant_id to the ONE review database file / ONE
export directory that tenant may read or write. Mirrors tenant_keys.py's
own registry discipline and test_tenant_keys.py's cross-checking style.

Run directly: py tests/test_tenant_paths.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import tenant_keys
import tenant_paths as tp

SYNTHETIC_TENANT_ID = "t_synthetic-second-tenant"

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except AssertionError as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)
    finally:
        tp._reset_review_db_paths_for_tests()
        tp._reset_export_dirs_for_tests()


# --- Registry / basic resolution ---------------------------------------

def test_los_tres_amigos_resolves_to_the_real_existing_path():
    db_path = tp.resolve_review_db_path(tenant_keys.DEFAULT_TENANT_ID)
    assert db_path == tp.BASE_DIR / "dashboard" / "reviews.db", (
        f"LTA's review db path must be exactly the pre-Phase-4D path, got {db_path}"
    )
    export_dir = tp.resolve_export_dir(tenant_keys.DEFAULT_TENANT_ID)
    assert export_dir == tp.BASE_DIR / "dashboard" / "private-data", (
        f"LTA's export dir must be exactly the pre-Phase-4D path, got {export_dir}"
    )


def test_is_tenant_onboarded():
    assert tp.is_tenant_onboarded(tenant_keys.DEFAULT_TENANT_ID) is True
    assert tp.is_tenant_onboarded(SYNTHETIC_TENANT_ID) is False


# --- Fail closed: invalid tenant ----------------------------------------

def test_invalid_tenant_id_fails_closed_before_any_registry_lookup():
    for bad in (None, "", "not-a-tenant-id", "T_LOS-TRES-AMIGOS", 123, {}, [], "t_"):
        for fn, args in (
            (tp.resolve_review_db_path, (bad,)),
            (tp.resolve_export_dir, (bad,)),
            (tp.is_tenant_onboarded, (bad,)),
        ):
            try:
                fn(*args)
                raise AssertionError(f"{fn.__name__}({bad!r}) must raise InvalidTenantIdError")
            except tenant_keys.InvalidTenantIdError:
                pass


# --- Fail closed: unknown/unconfigured tenant ---------------------------

def test_unknown_but_well_formed_tenant_fails_closed():
    for fn in (tp.resolve_review_db_path, tp.resolve_export_dir):
        try:
            fn(SYNTHETIC_TENANT_ID)
            raise AssertionError(f"{fn.__name__}({SYNTHETIC_TENANT_ID!r}) must raise UnknownTenantError")
        except tp.UnknownTenantError:
            pass


def test_unknown_tenant_error_is_distinct_from_invalid_tenant_error():
    """The two failure modes are deliberately different exception types --
    'malformed id' vs. 'not onboarded' -- both fail closed, but a caller
    (or a test) can tell them apart."""
    assert issubclass(tp.UnknownTenantError, ValueError)
    assert not issubclass(tp.UnknownTenantError, tenant_keys.InvalidTenantIdError)
    assert not issubclass(tenant_keys.InvalidTenantIdError, tp.UnknownTenantError)


# --- No path-traversal / string-interpolation possible -------------------

def test_no_input_can_traverse_outside_the_registered_paths():
    """The whole point of the registry design: there is no function of
    tenant_id that BUILDS a path (e.g. f'.../{tenant_id}/reviews.db') --
    every resolution is a dict lookup against explicitly committed Path
    objects. Proven two ways: (1) a battery of traversal-shaped strings all
    fail tenant_keys' regex before ever reaching the registry, and (2) the
    registry values themselves never contain a tenant_id substring, which
    would be the tell-tale sign of string interpolation."""
    traversal_attempts = [
        "t_../../etc/passwd", "t_..", "t_./../../secrets", "t_%2e%2e",
        "t_los-tres-amigos/../other-tenant", "t_los-tres-amigos\x00",
    ]
    for attempt in traversal_attempts:
        assert not tenant_keys.is_valid_tenant_id(attempt), (
            f"{attempt!r} must be rejected by the tenant id format regex before any path logic runs"
        )
        try:
            tp.resolve_review_db_path(attempt)
            raise AssertionError(f"resolve_review_db_path({attempt!r}) must raise, not resolve a traversal path")
        except tenant_keys.InvalidTenantIdError:
            pass

    # The registry's own values are fixed Path objects with no tenant_id
    # substring embedded via interpolation -- inspecting the real,
    # unregistered, unmodified module state (not the test overrides).
    for tenant_id, path in tp._TENANT_REVIEW_DB_REGISTRY.items():
        assert tenant_id not in str(path) or tenant_id == tenant_keys.DEFAULT_TENANT_ID and "reviews.db" in str(path), (
            "sanity check: registry paths are not naively built from tenant_id string interpolation"
        )


def test_resolver_functions_take_only_tenant_id_no_other_input_can_influence_the_path():
    """Structural: neither resolver accepts any parameter besides
    tenant_id -- there is no way for a caller to pass a raw path segment,
    override, or hint that could influence which file gets opened."""
    import inspect
    for fn in (tp.resolve_review_db_path, tp.resolve_export_dir, tp.is_tenant_onboarded):
        params = list(inspect.signature(fn).parameters)
        assert params == ["tenant_id"], f"{fn.__name__} must take only tenant_id, got {params}"


# --- Test-only override seam behaves correctly ---------------------------

def test_override_seam_is_scoped_and_resettable():
    scratch = Path("/tmp/scratch-tenant-b-reviews.db")
    tp._set_review_db_path_for_tests(SYNTHETIC_TENANT_ID, scratch)
    assert tp.resolve_review_db_path(SYNTHETIC_TENANT_ID) == scratch
    # LTA's real registry entry must be completely unaffected by a
    # synthetic tenant's override.
    assert tp.resolve_review_db_path(tenant_keys.DEFAULT_TENANT_ID) == tp.BASE_DIR / "dashboard" / "reviews.db"
    tp._reset_review_db_paths_for_tests()
    try:
        tp.resolve_review_db_path(SYNTHETIC_TENANT_ID)
        raise AssertionError("expected UnknownTenantError after the override was reset")
    except tp.UnknownTenantError:
        pass


def test_override_seam_can_also_override_lta_for_a_single_test_without_touching_the_real_registry():
    """This is exactly how every entrypoint test in this suite isolates
    itself from the real dashboard/reviews.db: override LTA's OWN
    resolution for the duration of one test, then reset it -- the module's
    real _TENANT_REVIEW_DB_REGISTRY entry for LTA is never mutated."""
    scratch = Path("/tmp/scratch-lta-reviews.db")
    real_lta_path = tp._TENANT_REVIEW_DB_REGISTRY[tenant_keys.DEFAULT_TENANT_ID]
    tp._set_review_db_path_for_tests(tenant_keys.DEFAULT_TENANT_ID, scratch)
    assert tp.resolve_review_db_path(tenant_keys.DEFAULT_TENANT_ID) == scratch
    assert tp._TENANT_REVIEW_DB_REGISTRY[tenant_keys.DEFAULT_TENANT_ID] == real_lta_path, (
        "the real registry dict must never be mutated by a test override"
    )
    tp._reset_review_db_paths_for_tests()
    assert tp.resolve_review_db_path(tenant_keys.DEFAULT_TENANT_ID) == real_lta_path


def main() -> int:
    run("Los Tres Amigos resolves to the real, existing, unchanged review db / export dir paths", test_los_tres_amigos_resolves_to_the_real_existing_path)
    run("is_tenant_onboarded() distinguishes LTA from an unregistered tenant", test_is_tenant_onboarded)
    run("invalid tenant ids fail closed before any registry lookup", test_invalid_tenant_id_fails_closed_before_any_registry_lookup)
    run("an unknown but well-formed tenant fails closed (UnknownTenantError)", test_unknown_but_well_formed_tenant_fails_closed)
    run("UnknownTenantError and InvalidTenantIdError are distinct failure modes", test_unknown_tenant_error_is_distinct_from_invalid_tenant_error)
    run("no input (including path-traversal payloads) can escape the registered paths", test_no_input_can_traverse_outside_the_registered_paths)
    run("both resolvers take only tenant_id -- no other input can influence the resolved path", test_resolver_functions_take_only_tenant_id_no_other_input_can_influence_the_path)
    run("the test-only override seam is scoped per tenant_id and fully resettable", test_override_seam_is_scoped_and_resettable)
    run("the test-only override seam never mutates the real registry dict", test_override_seam_can_also_override_lta_for_a_single_test_without_touching_the_real_registry)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
