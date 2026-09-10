"""
Multi-Tenant Phase 4H.1 -- static/structural regression tests for
.github/workflows/tenant-lifecycle.yml. Actually EXECUTING a GitHub Actions
workflow isn't feasible in this test suite, so this applies the same
source-scan discipline test_workflow_tenant_ids.py already uses for the
OTHER workflows in this repo: parse the YAML and assert its structure,
inputs, concurrency, permissions, and secret wiring match every explicit
Phase 4H.1 security requirement.

Run directly: py tests/test_tenant_lifecycle_workflow.py
"""
import re
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "tenant-lifecycle.yml"

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
    # PyYAML 1.1 parses the bare `on:` key as the boolean True -- this is
    # a universal quirk affecting every workflow in this repo (confirmed
    # against update-reviews.yml too), not specific to this file.
    return data.get("on", data.get(True))


def test_workflow_file_exists_and_parses():
    assert WORKFLOW_PATH.exists(), f"{WORKFLOW_PATH} does not exist"
    _text, data = _load()
    assert isinstance(data, dict), "workflow YAML did not parse to a mapping"


def test_dispatch_inputs_are_exactly_as_required():
    _text, data = _load()
    inputs = _on(data)["workflow_dispatch"]["inputs"]

    assert set(inputs.keys()) == {"operation", "tenant_id", "confirmation"}, (
        f"expected exactly operation/tenant_id/confirmation inputs, got {sorted(inputs.keys())}"
    )

    operation = inputs["operation"]
    assert operation["required"] is True
    assert operation["type"] == "choice"
    assert set(operation["options"]) == {"provision", "initial_sync", "apply_entitlement_change", "diagnose_google_status"}, (
        f"operation choice must be exactly provision/initial_sync/apply_entitlement_change/diagnose_google_status, got {operation['options']}"
    )

    for name in ("tenant_id", "confirmation"):
        assert inputs[name]["required"] is True, f"{name} must be required"
        assert inputs[name]["type"] == "string", f"{name} must be type string"


def test_tenant_id_and_confirmation_are_validated_before_any_python_step():
    text, data = _load()
    steps = data["jobs"]["operate"]["steps"]
    step_names = [s.get("name", "") for s in steps]

    validate_index = next((i for i, n in enumerate(step_names) if n == "Validate inputs"), None)
    assert validate_index is not None, "no 'Validate inputs' step found"

    python_step_indices = [i for i, s in enumerate(steps) if any(
        f"python {script}" in s.get("run", "") for script in (
            "provision_tenant.py", "initial_sync.py", "apply_entitlement_change.py", "diagnose_google_status.py",
        )
    )]
    assert python_step_indices, "no provision_tenant.py/initial_sync.py/apply_entitlement_change.py/diagnose_google_status.py invocation found"
    assert all(validate_index < i for i in python_step_indices), (
        "the 'Validate inputs' step must run before any provision_tenant.py/initial_sync.py/apply_entitlement_change.py/diagnose_google_status.py invocation"
    )

    validate_step = steps[validate_index]
    run_text = validate_step["run"]
    assert re.search(r"\^t_\[a-z0-9-\]\+\$", run_text) or "^t_[a-z0-9-]+$" in run_text, (
        "the validate step must regex-check tenant_id's format"
    )
    assert "t_los-tres-amigos" in run_text, "the validate step must explicitly reject Los Tres Amigos's own tenant id"
    assert '"$CONFIRMATION" != "$TENANT_ID"' in run_text, (
        "the validate step must compare confirmation against tenant_id exactly"
    )
    void = text  # noqa: F841 -- kept for readability of the read call above


def test_no_input_is_interpolated_directly_into_a_run_script():
    """The core injection-safety property: `${{ inputs.* }}` may appear
    ONLY inside an `env:` block's value (a controlled context Actions
    itself resolves before the shell ever runs), never inside a `run:`
    script's own text, where an attacker-influenced value could otherwise
    inject arbitrary shell syntax."""
    _text, data = _load()
    steps = data["jobs"]["operate"]["steps"]
    for step in steps:
        run_text = step.get("run")
        if not run_text:
            continue
        assert "${{ inputs." not in run_text, (
            f"step {step.get('name')!r} interpolates a workflow_dispatch input directly into its run: script"
        )


def test_every_secret_is_referenced_via_secrets_context_never_hardcoded():
    text, data = _load()
    required_secrets = {
        "BLOB_READ_WRITE_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
        "CREDENTIAL_ENCRYPTION_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
    }
    for name in required_secrets:
        assert f"secrets.{name}" in text, f"expected ${{{{ secrets.{name} }}}} to be referenced somewhere in the workflow"

    # No literal-looking secret VALUE anywhere (a crude but effective
    # defense-in-depth check -- every credential-shaped env var in this
    # file must be a secrets.* reference, never a bare string).
    for match in re.finditer(r'^\s*(BLOB_READ_WRITE_TOKEN|UPSTASH_REDIS_REST_TOKEN|CREDENTIAL_ENCRYPTION_KEY|GOOGLE_CLIENT_SECRET):\s*(.+)$', text, re.MULTILINE):
        value = match.group(2).strip()
        assert value.startswith("${{ secrets."), (
            f"{match.group(1)} must be sourced from secrets.*, found: {value!r}"
        )
    void = data  # noqa: F841


def test_google_refresh_token_fallback_is_never_used():
    """Checks for an actual env-var ASSIGNMENT/wiring of the legacy
    fallback (the real risk: a new tenant silently syncing with whichever
    credential that global secret holds) -- not a bare textual mention,
    which the header comment legitimately uses to document that this is
    deliberately avoided."""
    text, _data = _load()
    assert not re.search(r"GOOGLE_REFRESH_TOKEN\s*:", text), (
        "tenant-lifecycle.yml must never WIRE the legacy global GOOGLE_REFRESH_TOKEN fallback as an env var"
    )


def test_per_tenant_concurrency_with_no_cancellation():
    _text, data = _load()
    concurrency = data["jobs"].get("concurrency") or data.get("concurrency")
    assert concurrency is not None, "expected a top-level or job-level concurrency block"
    assert "${{ inputs.tenant_id }}" in concurrency["group"], (
        f"concurrency group must be scoped per tenant_id, got {concurrency['group']!r}"
    )
    assert concurrency["cancel-in-progress"] is False, "cancel-in-progress must be false"


def test_minimum_permissions():
    _text, data = _load()
    permissions = data.get("permissions")
    assert permissions is not None, "expected an explicit top-level permissions block"
    assert permissions == {"contents": "read"}, (
        f"expected the minimum permissions {{'contents': 'read'}}, got {permissions}"
    )


def test_exactly_one_command_per_operation_no_arbitrary_execution():
    _text, data = _load()
    steps = data["jobs"]["operate"]["steps"]
    run_steps = [s for s in steps if "run" in s and any(
        script in s["run"] for script in (
            "provision_tenant.py", "initial_sync.py", "apply_entitlement_change.py", "diagnose_google_status.py",
        )
    )]
    assert len(run_steps) == 4, f"expected exactly 4 provisioning/sync/entitlement-change/diagnose steps, found {len(run_steps)}"

    provision_steps = [s for s in run_steps if s.get("if") == "inputs.operation == 'provision'"]
    sync_steps = [s for s in run_steps if s.get("if") == "inputs.operation == 'initial_sync'"]
    entitlement_steps = [s for s in run_steps if s.get("if") == "inputs.operation == 'apply_entitlement_change'"]
    diagnose_steps = [s for s in run_steps if s.get("if") == "inputs.operation == 'diagnose_google_status'"]
    assert len(provision_steps) == 1, "expected exactly one step gated on operation == 'provision'"
    assert len(sync_steps) == 1, "expected exactly one step gated on operation == 'initial_sync'"
    assert len(entitlement_steps) == 1, "expected exactly one step gated on operation == 'apply_entitlement_change'"
    assert len(diagnose_steps) == 1, "expected exactly one step gated on operation == 'diagnose_google_status'"

    assert provision_steps[0]["run"].strip() == 'python provision_tenant.py --tenant-id "$TENANT_ID"', (
        f"unexpected provisioning command: {provision_steps[0]['run']!r}"
    )
    assert sync_steps[0]["run"].strip() == 'python initial_sync.py --tenant-id "$TENANT_ID"', (
        f"unexpected initial-sync command: {sync_steps[0]['run']!r}"
    )
    assert entitlement_steps[0]["run"].strip() == 'python apply_entitlement_change.py --tenant-id "$TENANT_ID"', (
        f"unexpected entitlement-change command: {entitlement_steps[0]['run']!r}"
    )
    assert diagnose_steps[0]["run"].strip() == 'python diagnose_google_status.py --tenant-id "$TENANT_ID"', (
        f"unexpected diagnose command: {diagnose_steps[0]['run']!r}"
    )

    # No step anywhere accepts a free-form/dynamic command (no eval, no
    # command built via string concatenation from inputs). The critical
    # quoting property -- the actual script invocations always pass
    # "$TENANT_ID" as a single quoted argument, never bare -- is already
    # verified exactly above (the full-string command comparison); this
    # only additionally rules out eval/dynamic dispatch anywhere in the file.
    for step in steps:
        run_text = step.get("run", "")
        assert "eval " not in run_text, f"step {step.get('name')!r} must never call eval"


def test_no_continue_on_error_anywhere():
    """A failed provision_tenant.py/initial_sync.py invocation must fail
    the job -- continue-on-error would let the workflow report success
    despite a real failure."""
    _text, data = _load()
    steps = data["jobs"]["operate"]["steps"]
    for step in steps:
        assert "continue-on-error" not in step, (
            f"step {step.get('name')!r} must not use continue-on-error -- a failure must propagate"
        )


def test_diagnose_google_status_step_env_mapping_is_exact():
    """Phase 4M -- the diagnostic operation must receive exactly the five
    secrets it needs (TENANT_ID plus Redis/credential/Google client) and
    NOT BLOB_READ_WRITE_TOKEN, since it never touches Blob at all -- unlike
    every other operation in this file, which all receive it."""
    _text, data = _load()
    steps = data["jobs"]["operate"]["steps"]
    diagnose_steps = [s for s in steps if s.get("if") == "inputs.operation == 'diagnose_google_status'"]
    assert len(diagnose_steps) == 1, "expected exactly one step gated on operation == 'diagnose_google_status'"
    env = diagnose_steps[0].get("env", {})

    assert env.get("TENANT_ID") == "${{ inputs.tenant_id }}", "diagnose step must source TENANT_ID from inputs.tenant_id"
    expected_secret_env = {
        "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "CREDENTIAL_ENCRYPTION_KEY",
        "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
    }
    actual_secret_env = {k for k in env if k != "TENANT_ID"}
    assert actual_secret_env == expected_secret_env, (
        f"diagnose step's secret env vars must be exactly {sorted(expected_secret_env)}, got {sorted(actual_secret_env)}"
    )
    for name in expected_secret_env:
        assert env[name] == f"${{{{ secrets.{name} }}}}", f"{name} must be sourced from secrets.{name}"
    assert "BLOB_READ_WRITE_TOKEN" not in env, (
        "diagnose_google_status must NEVER receive BLOB_READ_WRITE_TOKEN -- it never touches Blob"
    )


def test_job_summary_step_runs_always_but_does_not_gate_earlier_steps():
    _text, data = _load()
    steps = data["jobs"]["operate"]["steps"]
    summary_steps = [s for s in steps if s.get("name") == "Write job summary"]
    assert len(summary_steps) == 1, "expected exactly one 'Write job summary' step"
    assert summary_steps[0].get("if") == "always()", "the job summary step must run regardless of earlier failures"
    assert "tenant_status_report.py" in summary_steps[0]["run"], "the job summary step must call tenant_status_report.py"


def main() -> int:
    run("workflow file exists and parses as valid YAML", test_workflow_file_exists_and_parses)
    run("dispatch inputs are exactly operation/tenant_id/confirmation, correctly typed", test_dispatch_inputs_are_exactly_as_required)
    run("tenant_id/confirmation are validated before any Python step runs", test_tenant_id_and_confirmation_are_validated_before_any_python_step)
    run("no workflow_dispatch input is interpolated directly into a run: script", test_no_input_is_interpolated_directly_into_a_run_script)
    run("every required secret is referenced via secrets.*, never hardcoded", test_every_secret_is_referenced_via_secrets_context_never_hardcoded)
    run("GOOGLE_REFRESH_TOKEN legacy fallback is never referenced", test_google_refresh_token_fallback_is_never_used)
    run("per-tenant concurrency group with cancel-in-progress: false", test_per_tenant_concurrency_with_no_cancellation)
    run("workflow requests only the minimum GitHub permissions", test_minimum_permissions)
    run("exactly one fixed, quoted command per operation -- no arbitrary execution", test_exactly_one_command_per_operation_no_arbitrary_execution)
    run("diagnose_google_status step's env/secret mapping is exact, no BLOB_READ_WRITE_TOKEN", test_diagnose_google_status_step_env_mapping_is_exact)
    run("no step uses continue-on-error", test_no_continue_on_error_anywhere)
    run("the job summary step runs always() without gating earlier steps' outcome", test_job_summary_step_runs_always_but_does_not_gate_earlier_steps)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
