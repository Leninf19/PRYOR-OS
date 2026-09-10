"""
Regression tests for the Multi-Tenant Phase 4C revision's requirement 2:
"Make existing LTA workflows explicit". Every GitHub Actions workflow that
invokes a tenant-aware Python entrypoint (one whose --tenant-id is now
REQUIRED, no default -- see tenant_keys.py/the Phase 4C report) must
explicitly pass --tenant-id, sourced from a single, reviewed,
version-controlled TENANT_ID value -- never from a workflow_dispatch input
or any other user-controlled source.

This is a source-scan test, the same discipline test_tenant_model.js/
test_tenant_keys.py already apply to their own registries: if a workflow
adds a new invocation of a tenant-aware script without wiring --tenant-id,
this test fails loudly rather than letting the omission ship (where the
script itself would then fail closed via argparse's `required=True` --
but catching it here, at review time, is strictly better than catching it
only when the schedule actually fires and the run fails).

Run directly: py tests/test_workflow_tenant_ids.py
"""
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS_DIR = REPO_ROOT / ".github" / "workflows"

# Every Python entrypoint whose --tenant-id is REQUIRED (no default) as of
# the Multi-Tenant Phase 4C/4D revisions.
TENANT_AWARE_SCRIPTS = (
    "sync_reviews.py",
    "export_chunks.py",
    "critical_alert_check.py",
    "gbp_reply_bridge_reconcile.py",
    "gbp_import.py",
    "gbp_location_diagnostic.py",
    "gbp_reply_reconciliation_diagnostic.py",
    "check_db_integrity.py",
    "validate.py",
    "refresh_analytics.py",
    "notify.py",
    "nightly_digest.py",
    "health_check.py",
    "weekly_report.py",
)

# Workflows that never invoke any tenant-aware script -- listed explicitly
# so a newly added workflow with no --tenant-id wiring doesn't silently
# pass this test just because it happens to not reference any of the
# scripts above (see test_every_workflow_is_accounted_for below).
WORKFLOWS_WITH_NO_TENANT_AWARE_SCRIPT = {
    "_scratch2.yml",
    # Multi-Tenant Phase 4H.1: tenant-lifecycle.yml invokes
    # provision_tenant.py/initial_sync.py, NEITHER of which is (or should
    # ever be) in TENANT_AWARE_SCRIPTS above -- those two scripts are
    # deliberately dispatch-driven, built to run for an operator-chosen
    # tenant, unlike every script in that list (which must NEVER accept a
    # dispatch-supplied tenant id). See that workflow's own header comment.
    "tenant-lifecycle.yml",
}

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except AssertionError as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def _workflow_files():
    return sorted(WORKFLOWS_DIR.glob("*.yml"))


def test_every_workflow_invoking_a_tenant_aware_script_declares_tenant_id_env():
    for path in _workflow_files():
        source = path.read_text(encoding="utf-8")
        invokes_tenant_aware = any(f"python {script}" in source for script in TENANT_AWARE_SCRIPTS)
        if not invokes_tenant_aware:
            continue
        assert re.search(r"TENANT_ID:\s*t_los-tres-amigos", source), (
            f"{path.name} invokes a tenant-aware script but never declares "
            f"a reviewed TENANT_ID env value"
        )


def test_every_tenant_aware_invocation_passes_tenant_id_flag():
    for path in _workflow_files():
        source = path.read_text(encoding="utf-8")
        for script in TENANT_AWARE_SCRIPTS:
            for match in re.finditer(re.escape(f"python {script}"), source):
                # The --tenant-id flag must appear somewhere in the same
                # logical run: block -- checked via a generous window
                # (up to 400 chars) after the invocation, which comfortably
                # covers this repo's longest multi-line `run: >` blocks
                # (diagnostic-gbp-reply-reconciliation.yml) without
                # accidentally reaching into an unrelated, later step.
                window = source[match.start():match.start() + 400]
                assert "--tenant-id" in window, (
                    f"{path.name}: invocation of {script} does not pass --tenant-id "
                    f"within the same run block"
                )
                assert '--tenant-id "$TENANT_ID"' in window or "--tenant-id \"$TENANT_ID\"" in window, (
                    f"{path.name}: {script}'s --tenant-id must be sourced from the "
                    f"reviewed $TENANT_ID env value, never a literal or a "
                    f"workflow_dispatch input"
                )


def test_tenant_id_is_never_sourced_from_a_workflow_dispatch_input():
    """The whole point: --tenant-id must come from the job's own reviewed
    env, never from `inputs.*` (a workflow_dispatch caller-supplied value)
    -- otherwise a caller could smuggle a different tenant through the
    dispatch form, exactly the risk Phase 4C's audit flagged for a future
    multi-tenant dispatch design."""
    for path in _workflow_files():
        source = path.read_text(encoding="utf-8")
        for script in TENANT_AWARE_SCRIPTS:
            for match in re.finditer(re.escape(f"python {script}"), source):
                window = source[match.start():match.start() + 400]
                assert "--tenant-id \"${{ inputs." not in window, (
                    f"{path.name}: {script}'s --tenant-id must never be wired to a "
                    f"workflow_dispatch input"
                )


def test_every_workflow_is_accounted_for():
    """Guards the guard: every workflow file must be either in the
    no-tenant-aware-script allowlist above or actually invoke one of
    TENANT_AWARE_SCRIPTS -- so a future script rename/removal that leaves a
    workflow invoking nothing recognizable doesn't silently stop being
    checked by the two tests above."""
    for path in _workflow_files():
        source = path.read_text(encoding="utf-8")
        invokes_tenant_aware = any(f"python {script}" in source for script in TENANT_AWARE_SCRIPTS)
        if path.name in WORKFLOWS_WITH_NO_TENANT_AWARE_SCRIPT:
            assert not invokes_tenant_aware, (
                f"{path.name} is listed as having no tenant-aware script, but it invokes one -- "
                f"update WORKFLOWS_WITH_NO_TENANT_AWARE_SCRIPT"
            )
        else:
            assert invokes_tenant_aware, (
                f"{path.name} is not in the no-tenant-aware-script allowlist, but invokes none of "
                f"{TENANT_AWARE_SCRIPTS} -- add it to WORKFLOWS_WITH_NO_TENANT_AWARE_SCRIPT if that's correct"
            )


def main() -> int:
    run("every workflow invoking a tenant-aware script declares a reviewed TENANT_ID env value",
        test_every_workflow_invoking_a_tenant_aware_script_declares_tenant_id_env)
    run("every tenant-aware invocation passes --tenant-id sourced from that reviewed value",
        test_every_tenant_aware_invocation_passes_tenant_id_flag)
    run("--tenant-id is never sourced from a workflow_dispatch input",
        test_tenant_id_is_never_sourced_from_a_workflow_dispatch_input)
    run("every workflow file is accounted for by the tenant-aware-script allowlist",
        test_every_workflow_is_accounted_for)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
