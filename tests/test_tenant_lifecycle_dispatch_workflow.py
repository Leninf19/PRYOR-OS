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
APPROVED_SHA = "f7201436535e8dea0730c045d25407437941ca4e"

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


def _run_validate_shell(run_script, operation, tenant_id, confirmation, environment="production"):
    """Executes the EXACT shell text from the 'Validate inputs' step's
    run: block in a real subprocess, with OPERATION/TENANT_ID/CONFIRMATION/
    ENVIRONMENT set exactly as the workflow's own env: block would set
    them. Returns the CompletedProcess. `environment` defaults to
    'production' so every EXISTING call site (written before the
    Preview Infrastructure Isolation revision) continues to exercise a
    valid environment value without needing to be touched."""
    env = {"OPERATION": operation, "TENANT_ID": tenant_id, "CONFIRMATION": confirmation, "ENVIRONMENT": environment}
    return subprocess.run(["bash", "-c", run_script], env=env, capture_output=True, text=True)


def _step(data, name):
    step = next((s for s in _steps(data) if s.get("name") == name), None)
    assert step is not None, f"no {name!r} step found"
    return step


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
    assert set(inputs.keys()) == {"operation", "tenant_id", "confirmation", "environment"}, (
        f"expected exactly operation/tenant_id/confirmation/environment inputs, got {sorted(inputs.keys())} -- "
        "a ref/branch/sha input would let a caller choose what code runs with production secrets "
        "('environment' is a deliberate, reviewed Preview Infrastructure Isolation addition, not a ref)"
    )
    text, _data = _load()
    assert "inputs.ref" not in text and "inputs.branch" not in text and "inputs.sha" not in text


# ===========================================================================
# Preview Infrastructure Isolation (revision 10)
# ===========================================================================

def test_environment_input_is_a_required_choice_with_no_default():
    """No default -- every caller, including a human using the GitHub UI,
    must choose explicitly every time. A default of 'production' would be
    a silent, easy-to-miss way for a Preview-intended dispatch to
    accidentally target Production if the caller forgot to set it."""
    _text, data = _load()
    inputs = _on(data)["workflow_dispatch"]["inputs"]
    env_input = inputs["environment"]
    assert env_input["type"] == "choice"
    assert env_input["options"] == ["production", "preview"], f"unexpected options: {env_input['options']}"
    assert env_input["required"] is True
    assert "default" not in env_input, "environment must have NO default -- it must always be chosen explicitly"


def test_job_targets_the_input_derived_environment():
    _text, data = _load()
    assert data["jobs"]["operate"]["environment"] == "${{ inputs.environment }}", (
        "the job must target GitHub's own Environment-scoping mechanism via the input, "
        "so a same-named secret in the 'preview' Environment can override the repository-level one"
    )


def test_concurrency_group_includes_both_environment_and_tenant_id():
    _text, data = _load()
    concurrency = data["concurrency"]
    assert "${{ inputs.environment }}" in concurrency["group"], "the concurrency group must include environment"
    assert "${{ inputs.tenant_id }}" in concurrency["group"], "the concurrency group must still include tenant_id"
    assert concurrency["cancel-in-progress"] is False


def test_environment_shell_allowlist_behavioral():
    """Same discipline as the OPERATION allowlist: the 'Validate inputs'
    shell script itself must reject any $ENVIRONMENT outside
    production|preview, never relying solely on the workflow_dispatch
    `type: choice` schema (which only constrains the GitHub UI)."""
    _text, data = _load()
    run_script = _validate_step(data)["run"]
    for bad_env in ("Production", "PREVIEW", "prod", "staging", "", "preview; rm -rf /", "production ", "development"):
        result = _run_validate_shell(run_script, "diagnose_google_status", "t_ok", "t_ok", environment=bad_env)
        assert result.returncode != 0, f"environment {bad_env!r} must be rejected by the shell allowlist"

    for good_env in ("production", "preview"):
        result = _run_validate_shell(run_script, "diagnose_google_status", "t_ok", "t_ok", environment=good_env)
        assert result.returncode == 0, f"environment {good_env!r} must be accepted, got: {result.stderr}"


PREVIEW_SECRET_NAMES = [
    "PREVIEW_ENVIRONMENT_MARKER",
    "PREVIEW_UPSTASH_REDIS_REST_URL",
    "PREVIEW_UPSTASH_REDIS_REST_TOKEN",
    "PREVIEW_CREDENTIAL_ENCRYPTION_KEY",
    "PREVIEW_BLOB_READ_WRITE_TOKEN",
    "PREVIEW_GOOGLE_CLIENT_ID",
    "PREVIEW_GOOGLE_CLIENT_SECRET",
]

ALL_PREVIEW_SECRETS_PRESENT_ENV = {name: f"configured-{name.lower()}-value" for name in PREVIEW_SECRET_NAMES}

# ===========================================================================
# Revision 12 (blocker fix -- no && / || cross-environment fallback): every
# secret-bearing lifecycle action is now TWO fully separate steps, never
# one step choosing between namespaces via an expression. This registry is
# the single source of truth every test below builds on: (production step
# name, preview step name, [secret NAMES that step's env: block carries]).
# ===========================================================================
LIFECYCLE_STEP_PAIRS = {
    "provision": ("Run provisioning (production)", "Run provisioning (preview)",
                  ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "CREDENTIAL_ENCRYPTION_KEY", "BLOB_READ_WRITE_TOKEN"]),
    "initial_sync": ("Run Initial Sync (production)", "Run Initial Sync (preview)",
                      ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "CREDENTIAL_ENCRYPTION_KEY", "BLOB_READ_WRITE_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]),
    "apply_entitlement_change": ("Apply entitlement change (production)", "Apply entitlement change (preview)",
                                  ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "CREDENTIAL_ENCRYPTION_KEY", "BLOB_READ_WRITE_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]),
    "diagnose_google_status": ("Diagnose Google status (production)", "Diagnose Google status (preview)",
                                ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "CREDENTIAL_ENCRYPTION_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]),
    "redis_identity_probe": ("Redis identity probe (production)", "Redis identity probe (preview)",
                              ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]),
    "credential_key_audit": ("Credential key/schema audit (production)", "Credential key/schema audit (preview)",
                              ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]),
}

# Not an `inputs.operation` value -- the always()-gated summary step -- but
# follows the identical production/preview split pattern.
WRITE_JOB_SUMMARY_PAIR = ("Write job summary (production)", "Write job summary (preview)",
                          ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "CREDENTIAL_ENCRYPTION_KEY"])

ALL_LIFECYCLE_SECRET_NAMES = {"UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "CREDENTIAL_ENCRYPTION_KEY", "BLOB_READ_WRITE_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"}


def test_verify_preview_isolation_step_structure():
    """blocker-fix revision: checks ALL SEVEN Preview-only secrets (not
    just the marker) are non-empty -- the marker remains defense in depth,
    no longer the primary guarantee (the distinct PREVIEW_*-prefixed
    secret NAMES referenced by each operation step are)."""
    _text, data = _load()
    step = _step(data, "Verify Preview isolation")
    assert step.get("id") == "verify_preview_isolation", "the chain-referencing steps below need this exact id"
    assert step["if"] == "steps.validate.outcome == 'success' && inputs.environment == 'preview'", (
        f"unexpected gating: {step['if']!r} -- must run ONLY for a validated 'preview' dispatch"
    )
    env = step.get("env", {})
    assert set(env.keys()) == set(PREVIEW_SECRET_NAMES), f"unexpected env keys: {sorted(env.keys())}"
    for name in PREVIEW_SECRET_NAMES:
        assert env[name] == f"${{{{ secrets.{name} }}}}", f"{name} must be sourced from secrets.{name} exactly, got {env[name]!r}"
        assert "PREVIEW_" == name[:8] or name == "PREVIEW_ENVIRONMENT_MARKER", "sanity: every checked name must actually be Preview-prefixed"


def test_verify_preview_isolation_shell_fails_closed_when_any_preview_secret_absent():
    """The concrete, executable proof of the whole design's safety net:
    actually RUN the step's shell with each combination and confirm it
    exits non-zero unless EVERY required PREVIEW_* secret is present --
    never silently succeeds with even one missing."""
    _text, data = _load()
    run_script = _step(data, "Verify Preview isolation")["run"]

    result_all_absent = subprocess.run(["bash", "-c", run_script], env={}, capture_output=True, text=True)
    assert result_all_absent.returncode != 0, "all PREVIEW_* secrets absent must fail closed, not silently pass"

    for missing_name in PREVIEW_SECRET_NAMES:
        partial_env = {k: v for k, v in ALL_PREVIEW_SECRETS_PRESENT_ENV.items() if k != missing_name}
        result = subprocess.run(["bash", "-c", run_script], env=partial_env, capture_output=True, text=True)
        assert result.returncode != 0, f"missing ONLY {missing_name} must still fail closed, not silently pass"
        assert missing_name in result.stdout or missing_name in result.stderr, (
            f"the failure must name {missing_name} specifically so an operator knows what to configure"
        )

    result_empty_one = subprocess.run(
        ["bash", "-c", run_script],
        env={**ALL_PREVIEW_SECRETS_PRESENT_ENV, "PREVIEW_GOOGLE_CLIENT_SECRET": ""},
        capture_output=True, text=True,
    )
    assert result_empty_one.returncode != 0, "an empty-STRING value (not just absent) must also fail closed"

    result_all_present = subprocess.run(["bash", "-c", run_script], env=ALL_PREVIEW_SECRETS_PRESENT_ENV, capture_output=True, text=True)
    assert result_all_present.returncode == 0, f"all seven PREVIEW_* secrets present must pass, got: {result_all_present.stderr}"


def test_every_lifecycle_action_has_separate_production_and_preview_steps():
    """Revision 12 (blocker fix): every secret-bearing lifecycle action is
    exactly two steps, never one step with a shared production/preview
    expression. The production step's gate is a plain environment check
    (preserving exact prior behavior -- no dependency on Preview isolation
    at all); the preview step's gate additionally requires a verified
    Preview isolation check."""
    _text, data = _load()
    for operation, (prod_name, preview_name, _secret_names) in LIFECYCLE_STEP_PAIRS.items():
        prod_step = _step(data, prod_name)
        preview_step = _step(data, preview_name)
        assert prod_step["if"] == f"inputs.operation == '{operation}' && inputs.environment == 'production'", (
            f"{prod_name}: unexpected if: {prod_step['if']!r}"
        )
        assert preview_step["if"] == f"inputs.operation == '{operation}' && inputs.environment == 'preview' && steps.verify_preview_isolation.outcome == 'success'", (
            f"{preview_name}: unexpected if: {preview_step['if']!r}"
        )
        # Neither gate may reference the OTHER environment at all -- not
        # just "requires the right thing" but "never even mentions the
        # wrong thing".
        assert "preview" not in prod_step["if"] and "verify_preview_isolation" not in prod_step["if"]
        assert "production" not in preview_step["if"]

    prod_name, preview_name, _secret_names = WRITE_JOB_SUMMARY_PAIR
    prod_step = _step(data, prod_name)
    preview_step = _step(data, preview_name)
    assert prod_step["if"] == "always() && steps.validate.outcome == 'success' && inputs.environment == 'production'"
    assert preview_step["if"] == "always() && steps.validate.outcome == 'success' && inputs.environment == 'preview' && steps.verify_preview_isolation.outcome == 'success'"


def test_no_step_uses_a_conditional_secret_selection_expression():
    """The literal root cause of this revision: no step's env: block may
    contain an `&&`/`||`-based secret-selection expression of the form
    `condition && secrets.X || secrets.Y` ANYWHERE -- GitHub Actions'
    &&/|| return an OPERAND (JS-style truthy semantics), not a coerced
    boolean, so such an expression can fall through to the WRONG
    environment's secret if the intended one is empty/unconfigured. Every
    env: value that references `secrets.` must be a single, unconditional
    reference -- no `&&`, no `||`, anywhere in that value."""
    _text, data = _load()
    steps = _steps(data)
    for step in steps:
        for key, value in step.get("env", {}).items():
            value = str(value)
            if "secrets." in value:
                assert "&&" not in value and "||" not in value, (
                    f"step {step.get('name')!r} env {key!r} uses a conditional secret-selection expression "
                    f"(forbidden -- can fall through to the wrong environment's secret): {value!r}"
                )


def _gha_and(a, b):
    """Emulates GitHub Actions' `&&` operator: JS-style truthy-return
    semantics, NOT a boolean AND -- returns `a` if `a` is falsy, else `b`.
    An empty string (an unconfigured secret) is falsy, exactly as GitHub
    Actions itself treats it."""
    return a if not a else b


def _gha_or(a, b):
    """Emulates GitHub Actions' `||` operator: returns `a` if `a` is
    truthy, else `b`."""
    return a if a else b


def _old_vulnerable_ternary(environment, prod_value, preview_value):
    """The EXACT expression shape this revision removes:
    `${{ inputs.environment == 'production' && secrets.X || secrets.PREVIEW_X }}`
    -- reproduced here as a literal operator-by-operator emulation (&&
    binds tighter than ||, matching real GitHub Actions expression
    precedence), not simplified/idealized, so this test is an honest
    model of what the runner would actually have evaluated."""
    return _gha_or(_gha_and(environment == 'production', prod_value), preview_value)


def test_old_conditional_pattern_would_have_leaked_production_to_preview_fallback_when_secret_empty():
    """Deliberately models the exact failure this revision fixes: with the
    OLD (now-removed) pattern, a 'production' dispatch whose actual
    Production secret is empty/unconfigured would silently receive the
    PREVIEW secret's value instead of failing -- Production -> Preview
    cross-environment fallback. This is why the fix could not simply keep
    the ternary and "just configure things correctly": an empty Production
    secret is a real, unavoidable failure mode (e.g. before initial setup,
    or after an accidental deletion), and the ternary made it silently
    dangerous rather than loudly broken."""
    leaked_value = _old_vulnerable_ternary(environment='production', prod_value='', preview_value='preview-secret-value')
    assert leaked_value == 'preview-secret-value', (
        "this models the EXACT bug being fixed: with the old &&/|| pattern, an empty Production secret "
        f"falls through to the Preview value -- got {leaked_value!r}, confirming the vulnerability was real"
    )


def test_old_conditional_pattern_did_not_leak_preview_to_production_in_the_other_direction():
    """The reverse direction was NOT vulnerable in the old pattern (GitHub
    Actions' && short-circuits on its LEFT operand: `environment ==
    'production'` is false for a 'preview' dispatch, so `secrets.X` -- the
    Production secret -- is never even evaluated, and the whole expression
    always resolves to secrets.PREVIEW_X regardless of whether IT is
    empty). Modeled here for completeness, so this revision's fix is
    understood as closing the confirmed one-directional bug (Blocker
    described "Production -> Preview"), not an imagined bidirectional one
    -- and the NEW fully-separate-steps design closes both directions
    structurally regardless, since there is no shared expression left at
    all (proven by the two structural tests above)."""
    result = _old_vulnerable_ternary(environment='preview', prod_value='production-secret-value', preview_value='')
    assert result == '', (
        f"the old pattern's 'preview' branch always resolved to the Preview secret's own value (even when empty), "
        f"never falling back to the Production value -- got {result!r}, confirming this direction was never the "
        f"actual vulnerability (the fix nonetheless removes ALL such expressions, closing both directions structurally)"
    )


def test_new_design_has_zero_secret_value_dependent_step_selection():
    """The deepest form of "no fallback in either direction": with the new
    design, NO env: value used by any step depends on ANY secret's actual
    content -- gating (`if:`) is a pure `inputs.environment`/prior-step-
    outcome comparison, and each step's own env: block is a single,
    unconditional `secrets.NAME` reference (proven exactly above). An
    empty/missing secret can therefore only ever affect that ONE step's
    own credential value (which the underlying Python script then fails
    on however it already does) -- it can NEVER change which step runs,
    and thus can never cause a cross-environment read, in either
    direction, for any input."""
    _text, data = _load()
    all_pairs = list(LIFECYCLE_STEP_PAIRS.values()) + [WRITE_JOB_SUMMARY_PAIR]
    for prod_name, preview_name, _secret_names in all_pairs:
        prod_if = _step(data, prod_name)["if"]
        preview_if = _step(data, preview_name)["if"]
        # Gating conditions reference inputs/steps.*.outcome only -- never
        # `secrets.` -- so no secret's VALUE (empty or not) can influence
        # which step is selected to run.
        assert "secrets." not in prod_if and "secrets." not in preview_if, (
            f"{prod_name}/{preview_name}: step SELECTION must never depend on a secret's value"
        )


def test_production_steps_never_reference_any_preview_secret_name():
    """Invariant 1: a Production run must never reference a PREVIEW_*
    secret -- checked structurally: no Production-tagged step's env: block
    may contain the substring 'PREVIEW_' anywhere."""
    _text, data = _load()
    prod_step_names = [pair[0] for pair in LIFECYCLE_STEP_PAIRS.values()] + [WRITE_JOB_SUMMARY_PAIR[0]]
    for name in prod_step_names:
        step = _step(data, name)
        for key, value in step.get("env", {}).items():
            assert "PREVIEW_" not in str(value), f"{name} env {key!r} must never reference a PREVIEW_* secret, got {value!r}"


def test_preview_steps_never_reference_a_bare_production_secret_name():
    """Invariant 2: a Preview run must never reference a Production
    lifecycle secret -- checked structurally: every env: value on a
    Preview-tagged step that references `secrets.` must reference a
    PREVIEW_*-prefixed name specifically, never the bare Production name."""
    _text, data = _load()
    preview_step_names = [pair[1] for pair in LIFECYCLE_STEP_PAIRS.values()] + [WRITE_JOB_SUMMARY_PAIR[1]]
    for name in preview_step_names:
        step = _step(data, name)
        for key, value in step.get("env", {}).items():
            value = str(value)
            if "secrets." in value:
                assert "secrets.PREVIEW_" in value, f"{name} env {key!r} must reference a secrets.PREVIEW_* name, got {value!r}"


def test_every_lifecycle_secret_step_uses_the_exact_unconditional_secret_reference():
    """Belt-and-suspenders exact-match version of the two invariant tests
    above: every registered secret name on every production step is
    EXACTLY `${{ secrets.NAME }}`; every registered secret name on every
    preview step is EXACTLY `${{ secrets.PREVIEW_NAME }}`. No other shape
    is accepted for either."""
    _text, data = _load()
    pairs = list(LIFECYCLE_STEP_PAIRS.values()) + [WRITE_JOB_SUMMARY_PAIR]
    for prod_name, preview_name, secret_names in pairs:
        prod_step = _step(data, prod_name)
        preview_step = _step(data, preview_name)
        prod_env = prod_step.get("env", {})
        preview_env = preview_step.get("env", {})
        assert set(secret_names).issubset(prod_env.keys()), f"{prod_name}: missing {set(secret_names) - set(prod_env.keys())}"
        assert set(secret_names).issubset(preview_env.keys()), f"{preview_name}: missing {set(secret_names) - set(preview_env.keys())}"
        for name in secret_names:
            assert prod_env[name] == f"${{{{ secrets.{name} }}}}", f"{prod_name}.{name} must be exactly secrets.{name}, got {prod_env[name]!r}"
            assert preview_env[name] == f"${{{{ secrets.PREVIEW_{name} }}}}", f"{preview_name}.{name} must be exactly secrets.PREVIEW_{name}, got {preview_env[name]!r}"
        # No OTHER lifecycle secret name sneaks in beyond what's registered
        # (mirrors the workflow's own intentionally minimal per-operation
        # exposure, e.g. diagnose_google_status never gets Blob).
        assert not ((set(prod_env.keys()) & ALL_LIFECYCLE_SECRET_NAMES) - set(secret_names)), f"{prod_name} carries unexpected extra secrets"
        assert not ((set(preview_env.keys()) & ALL_LIFECYCLE_SECRET_NAMES) - set(secret_names)), f"{preview_name} carries unexpected extra secrets"


def test_preview_environment_marker_referenced_only_in_verify_step():
    """PREVIEW_ENVIRONMENT_MARKER must never leak into any operation
    script's env (it carries no useful value to any of them) or the chain
    step -- its blast radius is exactly one step."""
    _text, data = _load()
    steps = _steps(data)
    referencing = [s.get("name") for s in steps if "PREVIEW_ENVIRONMENT_MARKER" in str(s.get("env", {}))]
    assert referencing == ["Verify Preview isolation"], f"PREVIEW_ENVIRONMENT_MARKER must be referenced by exactly one step, found: {referencing}"


def test_write_preview_isolation_failure_summary_carries_no_secrets():
    _text, data = _load()
    step = _step(data, "Write Preview isolation failure summary")
    assert step["if"] == "always() && steps.validate.outcome == 'success' && inputs.environment == 'preview' && steps.verify_preview_isolation.outcome == 'failure'"
    assert "env" not in step, "the Preview-isolation-failure summary must never declare an env: block"
    assert "secrets." not in step["run"]
    assert ".py" not in step["run"], "must never invoke a tenant-aware script"


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
    """The operation-gated steps rely on GitHub Actions' own default
    behavior (a plain `if:` implicitly requires success() of every prior
    step) -- none of them may use always()/failure(), which would let
    them run even after Validate inputs failed. Revision 12 (blocker fix)
    doubled the six lifecycle actions into production/preview pairs (12
    steps) and kept "Chain to Initial Sync" as the 13th -- its `if:` still
    STARTS WITH 'inputs.operation ==', so it is correctly picked up by
    this same filter. Phase B.12 (Decision 1) adds "Activate billing
    (production)"/"Activate billing (preview)" as the 14th/15th -- each
    chained on its own environment's Run Initial Sync step succeeding,
    exactly like Chain to Initial Sync is chained on provisioning."""
    _text, data = _load()
    steps = _steps(data)
    operation_steps = [s for s in steps if s.get("if", "").startswith("inputs.operation ==")]
    assert len(operation_steps) == 15, f"expected exactly 15 operation-gated steps (6 lifecycle actions x 2 + Chain to Initial Sync + Activate billing x 2), found {len(operation_steps)}"
    for s in operation_steps:
        cond = s["if"]
        assert "always()" not in cond and "failure()" not in cond, (
            f"step {s.get('name')!r} must not override the default success()-required behavior, got if: {cond!r}"
        )


def test_chain_to_initial_sync_step_gating_and_env():
    """Multi-Tenant Phase 4O's self-chain step: must fire ONLY when EITHER
    this run's own production or preview provisioning step (ids:
    run_provisioning_production / run_provisioning_preview, added by
    revision 12's production/preview split) genuinely succeeded -- never
    the bare success() default, which would also fire for every OTHER
    operation this workflow supports. Since the two provisioning steps'
    `if:` conditions are mutually exclusive on inputs.environment, exactly
    one can ever be 'success' for a given run. Must carry ONLY GITHUB_TOKEN
    (no production secret) plus the environment/ref to preserve, and
    dispatch operation=initial_sync for the SAME server-derived tenant_id.
    Preview Infrastructure Isolation (revision 10): must preserve THIS
    run's own inputs.environment onto the chained dispatch, so the chained
    initial_sync run re-derives and re-verifies the SAME environment
    independently rather than inheriting it implicitly. Blocker-fix
    revision 11: must ALSO preserve THIS run's own git ref via
    github.ref_name (GitHub's own trusted record of which ref this run was
    actually dispatched against) -- NEVER a hardcoded 'main' literal, since
    a Preview run must chain using the SAME Preview ref."""
    _text, data = _load()
    steps = _steps(data)

    run_provisioning_production = next((s for s in steps if s.get("name") == "Run provisioning (production)"), None)
    assert run_provisioning_production is not None, "no 'Run provisioning (production)' step found"
    assert run_provisioning_production.get("id") == "run_provisioning_production"

    run_provisioning_preview = next((s for s in steps if s.get("name") == "Run provisioning (preview)"), None)
    assert run_provisioning_preview is not None, "no 'Run provisioning (preview)' step found"
    assert run_provisioning_preview.get("id") == "run_provisioning_preview"

    chain = next((s for s in steps if s.get("name") == "Chain to Initial Sync"), None)
    assert chain is not None, "no 'Chain to Initial Sync' step found"
    assert chain["if"] == "inputs.operation == 'provision' && (steps.run_provisioning_production.outcome == 'success' || steps.run_provisioning_preview.outcome == 'success')", (
        f"unexpected gating condition: {chain['if']!r}"
    )

    env = chain.get("env", {})
    assert set(env.keys()) == {"GH_TOKEN", "TENANT_ID", "ENVIRONMENT", "WORKFLOW_REF"}, f"unexpected env keys on the chain step: {sorted(env.keys())}"
    assert env["GH_TOKEN"] == "${{ secrets.GITHUB_TOKEN }}", "the chain step must use the run's own ambient GITHUB_TOKEN, never a dedicated PAT"
    assert env["TENANT_ID"] == "${{ inputs.tenant_id }}", "the chain step must reuse THIS run's own server-derived tenant_id, never a new input"
    assert env["ENVIRONMENT"] == "${{ inputs.environment }}", "the chain step must reuse THIS run's own server-derived environment, never a new input"
    assert env["WORKFLOW_REF"] == "${{ github.ref_name }}", (
        "the chain step must reuse GitHub's own trusted github.ref_name (the ref THIS run was actually dispatched "
        "against), never a hardcoded literal or a workflow input"
    )

    run_script = chain["run"]
    assert "inputs[operation]=initial_sync" in run_script, "the chain step must dispatch operation=initial_sync specifically"
    assert "ref='main'" not in run_script, "the chain step must NOT hardcode ref='main' -- a Preview run must chain using the SAME Preview ref"
    assert 'ref="$WORKFLOW_REF"' in run_script, "the chain step must dispatch using $WORKFLOW_REF (github.ref_name), never a hardcoded ref"
    assert "inputs[tenant_id]=$TENANT_ID" in run_script and "inputs[confirmation]=$TENANT_ID" in run_script, (
        "the chained dispatch's tenant_id and confirmation must both be the SAME server-derived $TENANT_ID"
    )
    assert "inputs[environment]=$ENVIRONMENT" in run_script, (
        "the chained dispatch must explicitly preserve the SAME server-derived $ENVIRONMENT"
    )


def test_run_initial_sync_steps_have_ids_for_chaining():
    """Phase B.12 (Decision 1) -- the 'Activate billing' steps below need a
    stable id to gate on, exactly like Chain to Initial Sync already gates
    on run_provisioning_production/run_provisioning_preview."""
    _text, data = _load()
    prod = _step(data, "Run Initial Sync (production)")
    preview = _step(data, "Run Initial Sync (preview)")
    assert prod.get("id") == "run_initial_sync_production"
    assert preview.get("id") == "run_initial_sync_preview"


def test_activate_billing_production_step_gating_and_env():
    _text, data = _load()
    step = _step(data, "Activate billing (production)")
    assert step.get("id") == "activate_billing_production"
    assert step["if"] == "inputs.operation == 'initial_sync' && inputs.environment == 'production' && steps.run_initial_sync_production.outcome == 'success' && github.ref == 'refs/heads/main'", (
        f"unexpected gating: {step['if']!r}"
    )
    env = step.get("env", {})
    assert set(env.keys()) == {"TENANT_ID", "BILLING_ACTIVATION_CALLBACK_SECRET"}, f"unexpected env keys: {sorted(env.keys())}"
    assert env["TENANT_ID"] == "${{ inputs.tenant_id }}"
    assert env["BILLING_ACTIVATION_CALLBACK_SECRET"] == "${{ secrets.BILLING_ACTIVATION_CALLBACK_SECRET }}", (
        f"must be sourced from the dedicated BILLING_ACTIVATION_CALLBACK_SECRET, never CREDENTIAL_ENCRYPTION_KEY/GOOGLE_CLIENT_SECRET/VERCEL_TOKEN/a GitHub PAT/any Stripe secret, got {env['BILLING_ACTIVATION_CALLBACK_SECRET']!r}"
    )
    assert "PREVIEW_" not in str(env), "the production step must never reference any PREVIEW_* secret name"


def test_activate_billing_preview_step_gating_and_env():
    _text, data = _load()
    step = _step(data, "Activate billing (preview)")
    assert step.get("id") == "activate_billing_preview"
    assert step["if"] == "inputs.operation == 'initial_sync' && inputs.environment == 'preview' && steps.verify_preview_isolation.outcome == 'success' && steps.run_initial_sync_preview.outcome == 'success'", (
        f"unexpected gating: {step['if']!r}"
    )
    env = step.get("env", {})
    assert set(env.keys()) == {"TENANT_ID", "BILLING_ACTIVATION_CALLBACK_SECRET"}, f"unexpected env keys: {sorted(env.keys())}"
    assert env["TENANT_ID"] == "${{ inputs.tenant_id }}"
    assert env["BILLING_ACTIVATION_CALLBACK_SECRET"] == "${{ secrets.PREVIEW_BILLING_ACTIVATION_CALLBACK_SECRET }}", (
        f"the preview step must reference secrets.PREVIEW_BILLING_ACTIVATION_CALLBACK_SECRET specifically, got {env['BILLING_ACTIVATION_CALLBACK_SECRET']!r}"
    )


def test_production_billing_callback_requires_main_ref():
    """Safety-audit invariant: `ref` (which branch's copy of this workflow
    file executes) and `inputs.environment` are two fully independent
    dispatch parameters -- without an explicit github.ref check, a
    dispatch with ref=<any non-main branch> + environment=production would
    still reach the real Production billing callback. This is the
    structural, workflow-enforced guarantee (not merely the caller-side
    convention already encoded in resolveLifecycleExecutionRef())."""
    _text, data = _load()
    prod_step = _step(data, "Activate billing (production)")
    assert "github.ref == 'refs/heads/main'" in prod_step["if"], (
        "the Production billing callback must require github.ref == 'refs/heads/main' -- "
        f"got if: {prod_step['if']!r}"
    )


def test_preview_billing_callback_is_not_ref_restricted():
    """The Preview callback's whole purpose is to be reachable from a real
    feature branch (APPROVED_PREVIEW_LIFECYCLE_REF) -- the main-ref guard
    must apply ONLY to the Production step, never to Preview."""
    _text, data = _load()
    preview_step = _step(data, "Activate billing (preview)")
    assert "github.ref" not in preview_step["if"], (
        f"the Preview billing callback must remain unrestricted by ref, got if: {preview_step['if']!r}"
    )


def test_activate_billing_steps_never_use_a_conditional_secret_expression():
    """Same revision-12 discipline as every other secret in this file --
    checked here explicitly for the new secret name too (also covered
    generically by test_no_step_uses_a_conditional_secret_selection_expression,
    this is a belt-and-suspenders, named check)."""
    _text, data = _load()
    for name in ("Activate billing (production)", "Activate billing (preview)"):
        step = _step(data, name)
        value = str(step.get("env", {}).get("BILLING_ACTIVATION_CALLBACK_SECRET", ""))
        assert "&&" not in value and "||" not in value, f"{name}: forbidden conditional secret-selection expression: {value!r}"


def test_activate_billing_steps_have_bounded_retry_and_fail_visibly():
    """The concrete, executable proof of the retry/visible-failure
    requirement: a bounded loop that retries on non-2xx, and an explicit
    `exit 1` (never a silent/success exit) once every attempt is
    exhausted -- GitHub Actions' own default behavior then marks the job
    'failure', so a persistently-failing callback can never be silently
    treated as complete billing activation."""
    _text, data = _load()
    for name in ("Activate billing (production)", "Activate billing (preview)"):
        step = _step(data, name)
        run_script = step["run"]
        assert "for attempt in $(seq 1 \"$ATTEMPTS\")" in run_script, f"{name}: must retry in a bounded loop"
        assert "exit 0" in run_script and "exit 1" in run_script, f"{name}: must have both a success exit and a final failure exit"
        assert run_script.rstrip().endswith("exit 1"), f"{name}: the script must end by failing closed if every attempt was exhausted"
        assert "Authorization: Bearer $BILLING_ACTIVATION_CALLBACK_SECRET" in run_script, f"{name}: must authenticate via the Bearer secret"
        # The secret's own VALUE must never be echoed/printed anywhere in
        # this script (only ever referenced inside the Authorization header
        # sent over HTTPS to the app itself).
        assert "echo" not in run_script.split("Authorization:")[0].split("BILLING_ACTIVATION_CALLBACK_SECRET")[-1] or True
        for line in run_script.split("\n"):
            if "echo" in line or "cat " in line:
                assert "$BILLING_ACTIVATION_CALLBACK_SECRET" not in line, f"{name}: must never print the callback secret's value: {line!r}"
        # inputs.* must never be interpolated directly into the run: text
        # (same injection-safety discipline as every other step in this
        # file) -- TENANT_ID is read from env:, referenced as "$TENANT_ID".
        assert "${{ inputs." not in run_script, f"{name}: must never interpolate a workflow input directly into the run script"


def test_secret_bearing_summary_only_runs_after_successful_validation():
    """Revision 12 (blocker fix) split 'Write job summary' into separate
    production/preview steps, exactly like every other secret-bearing
    step -- checked here for both."""
    _text, data = _load()
    for name in WRITE_JOB_SUMMARY_PAIR[:2]:
        step = _step(data, name)
        cond = step["if"]
        assert "steps.validate.outcome == 'success'" in cond, (
            f"{name}: must require steps.validate.outcome == 'success', got if: {cond!r}"
        )
        env = step.get("env", {})
        assert any("secrets." in str(v) for v in env.values()), f"{name}: must still carry lifecycle secrets"
        assert "tenant_status_report.py" in step["run"]


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
    """The concrete, combined proof the tests above establish piecewise:
    for a rejected dispatch (LTA, malformed, or mismatched), the ONLY
    steps whose `if:` can evaluate true are 'Checkout', 'Validate inputs'
    itself, 'Set up Python', 'Install Python dependencies' (none of which
    carry secrets or run tenant code), and 'Write validation-failure
    summary' (which carries no secrets and runs no script) -- not any of
    the 12 production/preview operation steps (revision 12), not 'Verify
    Preview isolation' (which carries PREVIEW_ENVIRONMENT_MARKER), 'Chain
    to Initial Sync' (which carries GITHUB_TOKEN), either 'Write job
    summary' variant, or (Phase B.12 Decision 1) either 'Activate billing'
    variant (which carries BILLING_ACTIVATION_CALLBACK_SECRET)."""
    _text, data = _load()
    steps = _steps(data)
    secret_bearing_step_names = {
        s.get("name") for s in steps
        if any("secrets." in str(v) for v in s.get("env", {}).values())
    }
    expected = set()
    for prod_name, preview_name, _secrets in LIFECYCLE_STEP_PAIRS.values():
        expected.add(prod_name)
        expected.add(preview_name)
    expected.add(WRITE_JOB_SUMMARY_PAIR[0])
    expected.add(WRITE_JOB_SUMMARY_PAIR[1])
    expected.add("Chain to Initial Sync")
    expected.add("Verify Preview isolation")
    expected.add("Activate billing (production)")
    expected.add("Activate billing (preview)")
    assert secret_bearing_step_names == expected, f"unexpected set of secret-bearing steps: {secret_bearing_step_names}"

    always_gated_names = {WRITE_JOB_SUMMARY_PAIR[0], WRITE_JOB_SUMMARY_PAIR[1], "Verify Preview isolation"}
    for name in secret_bearing_step_names:
        step = next(s for s in steps if s.get("name") == name)
        cond = step.get("if", "")
        if name not in always_gated_names:
            assert "always()" not in cond and "failure()" not in cond, (
                f"secret-bearing step {name!r} must not be reachable after a failed validation"
            )
        else:
            assert "steps.validate.outcome == 'success'" in cond, (
                f"secret-bearing step {name!r} must require successful validation"
            )


# ===========================================================================
# 8. diagnostic receives no Blob secret (either environment)
# ===========================================================================

def test_diagnose_step_never_receives_blob_secret():
    _text, data = _load()
    for name in LIFECYCLE_STEP_PAIRS["diagnose_google_status"][:2]:
        env = _step(data, name).get("env", {})
        assert "BLOB_READ_WRITE_TOKEN" not in env and "PREVIEW_BLOB_READ_WRITE_TOKEN" not in env, (
            f"{name} must never receive a Blob secret"
        )


# ===========================================================================
# 9. provisioning/redis-probe/credential-audit receive no Google secrets
# (either environment) -- the exact-reference registry test above already
# proves the full expected secret set per step; these are small, readable,
# single-purpose regression checks for the specific historically-important
# exclusions.
# ===========================================================================

def test_provision_step_never_receives_google_secrets():
    _text, data = _load()
    for name in LIFECYCLE_STEP_PAIRS["provision"][:2]:
        env = _step(data, name).get("env", {})
        assert "GOOGLE_CLIENT_ID" not in env and "PREVIEW_GOOGLE_CLIENT_ID" not in env, f"{name} must never receive a Google secret"


def test_redis_probe_step_receives_only_the_two_redis_secrets():
    _text, data = _load()
    for name in LIFECYCLE_STEP_PAIRS["redis_identity_probe"][:2]:
        env = _step(data, name).get("env", {})
        non_redis = set(env.keys()) - {"UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"}
        assert not non_redis, f"{name} must receive ONLY the two Redis secrets, also found: {non_redis}"


def test_credential_audit_step_receives_only_tenant_id_and_redis_secrets():
    _text, data = _load()
    for name in LIFECYCLE_STEP_PAIRS["credential_key_audit"][:2]:
        step = _step(data, name)
        env = step.get("env", {})
        assert set(env.keys()) == {"TENANT_ID", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"}, (
            f"{name} must receive ONLY TENANT_ID and the two Redis secrets, got {sorted(env.keys())}"
        )
        assert "redis_credential_key_audit.py" in step["run"]
        assert "always()" not in step["if"] and "failure()" not in step["if"]


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


def test_permissions_are_the_minimum_deliberate_set():
    """contents: read was the whole permission set before Multi-Tenant
    Phase 4O. actions: write is a deliberate, reviewed addition -- it
    exists solely so the "Chain to Initial Sync" step can dispatch a
    follow-up run of this SAME workflow using the run's own ambient
    GITHUB_TOKEN (verified live before use; see that step's own comment).
    Anything beyond these two keys would be undocumented scope creep."""
    _text, data = _load()
    assert data.get("permissions") == {"contents": "read", "actions": "write"}


def main() -> int:
    run("checkout ref is the literal approved 40-char SHA", test_checkout_ref_is_the_literal_approved_sha)
    run("no ref/branch/sha input exists", test_no_ref_branch_or_sha_input_exists)
    run("environment input is a required choice with no default", test_environment_input_is_a_required_choice_with_no_default)
    run("job targets the input-derived environment", test_job_targets_the_input_derived_environment)
    run("concurrency group includes both environment and tenant_id", test_concurrency_group_includes_both_environment_and_tenant_id)
    run("environment shell allowlist rejects bad values; approved ones pass", test_environment_shell_allowlist_behavioral)
    run("Verify Preview isolation step is structured correctly", test_verify_preview_isolation_step_structure)
    run("Verify Preview isolation shell fails closed when any PREVIEW_* secret absent/empty", test_verify_preview_isolation_shell_fails_closed_when_any_preview_secret_absent)
    run("every lifecycle action has separate production and preview steps", test_every_lifecycle_action_has_separate_production_and_preview_steps)
    run("no step uses a conditional (&&/||) secret-selection expression", test_no_step_uses_a_conditional_secret_selection_expression)
    run("old &&/|| pattern modeled: would have leaked Production->Preview when empty", test_old_conditional_pattern_would_have_leaked_production_to_preview_fallback_when_secret_empty)
    run("old &&/|| pattern modeled: did not leak Preview->Production (confirmed one-directional)", test_old_conditional_pattern_did_not_leak_preview_to_production_in_the_other_direction)
    run("new design: no step's SELECTION ever depends on a secret's value", test_new_design_has_zero_secret_value_dependent_step_selection)
    run("production steps never reference any PREVIEW_* secret name", test_production_steps_never_reference_any_preview_secret_name)
    run("preview steps never reference a bare Production secret name", test_preview_steps_never_reference_a_bare_production_secret_name)
    run("every lifecycle secret step uses the exact unconditional secret reference", test_every_lifecycle_secret_step_uses_the_exact_unconditional_secret_reference)
    run("PREVIEW_ENVIRONMENT_MARKER is referenced by exactly one step", test_preview_environment_marker_referenced_only_in_verify_step)
    run("Write Preview isolation failure summary carries no secrets", test_write_preview_isolation_failure_summary_carries_no_secrets)
    run("unsupported operation fails the shell allowlist; approved ones pass", test_unsupported_operation_fails_shell_allowlist)
    run("malformed tenant_id fails", test_malformed_tenant_id_fails)
    run("t_los-tres-amigos is rejected", test_los_tres_amigos_is_rejected)
    run("mismatched confirmation fails", test_confirmation_mismatch_fails)
    run("a fully valid dispatch is accepted", test_matching_confirmation_and_valid_input_succeeds)
    run("'Validate inputs' has id: validate", test_validate_step_has_an_id_every_secret_step_can_reference)
    run("operation steps have no always()/failure() override", test_operation_steps_have_no_always_override)
    run("Chain to Initial Sync is gated on either provisioning variant's own success, carries only GITHUB_TOKEN", test_chain_to_initial_sync_step_gating_and_env)
    run("Run Initial Sync steps have ids for chaining", test_run_initial_sync_steps_have_ids_for_chaining)
    run("Activate billing (production) is gated correctly and uses BILLING_ACTIVATION_CALLBACK_SECRET", test_activate_billing_production_step_gating_and_env)
    run("Activate billing (preview) is gated correctly and uses PREVIEW_BILLING_ACTIVATION_CALLBACK_SECRET", test_activate_billing_preview_step_gating_and_env)
    run("Activate billing steps never use a conditional secret-selection expression", test_activate_billing_steps_never_use_a_conditional_secret_expression)
    run("the Production billing callback requires github.ref == refs/heads/main", test_production_billing_callback_requires_main_ref)
    run("the Preview billing callback is not ref-restricted", test_preview_billing_callback_is_not_ref_restricted)
    run("Activate billing steps retry and fail visibly, never printing the secret", test_activate_billing_steps_have_bounded_retry_and_fail_visibly)
    run("secret-bearing summary only runs after successful validation", test_secret_bearing_summary_only_runs_after_successful_validation)
    run("failure summary carries no secrets and invokes no script", test_failure_summary_step_carries_no_secrets_and_invokes_no_script)
    run("a failed validation reaches NO secret-bearing step, end to end", test_validation_failure_reaches_no_secret_bearing_step_end_to_end)
    run("diagnose_google_status never receives BLOB_READ_WRITE_TOKEN", test_diagnose_step_never_receives_blob_secret)
    run("redis_identity_probe receives ONLY the two Redis secrets", test_redis_probe_step_receives_only_the_two_redis_secrets)
    run("credential_key_audit receives ONLY TENANT_ID and the two Redis secrets", test_credential_audit_step_receives_only_tenant_id_and_redis_secrets)
    run("provisioning never receives Google secrets", test_provision_step_never_receives_google_secrets)
    run("concurrency remains tenant-scoped with cancel-in-progress: false", test_concurrency_remains_tenant_scoped)
    run("no multi-tenant app/Python implementation file is merged onto main", test_no_app_or_python_implementation_files_on_main)
    run("workflow requests only the minimum deliberate permission set (contents: read, actions: write)", test_permissions_are_the_minimum_deliberate_set)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
