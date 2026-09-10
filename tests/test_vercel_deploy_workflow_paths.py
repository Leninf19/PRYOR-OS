"""
Regression tests for Final PRYOR Deployment Path Repair: `vercel --prod`
must run from the REPOSITORY ROOT, never from inside dashboard/ -- the
Vercel project's own "Root Directory" setting is "dashboard" (left
unchanged by this fix), so running the CLI from an already-dashboard-
relative working directory made it apply that root a second time,
producing the real, confirmed production failure "the provided path
'.../dashboard/dashboard' does not exist".

This is a plain text/line-based scan of the two known Vercel-deploying
workflow files, matching this codebase's established convention for
workflow-correctness regression tests (test_workflow_tenant_ids.py) rather
than pulling in a YAML-parsing dependency this repo doesn't otherwise use.

What this test CAN prove from the repository alone: no workflow step ever
combines `cd dashboard`/`working-directory: dashboard` with the `vercel`
CLI invocation in the same step, the dashboard npm install/build step
legitimately still scopes to dashboard/, and the literal string
"dashboard/dashboard" appears nowhere in either file. What it CANNOT
prove: the Vercel PROJECT's own "Root Directory" setting is a live,
remote Vercel configuration value, outside this repository entirely --
this suite documents that as an out-of-scope assumption rather than
silently pretending to cover it.

Run directly: py tests/test_vercel_deploy_workflow_paths.py
"""
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS_DIR = REPO_ROOT / ".github" / "workflows"

# Every workflow file this repo currently invokes `vercel` from. If a
# future workflow adds a new Vercel deploy step, it belongs in this list
# too -- test_every_vercel_invoking_workflow_is_covered below guards that.
VERCEL_DEPLOY_WORKFLOWS = ("update-reviews.yml", "deploy-frontend.yml")

EXPECTED_VERCEL_ORG_ID = "team_bzqEwLON2tvascgmnOtYAPi8"
EXPECTED_VERCEL_PROJECT_ID = "prj_rAhOLFWrKXB94ohCGiAdw3OY1ymo"


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


def _steps(source: str) -> list[str]:
    """Splits a workflow file's `steps:` list into one text block per
    step, cut at each top-level ("      - ") step-list-item boundary --
    matches this repo's own consistent 6-space step-item / 8-space
    step-property indentation throughout every real workflow file."""
    lines = source.split("\n")
    blocks = []
    current = []
    for line in lines:
        if re.match(r"^      - (name:|uses:|run:)", line):
            if current:
                blocks.append("\n".join(current))
            current = [line]
        elif current:
            current.append(line)
    if current:
        blocks.append("\n".join(current))
    return blocks


def _find_step(blocks: list[str], name_substring: str) -> str:
    matches = [b for b in blocks if re.search(rf"name:\s*.*{re.escape(name_substring)}", b, re.IGNORECASE)]
    assert len(matches) == 1, f"expected exactly one step matching {name_substring!r}, found {len(matches)}"
    return matches[0]


def test_every_vercel_invoking_workflow_is_covered():
    """If a workflow file starts invoking `vercel` without being added to
    VERCEL_DEPLOY_WORKFLOWS, this suite's own coverage would silently
    narrow -- this catches that."""
    discovered = set()
    for path in WORKFLOWS_DIR.glob("*.yml"):
        source = path.read_text(encoding="utf-8")
        if re.search(r"\bnpx vercel\b|\bvercel --prod\b", source):
            discovered.add(path.name)
    assert discovered == set(VERCEL_DEPLOY_WORKFLOWS), (
        f"VERCEL_DEPLOY_WORKFLOWS is out of sync with reality: discovered {discovered}, "
        f"list says {set(VERCEL_DEPLOY_WORKFLOWS)}"
    )


def test_deploy_to_vercel_step_never_cds_into_dashboard():
    for filename in VERCEL_DEPLOY_WORKFLOWS:
        source = (WORKFLOWS_DIR / filename).read_text(encoding="utf-8")
        deploy_step = _find_step(_steps(source), "Deploy to Vercel")
        assert "cd dashboard" not in deploy_step, (
            f"{filename}: the 'Deploy to Vercel' step must never `cd dashboard` -- vercel --prod must run "
            f"from the repository root (the Vercel project's own Root Directory setting already resolves "
            f"into dashboard/ on its own; combining both doubles the path)"
        )
        assert "working-directory: dashboard" not in deploy_step, (
            f"{filename}: the 'Deploy to Vercel' step must not set working-directory: dashboard either -- "
            f"same reasoning as the cd check above"
        )


def test_deploy_to_vercel_step_actually_invokes_vercel():
    """Complements the check above: confirms the step we're scanning is
    genuinely the one that calls vercel, so an unrelated step accidentally
    matching 'Deploy to Vercel' by name wouldn't silently pass."""
    for filename in VERCEL_DEPLOY_WORKFLOWS:
        source = (WORKFLOWS_DIR / filename).read_text(encoding="utf-8")
        deploy_step = _find_step(_steps(source), "Deploy to Vercel")
        assert "npx vercel" in deploy_step and "--prod" in deploy_step, (
            f"{filename}: the 'Deploy to Vercel' step no longer appears to invoke `vercel --prod` at all"
        )


def test_dashboard_install_and_build_still_scoped_to_dashboard():
    """The OTHER half of the fix: dashboard's own npm install/build must
    still run inside dashboard/ -- this repair only moves the vercel
    invocation itself, not the whole pipeline."""
    for filename in VERCEL_DEPLOY_WORKFLOWS:
        source = (WORKFLOWS_DIR / filename).read_text(encoding="utf-8")
        blocks = _steps(source)
        build_step = _find_step(blocks, "Install dashboard dependencies and build")
        assert "working-directory: dashboard" in build_step, (
            f"{filename}: the dashboard install/build step must set working-directory: dashboard"
        )
        assert "npm ci" in build_step and "npm run build" in build_step, (
            f"{filename}: the dashboard install/build step no longer appears to actually install/build"
        )


def test_no_workflow_ever_produces_a_doubled_dashboard_path():
    """Excludes comment lines -- this fix's own explanatory comments
    legitimately quote the real production error message verbatim, which
    itself contains the literal string 'dashboard/dashboard'. Only a
    non-comment (real, executable YAML) occurrence would indicate the bug
    itself, not documentation of it."""
    for filename in VERCEL_DEPLOY_WORKFLOWS:
        source = (WORKFLOWS_DIR / filename).read_text(encoding="utf-8")
        non_comment_lines = [
            line for line in source.split("\n")
            if not line.strip().startswith("#")
        ]
        assert "dashboard/dashboard" not in "\n".join(non_comment_lines), (
            f"{filename}: contains the literal doubled path 'dashboard/dashboard' outside a comment -- "
            f"this is the exact string the real production failure's error message named"
        )


def _step_names_in_order(source: str) -> list[str]:
    names = []
    for block in _steps(source):
        m = re.search(r"^      - name:\s*(.+)$", block, re.MULTILINE)
        names.append(m.group(1).strip() if m else None)
    return names


def test_data_generation_pipeline_runs_before_artifact_verification_and_deploy():
    """Make GitHub Actions the single PRYOR production deployment owner:
    export_chunks.py must run, THEN verify_private_data_artifacts.py must
    run, THEN (and only then) the Deploy to Vercel step -- in that order --
    in both workflows. A reordering here would silently defeat the whole
    point of the artifact check."""
    export_step_name_by_workflow = {
        "update-reviews.yml": "Export intelligence data",
        "deploy-frontend.yml": "Export data chunks",
    }
    for filename in VERCEL_DEPLOY_WORKFLOWS:
        source = (WORKFLOWS_DIR / filename).read_text(encoding="utf-8")
        names = _step_names_in_order(source)
        export_name = export_step_name_by_workflow[filename]
        assert export_name in names, f"{filename}: expected a {export_name!r} step"
        assert "Verify private-data artifacts before deploy" in names, (
            f"{filename}: missing the 'Verify private-data artifacts before deploy' step"
        )
        assert "Deploy to Vercel" in names, f"{filename}: missing the 'Deploy to Vercel' step"
        i_export = names.index(export_name)
        i_verify = names.index("Verify private-data artifacts before deploy")
        i_deploy = names.index("Deploy to Vercel")
        assert i_export < i_verify < i_deploy, (
            f"{filename}: expected step order export ({i_export}) < verify ({i_verify}) < deploy ({i_deploy})"
        )


def test_verify_artifacts_step_actually_invokes_the_checker():
    for filename in VERCEL_DEPLOY_WORKFLOWS:
        source = (WORKFLOWS_DIR / filename).read_text(encoding="utf-8")
        verify_step = _find_step(_steps(source), "Verify private-data artifacts before deploy")
        assert "python verify_private_data_artifacts.py" in verify_step, (
            f"{filename}: the verify-artifacts step no longer appears to invoke verify_private_data_artifacts.py"
        )
        assert '--tenant-id "$TENANT_ID"' in verify_step, (
            f"{filename}: the verify-artifacts step must pass --tenant-id, same as every other tenant-aware entrypoint"
        )


def test_update_reviews_deploy_step_is_gated_on_artifact_verification():
    """update-reviews.yml's Deploy step uses `if: always()` (so a failure in
    an earlier step doesn't skip it by GitHub Actions' own default
    semantics) -- so its own condition must explicitly require the
    artifact-verification step to have succeeded, on top of the pre-existing
    integrity check."""
    source = (WORKFLOWS_DIR / "update-reviews.yml").read_text(encoding="utf-8")
    deploy_step = _find_step(_steps(source), "Deploy to Vercel")
    assert "steps.verify-artifacts.outcome == 'success'" in deploy_step, (
        "update-reviews.yml: 'Deploy to Vercel' must require "
        "steps.verify-artifacts.outcome == 'success' -- without it, always() "
        "would let a failed artifact check deploy anyway"
    )


def test_deploy_step_uses_force_to_skip_build_cache():
    """Fix confirmed production /api/data 404s: root-caused (controlled
    local reproduction vs. every real deployment log showing 'Restored
    build cache') to Vercel's build-cache restoration, not a vercel.json/
    code defect. --force skips that cache; --with-cache would defeat the
    whole point, so this also guards against that ever being added."""
    for filename in VERCEL_DEPLOY_WORKFLOWS:
        source = (WORKFLOWS_DIR / filename).read_text(encoding="utf-8")
        deploy_step = _find_step(_steps(source), "Deploy to Vercel")
        assert "--force" in deploy_step, f"{filename}: 'Deploy to Vercel' must pass --force to skip the build cache"
        assert "--with-cache" not in deploy_step, f"{filename}: 'Deploy to Vercel' must never pass --with-cache alongside --force"


def test_bundle_verification_step_runs_before_deploy_and_builds_from_repo_root():
    """The new post-build bundle check must run AFTER export/artifact
    verification and BEFORE deploy, from the repo root (same reasoning as
    the Deploy step itself -- see test_deploy_to_vercel_step_never_cds_into_dashboard),
    so `vercel build`'s monorepo-aware Root Directory resolution matches
    exactly what the real Deploy step does."""
    verify_artifacts_step_name_by_workflow = {
        "update-reviews.yml": "Verify private-data artifacts before deploy",
        "deploy-frontend.yml": "Verify private-data artifacts before deploy",
    }
    for filename in VERCEL_DEPLOY_WORKFLOWS:
        source = (WORKFLOWS_DIR / filename).read_text(encoding="utf-8")
        blocks = _steps(source)
        names = []
        for block in blocks:
            m = re.search(r"^      - name:\s*(.+)$", block, re.MULTILINE)
            names.append(m.group(1).strip() if m else None)
        bundle_step_name = "Build and verify serverless bundle includes required artifacts"
        assert bundle_step_name in names, f"{filename}: missing the {bundle_step_name!r} step"
        assert "Deploy to Vercel" in names, f"{filename}: missing the 'Deploy to Vercel' step"
        artifacts_name = verify_artifacts_step_name_by_workflow[filename]
        assert artifacts_name in names, f"{filename}: missing the {artifacts_name!r} step"
        i_artifacts = names.index(artifacts_name)
        i_bundle = names.index(bundle_step_name)
        i_deploy = names.index("Deploy to Vercel")
        assert i_artifacts < i_bundle < i_deploy, (
            f"{filename}: expected step order artifacts ({i_artifacts}) < bundle-verify ({i_bundle}) < deploy ({i_deploy})"
        )

        bundle_step = _find_step(blocks, bundle_step_name)
        # _steps() attributes trailing comment lines (before the NEXT step's
        # "- name:") to the current block, same as _find_step's own callers
        # elsewhere in this file -- exclude comment lines here too (this
        # step happens to be followed by a comment that legitimately
        # discusses "cd dashboard" as prose, same reasoning as
        # test_no_workflow_ever_produces_a_doubled_dashboard_path below).
        bundle_step_code_only = "\n".join(
            line for line in bundle_step.split("\n") if not line.strip().startswith("#")
        )
        assert "vercel build" in bundle_step_code_only, f"{filename}: the bundle-verify step must actually run `vercel build`"
        assert "cd dashboard" not in bundle_step_code_only and "working-directory: dashboard" not in bundle_step_code_only, (
            f"{filename}: the bundle-verify step must build from the repo root, same as the Deploy step -- "
            f"otherwise Root Directory=dashboard would apply a second time, same class of bug as the doubled-path fix"
        )
        assert "--bundle-config" in bundle_step_code_only and "verify_private_data_artifacts.py" in bundle_step_code_only, (
            f"{filename}: the bundle-verify step must actually check the built function's filePathMap"
        )


def test_bundle_verification_is_non_blocking_and_never_gates_deploy():
    """Corrected after two real dispatches both failed at `vercel pull`
    (CI's --token-only auth can't retrieve Project Settings the way it can
    for the already-proven-reliable `vercel --prod`) -- the experimental
    bundle check must never again be able to block a real deploy. Requires
    continue-on-error: true on the bundle-verify step, and the Deploy step
    must not reference steps.verify-bundle.outcome anywhere. The REQUIRED,
    still-blocking gate is 'Verify private-data artifacts before deploy',
    checked separately below."""
    bundle_step_name = "Build and verify serverless bundle includes required artifacts"
    for filename in VERCEL_DEPLOY_WORKFLOWS:
        source = (WORKFLOWS_DIR / filename).read_text(encoding="utf-8")
        bundle_step = _find_step(_steps(source), bundle_step_name)
        assert "continue-on-error: true" in bundle_step, (
            f"{filename}: {bundle_step_name!r} must set continue-on-error: true so its own "
            f"CI-auth failure can never block the Deploy step"
        )
        deploy_step = _find_step(_steps(source), "Deploy to Vercel")
        assert "verify-bundle" not in deploy_step, (
            f"{filename}: 'Deploy to Vercel' must not reference steps.verify-bundle at all -- "
            f"the bundle check is diagnostics-only, never a deployment gate"
        )


def test_required_artifact_assertion_still_blocks_deploy():
    """The one gate this correction must NOT weaken: a genuinely missing/stale
    private-data artifact must still prevent deployment."""
    for filename in VERCEL_DEPLOY_WORKFLOWS:
        source = (WORKFLOWS_DIR / filename).read_text(encoding="utf-8")
        deploy_step = _find_step(_steps(source), "Deploy to Vercel")
        if filename == "update-reviews.yml":
            # This workflow's steps use if: always(), so the dependency must
            # be explicit in the condition.
            assert "steps.verify-artifacts.outcome == 'success'" in deploy_step, (
                f"{filename}: 'Deploy to Vercel' must still require "
                f"steps.verify-artifacts.outcome == 'success'"
            )
        else:
            # deploy-frontend.yml has no if: always() anywhere -- GitHub
            # Actions' own default semantics (a failed step stops the job)
            # already make this blocking, as long as the artifact-check step
            # itself has no continue-on-error.
            artifacts_step = _find_step(_steps(source), "Verify private-data artifacts before deploy")
            assert "continue-on-error" not in artifacts_step, (
                f"{filename}: 'Verify private-data artifacts before deploy' must stay blocking "
                f"(no continue-on-error) -- this is the required production gate"
            )


def test_force_flag_still_present_on_deploy():
    for filename in VERCEL_DEPLOY_WORKFLOWS:
        source = (WORKFLOWS_DIR / filename).read_text(encoding="utf-8")
        deploy_step = _find_step(_steps(source), "Deploy to Vercel")
        assert "--force" in deploy_step, f"{filename}: 'Deploy to Vercel' must still pass --force"


def test_vercel_project_org_ids_unchanged_by_this_fix():
    """Regression guard: this phase explicitly must NOT touch
    VERCEL_TOKEN/VERCEL_PROJECT_ID/VERCEL_ORG_ID/Root Directory -- proves
    the two IDs the workflow passes are still exactly the ones the real,
    currently-linked pryor-os project uses (see .vercel/repo.json)."""
    for filename in VERCEL_DEPLOY_WORKFLOWS:
        source = (WORKFLOWS_DIR / filename).read_text(encoding="utf-8")
        deploy_step = _find_step(_steps(source), "Deploy to Vercel")
        assert f"VERCEL_ORG_ID: {EXPECTED_VERCEL_ORG_ID}" in deploy_step, (
            f"{filename}: VERCEL_ORG_ID must remain {EXPECTED_VERCEL_ORG_ID} -- this fix must not touch it"
        )
        assert f"VERCEL_PROJECT_ID: {EXPECTED_VERCEL_PROJECT_ID}" in deploy_step, (
            f"{filename}: VERCEL_PROJECT_ID must remain {EXPECTED_VERCEL_PROJECT_ID} -- this fix must not touch it"
        )


def main() -> int:
    tests = [
        ("every workflow that invokes vercel is covered by this suite", test_every_vercel_invoking_workflow_is_covered),
        ("the 'Deploy to Vercel' step never cd's into (or sets working-directory to) dashboard", test_deploy_to_vercel_step_never_cds_into_dashboard),
        ("the 'Deploy to Vercel' step genuinely still invokes `vercel --prod`", test_deploy_to_vercel_step_actually_invokes_vercel),
        ("dashboard's own npm install/build step is still correctly scoped to dashboard/", test_dashboard_install_and_build_still_scoped_to_dashboard),
        ("no workflow contains the literal doubled path 'dashboard/dashboard'", test_no_workflow_ever_produces_a_doubled_dashboard_path),
        ("VERCEL_ORG_ID/VERCEL_PROJECT_ID remain unchanged by this fix", test_vercel_project_org_ids_unchanged_by_this_fix),
        ("export -> verify-artifacts -> deploy step order holds in both workflows", test_data_generation_pipeline_runs_before_artifact_verification_and_deploy),
        ("the verify-artifacts step actually invokes verify_private_data_artifacts.py", test_verify_artifacts_step_actually_invokes_the_checker),
        ("update-reviews.yml's Deploy step is gated on artifact verification success", test_update_reviews_deploy_step_is_gated_on_artifact_verification),
        ("the Deploy step uses --force to skip the build cache, never --with-cache", test_deploy_step_uses_force_to_skip_build_cache),
        ("the bundle-verification step runs after artifacts and before deploy, from the repo root", test_bundle_verification_step_runs_before_deploy_and_builds_from_repo_root),
        ("bundle verification is non-blocking and never gates deploy", test_bundle_verification_is_non_blocking_and_never_gates_deploy),
        ("the required private-data artifact assertion still blocks deploy", test_required_artifact_assertion_still_blocks_deploy),
        ("the Deploy step still passes --force", test_force_flag_still_present_on_deploy),
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
