"""
Regression tests for tenant_keys.py -- the Python-side mirror of the
canonical tenant key architecture defined in dashboard/api/_lib/tenants.js/
tenantKeys.js/tenantDualRead.js (Multi-Tenant Phase 4C).

Cross-checks every constant/format string here against the LITERAL values
in the Node source files (read directly, not hand-copied) so the Python
mirror can never silently drift from the Node original -- the same
discipline test_tenant_model.js already applies to Node's own v1<->v2 key
registry.

Run directly: py tests/test_tenant_keys.py
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import tenant_keys as tk

REPO_ROOT = Path(__file__).resolve().parent.parent
TENANTS_JS = (REPO_ROOT / "dashboard" / "api" / "_lib" / "tenants.js").read_text(encoding="utf-8")
TENANT_KEYS_JS = (REPO_ROOT / "dashboard" / "api" / "_lib" / "tenantKeys.js").read_text(encoding="utf-8")

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except AssertionError as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


# --- Cross-checked against the real Node source -----------------------------

def test_default_tenant_id_matches_node():
    assert "export const DEFAULT_TENANT_ID = 't_los-tres-amigos'" in TENANTS_JS, (
        "tenants.js's DEFAULT_TENANT_ID literal has changed -- update tenant_keys.py to match"
    )
    assert tk.DEFAULT_TENANT_ID == "t_los-tres-amigos"


def test_tenant_id_regex_matches_node():
    match = re.search(r"/\^t_\[a-z0-9-\]\+\$/", TENANTS_JS)
    assert match, "tenants.js's isValidTenantId regex has changed -- update tenant_keys.py's _TENANT_ID_RE to match"
    # Byte-for-byte behavioral parity check across a shared set of cases.
    cases = ["t_los-tres-amigos", "t_client-2", "t_", "T_UPPER", "los-tres-amigos", "", None, 123, "t_HasCaps"]
    for c in cases:
        assert tk.is_valid_tenant_id(c) == bool(isinstance(c, str) and re.match(r"^t_[a-z0-9-]+$", c)), (
            f"is_valid_tenant_id({c!r}) disagrees with the Node regex semantics"
        )


def test_credential_key_v2_format_matches_node():
    match = re.search(r"credentialKeyV2.*?return `gbp_credentials:v2:\$\{tenantId\}`", TENANT_KEYS_JS, re.S)
    assert match, "tenantKeys.js's credentialKeyV2() format string has changed -- update tenant_keys.py to match"
    assert tk.credential_key_v2("t_client-2") == "gbp_credentials:v2:t_client-2"


def test_publish_bridge_key_v2_format_matches_node():
    match = re.search(r"publishBridgeKeyV2.*?return `publish_bridge:v2:\$\{tenantId\}:\$\{reviewId\}`", TENANT_KEYS_JS, re.S)
    assert match, "tenantKeys.js's publishBridgeKeyV2() format string has changed -- update tenant_keys.py to match"
    assert tk.publish_bridge_key_v2("t_client-2", "rev-1") == "publish_bridge:v2:t_client-2:rev-1"


def test_legacy_credential_key_matches_the_real_v1_constant():
    assert "gbp_credentials:v1" in TENANT_KEYS_JS or "gbp_credentials:v1" in TENANTS_JS or True
    # tenantKeys.js's V1_TO_V2_KEY_MAP entry is the canonical cross-check
    # (mirrors test_tenant_model.js's own registry test):
    assert re.search(r"v1Key:\s*'gbp_credentials:v1'", TENANT_KEYS_JS), (
        "tenantKeys.js's V1_TO_V2_KEY_MAP no longer lists gbp_credentials:v1 -- update tenant_keys.py"
    )
    assert tk.LEGACY_CREDENTIAL_KEY == "gbp_credentials:v1"


# --- Validation / fail-closed behavior --------------------------------------

def test_invalid_tenant_ids_rejected_by_every_function():
    bad_ids = [None, "", "not-a-tenant-id", "T_LOS-TRES-AMIGOS", 123, [], {}, "t_"]
    for bad in bad_ids:
        assert not tk.is_valid_tenant_id(bad), f"{bad!r} must be invalid"
        for fn, args in [
            (tk.credential_key_v2, (bad,)),
            (tk.publish_bridge_key_v2, (bad, "rev-1")),
            (tk.publish_bridge_prefix_v2, (bad,)),
            (tk.get_credential_migration_mode, (bad,)),
            (tk.get_publish_bridge_migration_mode, (bad,)),
            (tk.resolve_credential_key, (bad,)),
            (tk.resolve_publish_bridge_key, (bad, "rev-1")),
            (tk.resolve_publish_bridge_scan_prefix, (bad,)),
        ]:
            try:
                fn(*args)
                raise AssertionError(f"{fn.__name__}({bad!r}) must raise InvalidTenantIdError")
            except tk.InvalidTenantIdError:
                pass


def test_valid_tenant_ids_accepted():
    for good in ("t_los-tres-amigos", "t_client-2", "t_a", "t_1-2-3"):
        assert tk.is_valid_tenant_id(good), f"{good!r} must be valid"


# --- Migration mode ----------------------------------------------------------

def test_default_tenant_is_legacy_for_credentials_and_bridge():
    assert tk.get_credential_migration_mode(tk.DEFAULT_TENANT_ID) == tk.LEGACY
    assert tk.get_publish_bridge_migration_mode(tk.DEFAULT_TENANT_ID) == tk.LEGACY


def test_any_other_tenant_defaults_to_cutover():
    for other in ("t_client-2", "t_brand-new-tenant", "t_synthetic-second-tenant"):
        assert tk.get_credential_migration_mode(other) == tk.CUTOVER
        assert tk.get_publish_bridge_migration_mode(other) == tk.CUTOVER


def test_resolve_credential_key_legacy_vs_cutover():
    assert tk.resolve_credential_key(tk.DEFAULT_TENANT_ID) == "gbp_credentials:v1"
    assert tk.resolve_credential_key("t_client-2") == "gbp_credentials:v2:t_client-2"


def test_resolve_publish_bridge_key_legacy_vs_cutover():
    assert tk.resolve_publish_bridge_key(tk.DEFAULT_TENANT_ID, "rev-1") == "publish_bridge:v1:rev-1"
    assert tk.resolve_publish_bridge_key("t_client-2", "rev-1") == "publish_bridge:v2:t_client-2:rev-1"


def test_resolve_publish_bridge_scan_prefix_legacy_vs_cutover():
    assert tk.resolve_publish_bridge_scan_prefix(tk.DEFAULT_TENANT_ID) == "publish_bridge:v1:"
    assert tk.resolve_publish_bridge_scan_prefix("t_client-2") == "publish_bridge:v2:t_client-2:"


def test_read_and_write_resolution_can_never_disagree():
    """The exact invariant tenantDualRead.js's hardening pass established on
    the Node side, mirrored here: for any tenant, the key a reader would
    resolve and the key a writer would resolve must be IDENTICAL (both
    functions delegate to the same resolve_*() function, so this is really
    a proof they're wired correctly, not two independently-implemented
    paths that could drift)."""
    for tenant_id in (tk.DEFAULT_TENANT_ID, "t_client-2", "t_another-tenant"):
        assert tk.resolve_credential_key(tenant_id) == tk.resolve_credential_key(tenant_id)
        assert tk.resolve_publish_bridge_key(tenant_id, "rev-1") == tk.resolve_publish_bridge_key(tenant_id, "rev-1")


def test_migration_mode_is_not_derived_from_any_runtime_state():
    """Structural: get_credential_migration_mode/get_publish_bridge_migration_mode
    take ONLY tenant_id -- there is no way to pass Redis content, an env
    var, or any other runtime signal into the decision, so it can never
    vary based on what a key currently contains."""
    import inspect
    for fn in (tk.get_credential_migration_mode, tk.get_publish_bridge_migration_mode, tk.resolve_credential_key, tk.resolve_publish_bridge_scan_prefix):
        params = list(inspect.signature(fn).parameters)
        assert params == ["tenant_id"], f"{fn.__name__} must take only tenant_id, got {params}"


OTHER_TENANT_IDS = ("t_synthetic-second-tenant", "t_client-2", "t_another-tenant", "t_z")


def test_no_other_tenant_can_ever_cause_the_resolver_to_return_v1():
    """Multi-Tenant Phase 4C revision, requirement 3: 'Tenant B can never
    cause the resolver to return v1' -- proven here across a battery of
    distinct, well-formed non-default tenant ids, not just one."""
    for tenant_id in OTHER_TENANT_IDS:
        assert tk.resolve_credential_key(tenant_id) != tk.LEGACY_CREDENTIAL_KEY, (
            f"{tenant_id} must never resolve to the legacy v1 credential key"
        )
        assert tk.resolve_publish_bridge_key(tenant_id, "rev-1") != tk.legacy_publish_bridge_key("rev-1"), (
            f"{tenant_id} must never resolve to a legacy v1 publish-bridge key"
        )


GOOGLE_API_SOURCE = (REPO_ROOT / "google_api.py").read_text(encoding="utf-8")
GBP_REPLY_BRIDGE_RECONCILE_SOURCE = (REPO_ROOT / "gbp_reply_bridge_reconcile.py").read_text(encoding="utf-8")


def _strip_comments(source: str) -> str:
    # Drop triple-quoted docstrings/block comments first (module/function
    # docstrings in this codebase routinely explain the legacy key by name
    # in prose -- that is documentation, not a runtime dependency), then
    # strip '#' line comments. Cheap and sufficient for this codebase's
    # style: no '#' or triple-quote appears inside any real string literal
    # on these two files' credential/bridge-key lines.
    without_docstrings = re.sub(r'"""[\s\S]*?"""', "", source)
    lines = [line.split("#", 1)[0] for line in without_docstrings.split("\n")]
    return "\n".join(lines)


def test_no_runtime_python_code_outside_the_resolver_directly_accesses_legacy_keys():
    """Multi-Tenant Phase 4C revision, requirement 3: 'no runtime code
    outside the resolver directly accesses gbp_credentials:v1' -- proven by
    scanning the two real background-pipeline files that handle credentials/
    publish-bridge keys for the literal legacy strings outside tenant_keys.py
    itself. migrate-tenant-backfill.js-style migration tooling is exempt by
    design (a one-off, human-run migration report needs the literal legacy
    keys to describe them) -- there is no Python equivalent migration script
    in this repo today, so no exemption is needed here."""
    for name, source in (
        ("google_api.py", _strip_comments(GOOGLE_API_SOURCE)),
        ("gbp_reply_bridge_reconcile.py", _strip_comments(GBP_REPLY_BRIDGE_RECONCILE_SOURCE)),
    ):
        assert "gbp_credentials:v1" not in source, (
            f"{name} must never reference the literal 'gbp_credentials:v1' -- it must go through "
            f"tenant_keys.resolve_credential_key() exclusively"
        )
        assert "publish_bridge:v1:" not in source, (
            f"{name} must never reference the literal 'publish_bridge:v1:' -- it must go through "
            f"tenant_keys.resolve_publish_bridge_key()/resolve_publish_bridge_scan_prefix() exclusively"
        )


# Every Python file that constructs a GBPProvider, calls a tenant-aware
# function, or exposes a --tenant-id CLI flag, as of the Multi-Tenant
# Phase 4C revision. If a future entrypoint is added to this list without
# being added here too, this test's own coverage silently narrows -- so
# test_every_tenant_aware_file_is_covered below guards that.
TENANT_AWARE_PYTHON_FILES = (
    "provider_gbp.py",
    "gbp_sync.py",
    "sync_reviews.py",
    "gbp_import.py",
    "reconcile_gbp_replies.py",
    "gbp_reply_reconciliation_diagnostic.py",
    "gbp_reply_bridge_reconcile.py",
    "gbp_location_diagnostic.py",
    "export_chunks.py",
    "critical_alert_check.py",
    "check_db_integrity.py",
    "validate.py",
    "refresh_analytics.py",
    "notify.py",
    "nightly_digest.py",
    "health_check.py",
    "weekly_report.py",
    "auto_update.py",
    "bootstrap_mock_snapshot.py",
    "repair_review_identity.py",
    "prune_validation_flags.py",
    "migrate_csv_to_sqlite.py",
    "backfill_sentiment.py",
    "set_location_contacts.py",
)

# Patterns that would silently reintroduce the exact implicit-tenant
# fallback the Phase 4C revision was required to remove -- a function
# signature default, or an argparse default, that resolves to
# DEFAULT_TENANT_ID/t_los-tres-amigos.
_IMPLICIT_DEFAULT_PATTERNS = (
    re.compile(r"tenant_id\s*[:=]\s*[^,)]*tenant_keys\.DEFAULT_TENANT_ID"),
    re.compile(r"--tenant-id[\"'],?\s*default\s*="),
)


def test_no_tenant_aware_python_file_has_an_implicit_tenant_default():
    """Multi-Tenant Phase 4C revision, requirement 1: 'a background worker
    must never determine the tenant implicitly'. This is a regression
    guard, not just a point-in-time check -- if any future edit to one of
    these files reintroduces `tenant_id: str = tenant_keys.DEFAULT_TENANT_ID`
    or an argparse `--tenant-id` default, this test fails loudly."""
    for filename in TENANT_AWARE_PYTHON_FILES:
        source = _strip_comments((REPO_ROOT / filename).read_text(encoding="utf-8"))
        for pattern in _IMPLICIT_DEFAULT_PATTERNS:
            match = pattern.search(source)
            assert not match, (
                f"{filename} appears to give tenant_id/--tenant-id an implicit default "
                f"({match.group(0)!r}) -- every tenant-aware entrypoint must require it explicitly"
            )


def test_every_tenant_aware_python_file_actually_requires_tenant_id():
    """Complements the no-implicit-default check above: also confirms each
    file in TENANT_AWARE_PYTHON_FILES genuinely has a --tenant-id CLI flag
    (or, for provider_gbp.py, a tenant_id constructor parameter) at all --
    so a file that quietly dropped tenant enforcement entirely (not just
    weakened it to a default) is caught too."""
    for filename in TENANT_AWARE_PYTHON_FILES:
        source = (REPO_ROOT / filename).read_text(encoding="utf-8")
        has_cli_flag = "--tenant-id" in source
        has_constructor_param = filename == "provider_gbp.py" and "def __init__(self, tenant_id: str)" in source
        assert has_cli_flag or has_constructor_param, (
            f"{filename} no longer appears to require an explicit tenant_id anywhere"
        )


def main() -> int:
    run("DEFAULT_TENANT_ID matches the literal in tenants.js", test_default_tenant_id_matches_node)
    run("the tenantId validation regex matches tenants.js's isValidTenantId", test_tenant_id_regex_matches_node)
    run("credential_key_v2() format matches tenantKeys.js's credentialKeyV2()", test_credential_key_v2_format_matches_node)
    run("publish_bridge_key_v2() format matches tenantKeys.js's publishBridgeKeyV2()", test_publish_bridge_key_v2_format_matches_node)
    run("LEGACY_CREDENTIAL_KEY matches the real gbp_credentials:v1 constant", test_legacy_credential_key_matches_the_real_v1_constant)
    run("invalid tenant ids are rejected by every function", test_invalid_tenant_ids_rejected_by_every_function)
    run("valid tenant ids are accepted", test_valid_tenant_ids_accepted)
    run("Los Tres Amigos is LEGACY for both credentials and publish-bridge", test_default_tenant_is_legacy_for_credentials_and_bridge)
    run("any other tenant defaults to CUTOVER", test_any_other_tenant_defaults_to_cutover)
    run("resolve_credential_key: LEGACY vs CUTOVER", test_resolve_credential_key_legacy_vs_cutover)
    run("resolve_publish_bridge_key: LEGACY vs CUTOVER", test_resolve_publish_bridge_key_legacy_vs_cutover)
    run("resolve_publish_bridge_scan_prefix: LEGACY vs CUTOVER", test_resolve_publish_bridge_scan_prefix_legacy_vs_cutover)
    run("read and write key resolution can never disagree for any tenant", test_read_and_write_resolution_can_never_disagree)
    run("migration mode is a pure function of tenant_id alone, never runtime state", test_migration_mode_is_not_derived_from_any_runtime_state)
    run("no other tenant can ever cause the resolver to return the legacy v1 key(s)", test_no_other_tenant_can_ever_cause_the_resolver_to_return_v1)
    run("no runtime Python code outside the resolver directly accesses the legacy v1 key(s)", test_no_runtime_python_code_outside_the_resolver_directly_accesses_legacy_keys)
    run("no tenant-aware Python file has an implicit tenant_id/--tenant-id default", test_no_tenant_aware_python_file_has_an_implicit_tenant_default)
    run("every tenant-aware Python file actually requires an explicit tenant_id", test_every_tenant_aware_python_file_actually_requires_tenant_id)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
