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
