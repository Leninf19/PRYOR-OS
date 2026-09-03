"""
Static + behavioral regression tests for
.github/workflows/tenant-lifecycle-dispatch.yml -- the small, main-branch-
only dispatcher that checks out ONE pinned, immutable commit from
feature/multi-tenant-pryor to run the real tenant-lifecycle scripts with
production secrets.

Two classes of test:
  - Static (parse the YAML, assert structure/wiring) -- same discipline as
    feature/multi-tenant-pryor's own test_tenant_lifecycle_workflow.py.
  - Behavioral (actually EXECUTE the "Validate inputs" step's shell script
    via a real subprocess, with various inputs) -- proves the allowlist/
    regex/LTA/confirmation checks genuinely reject bad input, not just
    that the text superficially looks right.

Run directly: py tests/test_tenant_lifecycle_dispatch_workflow.py
"""
import subprocess
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "tenant-lifecycle-dispatch.yml"
APPROVED_SHA = "6add19e956ba57af16b67a06dcf5e93d571e83d9"

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except AssertionError as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def _load():
    text = WORKFLOW_PATH.read_text(encoding="utf-8")
    data = yaml.safe_load(text)
    return text, data


def _on(data):
    return data.get("on", data.get(True))


def _steps(data):
    return data["jobs"]["operate"]["steps"]


def _validate_step(data):
    steps = _steps(data)
    step = next((s for s in steps if s.get("name") == "Validate inputs"), None)
    assert step is not None, "no 'Validate inputs' step found"
    return step


def _run_validate_shell(run_script, operation, tenant_id, confirmation):
    """Executes the EXACT shell text from the 'Validate inputs' step's
    run: block in a real subprocess, with OPERATION/TENANT_ID/CONFIRMATION
    set exactly as the workflow's own env: block would set them. Returns
    the CompletedProcess."""
    env = {"OPERATION": operation, "TENANT_ID": tenant_id, "CONFIRMATION": confirmation}
    return subprocess.run(["bash", "-c", run_script], env=env, capture_output=True, text=True)


# ===========================================================================
# 1. checkout ref is the literal approved SHA
# ===========================================================================

def test_checkout_ref_is_the_literal_approved_sha():
    _text, data = _load()
    steps = _steps(data)
    checkout = steps[0]
    assert checkout.get("uses", "").startswith("actions/checkout@"), "the first step must be actions/checkout"
    ref = checkout["with"]["ref"]
    assert ref == "${{ env.PINNED_LIFECYCLE_SHA }}", f"checkout ref must reference env.PINNED_LIFECYCLE_SHA, got {ref!r}"
    pinned = data["env"]["PINNED_LIFECYCLE_SHA"]
    assert pinned == APPROVED_SHA, f"PINNED_LIFECYCLE_SHA must be the approved {APPROVED_SHA}, got {pinned!r}"
    assert len(str(pinned)) == 40, "the pinned value must be a full 40-character commit SHA, never a short SHA or branch name"


# ===========================================================================
# 2. no ref/branch/SHA input exists
# ===========================================================================

def test_no_ref_branch_or_sha_input_exists():
    _text, data = _load()
    inputs = _on(data)["workflow_dispatch"]["inputs"]
    assert set(inputs.keys()) == {"operation", "tenant_id", "confirmation"}, (
        f"expected exactly operation/tenant_id/confirmation inputs, got {sorted(inputs.keys())} -- "
        "a ref/branch/sha input would let a caller choose what code runs with production secrets"
    )
    text, _data = _load()
    assert "inputs.ref" not in text and "inputs.branch" not in text and "inputs.sha" not in text


# ===========================================================================
# 3. unsupported operation fails (behavioral)
# ===========================================================================

def test_unsupported_operation_fails_shell_allowlist():
    _text, data = _load()
    run_script = _validate_step(data)["run"]
    for bad_op in ("delete_tenant", "provision; rm -rf /", "PROVISION", "", "diagnose_google_status; echo pwned"):
        result = _run_validate_shell(run_script, bad_op, "t_ok", "t_ok")
        assert result.returncode != 0, f"operation {bad_op!r} must be rejected by the shell allowlist"

    for good_op in ("diagnose_google_status", "provision", "initial_sync", "apply_entitlement_change", "redis_identity_probe", "credential_key_audit"):
        result = _run_validate_shell(run_script, good_op, "t_ok", "t_ok")
        assert result.returncode == 0, f"operation {good_op!r} must be accepted, got: {result.stderr}"


# ===========================================================================
# 4. malformed tenant fails (behavioral)
# ===========================================================================

def test_malformed_tenant_id_fails():
    _text, data = _load()
    run_script = _validate_step(data)["run"]
    for bad in ("not-a-tenant", "t_../../etc", "T_UpperCase", "t_has spaces", "t_semi;colon"):
        result = _run_validate_shell(run_script, "provision", bad, bad)
        assert result.returncode != 0, f"tenant_id {bad!r} must be rejected"


# ===========================================================================
# 5. LTA fails (behavioral)
# ===========================================================================

def test_los_tres_amigos_is_rejected():
    _text, data = _load()
    run_script = _validate_step(data)["run"]
    result = _run_validate_shell(run_script, "provision", "t_los-tres-amigos", "t_los-tres-amigos")
    assert result.returncode != 0, "t_los-tres-amigos must always be rejected, even with a matching confirmation"


# ===========================================================================
# 6. confirmation mismatch fails (behavioral)
# ===========================================================================

def test_confirmation_mismatch_fails():
    _text, data = _load()
    run_script = _validate_step(data)["run"]
    result = _run_validate_shell(run_script, "provision", "t_pilot-a", "t_pilot-b")
    assert result.returncode != 0, "a mismatched confirmation must be rejected"


def test_matching_confirmation_and_valid_input_succeeds():
    _text, data = _load()
    run_script = _validate_step(data)["run"]
    result = _run_validate_shell(run_script, "diagnose_google_status", "t_blue-seafood-grill", "t_blue-seafood-grill")
    assert result.returncode == 0, f"a fully valid dispatch must be accepted, got: {result.stderr}"


# ===========================================================================
# 7. failed validation cannot reach any secret-bearing step
# ===========================================================================

def test_validate_step_has_an_id_every_secret_step_can_reference():
    _text, data = _load()
    assert _validate_step(data).get("id") == "validate", "the 'Validate inputs' step must have id: validate"


def test_operation_steps_have_no_always_override():
    """The four operation steps rely on GitHub Actions' own default
    behavior (a plain `if:` implicitly requires success() of every prior
    step) -- none of them may use always()/failure(), which would let
    them run even after Validate inputs failed."""
    _text, data = _load()
    steps = _steps(data)
    operation_steps = [s for s in steps if s.get("if", "").startswith("inputs.operation ==")]
    assert len(operation_steps) == 6, f"expected exactly 6 operation-gated steps, found {len(operation_steps)}"
    for s in operation_steps:
        cond = s["if"]
        assert "always()" not in cond and "failure()" not in cond, (
            f"step {s.get('name')!r} must not override the default success()-required behavior, got if: {cond!r}"
        )


def test_secret_bearing_summary_only_runs_after_successful_validation():
    _text, data = _load()
    steps = _steps(data)
    summary_steps = [s for s in steps if s.get("name") == "Write job summary"]
    assert len(summary_steps) == 1, "expected exactly one 'Write job summary' step"
    cond = summary_steps[0]["if"]
    assert "steps.validate.outcome == 'success'" in cond, (
        f"the secret-bearing summary step must require steps.validate.outcome == 'success', got if: {cond!r}"
    )
    # And it must actually carry secrets + call tenant_status_report.py --
    # otherwise this test would trivially pass against a step that no
    # longer does anything.
    env = summary_steps[0].get("env", {})
    assert any(v.startswith("${{ secrets.") for v in env.values()), "the summary step must still carry production secrets"
    assert "tenant_status_report.py" in summary_steps[0]["run"]


def test_failure_summary_step_carries_no_secrets_and_invokes_no_script():
    _text, data = _load()
    steps = _steps(data)
    failure_steps = [s for s in steps if s.get("name") == "Write validation-failure summary"]
    assert len(failure_steps) == 1, "expected exactly one 'Write validation-failure summary' step"
    step = failure_steps[0]
    assert "steps.validate.outcome == 'failure'" in step["if"]
    assert "env" not in step, "the failure-path summary must never declare an env: block (no secrets available to leak)"
    assert "secrets." not in step["run"], "the failure-path summary must never reference secrets.*"
    assert ".py" not in step["run"], "the failure-path summary must never invoke any tenant-aware Python script"


def test_validation_failure_reaches_no_secret_bearing_step_end_to_end():
    """The concrete, combined proof the three tests above establish
    piecewise: for a rejected dispatch (LTA, malformed, or mismatched),
    the ONLY steps whose `if:` can evaluate true are 'Checkout', 'Validate
    inputs' itself, 'Set up Python', 'Install Python dependencies' (none
    of which carry secrets or run tenant code), and 'Write validation-
    failure summary' (which carries no secrets and runs no script) -- not
    any of the four operation steps, and not the real 'Write job summary'."""
    _text, data = _load()
    steps = _steps(data)
    secret_bearing_step_names = {
        s.get("name") for s in steps
        if any(str(v).startswith("${{ secrets.") for v in s.get("env", {}).values())
    }
    assert secret_bearing_step_names == {
        "Run provisioning", "Run Initial Sync", "Apply entitlement change", "Diagnose Google status",
        "Redis identity probe", "Credential key/schema audit", "Write job summary",
    }, f"unexpected set of secret-bearing steps: {secret_bearing_step_names}"

    for name in secret_bearing_step_names:
        step = next(s for s in steps if s.get("name") == name)
        cond = step.get("if", "")
        is_operation_step = name != "Write job summary"
        if is_operation_step:
            assert "always()" not in cond and "failure()" not in cond, (
                f"secret-bearing step {name!r} must not be reachable after a failed validation"
            )
        else:
            assert "steps.validate.outcome == 'success'" in cond, (
                f"secret-bearing step {name!r} must require successful validation"
            )


# ===========================================================================
# 8. diagnostic receives no Blob secret
# ===========================================================================

def test_diagnose_step_never_receives_blob_secret():
    _text, data = _load()
    steps = _steps(data)
    diagnose = next(s for s in steps if s.get("name") == "Diagnose Google status")
    env = diagnose.get("env", {})
    assert "BLOB_READ_WRITE_TOKEN" not in env, "diagnose_google_status must never receive BLOB_READ_WRITE_TOKEN"


# ===========================================================================
# redis_identity_probe receives ONLY the two Redis secrets
# ===========================================================================

def test_redis_probe_step_receives_only_the_two_redis_secrets():
    _text, data = _load()
    steps = _steps(data)
    probe = next(s for s in steps if s.get("name") == "Redis identity probe")
    env = probe.get("env", {})
    assert set(env.keys()) == {"UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"}, (
        f"redis_identity_probe must receive ONLY the two Redis secrets (no TENANT_ID, no CREDENTIAL_ENCRYPTION_KEY, "
        f"no Google, no Blob), got {sorted(env.keys())}"
    )
    for name in env:
        assert env[name] == f"${{{{ secrets.{name} }}}}"


# ===========================================================================
# credential_key_audit is read-only: no CREDENTIAL_ENCRYPTION_KEY, no
# Google secrets, no Blob secrets -- only TENANT_ID and the two Redis
# secrets (unlike redis_identity_probe, this operation DOES need
# TENANT_ID to compute the tenant-specific key it audits).
# ===========================================================================

def test_credential_audit_step_receives_only_tenant_id_and_redis_secrets():
    _text, data = _load()
    steps = _steps(data)
    audit = next(s for s in steps if s.get("name") == "Credential key/schema audit")
    assert audit["if"] == "inputs.operation == 'credential_key_audit'"
    env = audit.get("env", {})
    assert set(env.keys()) == {"TENANT_ID", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"}, (
        f"credential_key_audit must receive ONLY TENANT_ID and the two Redis secrets (no "
        f"CREDENTIAL_ENCRYPTION_KEY, no Google, no Blob -- it never decrypts anything), got {sorted(env.keys())}"
    )
    assert env["TENANT_ID"] == "${{ inputs.tenant_id }}"
    assert env["UPSTASH_REDIS_REST_URL"] == "${{ secrets.UPSTASH_REDIS_REST_URL }}"
    assert env["UPSTASH_REDIS_REST_TOKEN"] == "${{ secrets.UPSTASH_REDIS_REST_TOKEN }}"
    assert "redis_credential_key_audit.py" in audit["run"]
    assert "always()" not in audit["if"] and "failure()" not in audit["if"], (
        "credential_key_audit must not be reachable after a failed validation"
    )


# ===========================================================================
# 9. provisioning receives no Google secrets
# ===========================================================================

def test_provision_step_never_receives_google_secrets():
    _text, data = _load()
    steps = _steps(data)
    provision = next(s for s in steps if s.get("name") == "Run provisioning")
    env = provision.get("env", {})
    assert "GOOGLE_CLIENT_ID" not in env and "GOOGLE_CLIENT_SECRET" not in env, (
        "provisioning must never receive Google secrets -- it never talks to Google"
    )


# ===========================================================================
# 10. concurrency remains tenant-scoped
# ===========================================================================

def test_concurrency_remains_tenant_scoped():
    _text, data = _load()
    concurrency = data.get("concurrency")
    assert concurrency is not None
    assert "${{ inputs.tenant_id }}" in concurrency["group"]
    assert concurrency["cancel-in-progress"] is False


# ===========================================================================
# Preserved-property checks (explicitly required to remain unchanged)
# ===========================================================================

def test_no_app_or_python_implementation_files_on_main():
    """This test file's own existence proves tests/ already lives on main
    (Los Tres Amigos's own pre-existing suite) -- but none of the
    MULTI-TENANT implementation files may accompany the dispatcher."""
    forbidden = [
        REPO_ROOT / "provision_tenant.py",
        REPO_ROOT / "initial_sync.py",
        REPO_ROOT / "apply_entitlement_change.py",
        REPO_ROOT / "diagnose_google_status.py",
        REPO_ROOT / "tenant_config_store.py",
        REPO_ROOT / "tenant_blob_store.py",
        REPO_ROOT / "dashboard" / "api" / "_lib" / "tenantConfigStore.js",
    ]
    for path in forbidden:
        assert not path.exists(), f"{path} must not be merged into main -- it must only ever be reached via the pinned checkout"


def test_contents_read_only_permission():
    _text, data = _load()
    assert data.get("permissions") == {"contents": "read"}


def main() -> int:
    run("checkout ref is the literal approved 40-char SHA", test_checkout_ref_is_the_literal_approved_sha)
    run("no ref/branch/sha input exists", test_no_ref_branch_or_sha_input_exists)
    run("unsupported operation fails the shell allowlist; approved ones pass", test_unsupported_operation_fails_shell_allowlist)
    run("malformed tenant_id fails", test_malformed_tenant_id_fails)
    run("t_los-tres-amigos is rejected", test_los_tres_amigos_is_rejected)
    run("mismatched confirmation fails", test_confirmation_mismatch_fails)
    run("a fully valid dispatch is accepted", test_matching_confirmation_and_valid_input_succeeds)
    run("'Validate inputs' has id: validate", test_validate_step_has_an_id_every_secret_step_can_reference)
    run("operation steps have no always()/failure() override", test_operation_steps_have_no_always_override)
    run("secret-bearing summary only runs after successful validation", test_secret_bearing_summary_only_runs_after_successful_validation)
    run("failure summary carries no secrets and invokes no script", test_failure_summary_step_carries_no_secrets_and_invokes_no_script)
    run("a failed validation reaches NO secret-bearing step, end to end", test_validation_failure_reaches_no_secret_bearing_step_end_to_end)
    run("diagnose_google_status never receives BLOB_READ_WRITE_TOKEN", test_diagnose_step_never_receives_blob_secret)
    run("redis_identity_probe receives ONLY the two Redis secrets", test_redis_probe_step_receives_only_the_two_redis_secrets)
    run("credential_key_audit receives ONLY TENANT_ID and the two Redis secrets", test_credential_audit_step_receives_only_tenant_id_and_redis_secrets)
    run("provisioning never receives Google secrets", test_provision_step_never_receives_google_secrets)
    run("concurrency remains tenant-scoped with cancel-in-progress: false", test_concurrency_remains_tenant_scoped)
    run("no multi-tenant app/Python implementation file is merged onto main", test_no_app_or_python_implementation_files_on_main)
    run("workflow requests only contents: read", test_contents_read_only_permission)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
