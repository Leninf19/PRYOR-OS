"""
verify_private_data_artifacts.py -- run in the CI pipeline AFTER
export_chunks.py and BEFORE `vercel --prod`. Fails the job (non-zero exit)
if any file dashboard/api/data.js's EXACT_ALLOWLIST requires is missing from
the tenant's export directory, or if meta.json is unparsable or doesn't look
like it came from this same pipeline run.

WHY THIS EXISTS: "Make GitHub Actions the single PRYOR production deployment
owner" investigation proved two independent deployment mechanisms had been
competing for the same production aliases -- our GitHub Actions `vercel --prod`
step (which always runs export_chunks.py first) and Vercel's own native Git
integration (which does NOT, and can deploy whatever private-data/** happens
to be committed to git -- a stale, months-old baseline). Disabling native Git
deployments (dashboard/vercel.json's git.deploymentEnabled) closes that
specific hole, but this check is the second, independent layer: even with
native deploys disabled, a future bug in export_chunks.py (a silently caught
exception, a tenant/path mixup, a partial write) must never let `vercel --prod`
proceed and ship stale or incomplete private-data. Missing required artifacts
must fail CI, not deploy silently.

DELIBERATELY reads EXACT_ALLOWLIST directly out of dashboard/api/data.js
rather than maintaining a second, hand-copied list here -- a second list
would drift the moment someone adds a file to one and forgets the other,
which defeats the point of a safety check. DYNAMIC_ALLOWLIST (per-location
files named after live DB rows) is intentionally NOT checked here: the exact
set of locations is data-dependent and already independently validated by
export_chunks.py's own "Location analytics validation" step and
check_db_integrity.py -- this check only guards the FIXED, tenant-wide file
set every EXACT_ALLOWLIST entry represents.

--target {data,google} (Phase A.1 CI hardening): this script originally only
ever verified api/data.js's requirements. `--target google` adds a second,
independent verification target for api/google/[action].js's own private
runtime requirements (GOOGLE_REQUIRED_RELPATHS below) -- unlike EXACT_ALLOWLIST,
this list is a deliberate, hand-maintained SECURITY REQUIREMENT constant, not
parsed out of vercel.json, because the whole point of one of its checks
(check_vercel_config_requires) is to verify vercel.json still DECLARES these
files -- parsing the requirement out of the thing being checked would make
that check tautological. `--target` defaults to "data" and that target's
behavior is completely unchanged from before this constant existed.

Run directly:
  python verify_private_data_artifacts.py --tenant-id t_los-tres-amigos
  python verify_private_data_artifacts.py --tenant-id t_los-tres-amigos --target google
"""
import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import tenant_keys
import tenant_paths

BASE_DIR = Path(__file__).resolve().parent
DATA_JS_PATH = BASE_DIR / "dashboard" / "api" / "data.js"
VERCEL_JSON_PATH = BASE_DIR / "dashboard" / "vercel.json"
GOOGLE_FUNCTION_KEY = "api/google/[action].js"

# The private runtime files api/google/[action].js's fallback-resolution path
# (gbpLocationAuthorization.js) requires to run at all -- a security
# requirement fixed by the Phase A audit, not something derived from any
# other file (see the --target note above for why this is a hardcoded
# constant rather than parsed out of vercel.json). Deliberately small and
# explicit: if this function ever needs a third private runtime file, it
# must be added here AND to dashboard/vercel.json's own includeFiles
# consciously, in the same commit -- check_vercel_config_requires() below
# fails loudly if the two ever disagree.
GOOGLE_REQUIRED_RELPATHS = [
    "_internal/review-location-index.json",
    "_internal/gbp-location-link-map.json",
]

# meta.json's generatedAt (set by export_chunks.py's export_meta(), always
# datetime.now(timezone.utc).isoformat() at export time) must be within this
# many minutes of "now" when this check runs. This check runs in the same
# CI job, immediately after export_chunks.py -- a wide margin absorbs normal
# job-step latency without weakening the check's actual purpose: catching a
# meta.json that was NOT regenerated this run (e.g. left over from a failed
# earlier step, or a tenant/path mixup) rather than one that genuinely was.
MAX_META_AGE_MINUTES = 30


def extract_exact_allowlist(data_js_source: str) -> list[str]:
    """Parses the EXACT_ALLOWLIST = new Set([...]) block out of data.js's
    source text. Deliberately a narrow, literal regex over quoted strings
    within that one block -- not a JS parser -- since the block is a plain
    array literal of string constants with no interpolation or logic."""
    match = re.search(r"EXACT_ALLOWLIST\s*=\s*new Set\(\[(.*?)\]\)", data_js_source, re.DOTALL)
    if not match:
        raise ValueError("could not find EXACT_ALLOWLIST = new Set([...]) in data.js -- has its shape changed?")
    entries = re.findall(r"'([^']+)'", match.group(1))
    if not entries:
        raise ValueError("EXACT_ALLOWLIST block found but contained no quoted file paths -- refusing to pass a check with nothing to check")
    return entries


def check_required_files(export_dir: Path, required: list[str]) -> tuple[bool, list[str]]:
    """Pure: returns (ok, missing_relative_paths). Never touches anything
    outside export_dir/required -- independently testable against a scratch
    directory."""
    missing = [relpath for relpath in required if not (export_dir / relpath).is_file()]
    return len(missing) == 0, missing


def check_meta_freshness(export_dir: Path, now: datetime, max_age_minutes: int = MAX_META_AGE_MINUTES) -> tuple[bool, str]:
    """Pure except for the one file read: returns (ok, message). Validates
    meta.json parses as JSON, has a generatedAt field, and that timestamp is
    recent relative to `now` (caller-supplied so this is testable without
    real wall-clock dependence)."""
    meta_path = export_dir / "meta.json"
    if not meta_path.is_file():
        return False, f"{meta_path} does not exist"

    try:
        raw = meta_path.read_text(encoding="utf-8")
    except OSError as e:
        return False, f"could not read {meta_path}: {e}"

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        return False, f"{meta_path} exists but is not valid JSON: {e}"

    generated_at = parsed.get("generatedAt")
    if not generated_at or not isinstance(generated_at, str):
        return False, f"{meta_path} has no usable generatedAt field"

    try:
        generated_dt = datetime.fromisoformat(generated_at)
    except ValueError as e:
        return False, f"{meta_path}'s generatedAt {generated_at!r} is not a valid ISO timestamp: {e}"

    if generated_dt.tzinfo is None:
        generated_dt = generated_dt.replace(tzinfo=timezone.utc)

    age_minutes = (now - generated_dt).total_seconds() / 60
    if age_minutes > max_age_minutes:
        return False, (
            f"{meta_path}'s generatedAt is {generated_at} -- {age_minutes:.1f} minutes old, "
            f"older than the {max_age_minutes}-minute freshness window. This looks like it was NOT "
            f"regenerated by this pipeline run -- refusing to let a stale export reach production."
        )
    if age_minutes < -max_age_minutes:
        return False, (
            f"{meta_path}'s generatedAt is {generated_at}, which is in the future relative to now "
            f"({now.isoformat()}) by more than {max_age_minutes} minutes -- clock skew or a corrupted "
            f"timestamp, either way not trustworthy enough to deploy on."
        )

    return True, f"{meta_path} generatedAt={generated_at} ({age_minutes:.1f} min old) -- fresh."


# --- Google-function-specific checks (Phase A.1 CI hardening) --------------

def expand_include_files_pattern(pattern: str) -> list[str]:
    """Expands a `prefix{a,b,c}suffix` brace-alternation string into
    ['prefixasuffix', 'prefixbsuffix', 'prefixcsuffix'], or returns
    [pattern] unchanged if it has no brace group. Deliberately narrow --
    supports exactly the ONE-brace-group, comma-separated-literals shape
    every includeFiles entry in dashboard/vercel.json actually uses today
    (nested braces and multiple groups are refused, loudly, rather than
    silently mishandled). Wildcard alternatives (e.g. "*.json") are kept
    as literal strings, never expanded against a live directory -- callers
    that need a concrete file list must not include a wildcard entry among
    their required paths."""
    if "{" not in pattern and "}" not in pattern:
        return [pattern]
    match = re.fullmatch(r"([^{}]*)\{([^{}]+)\}([^{}]*)", pattern)
    if not match:
        raise ValueError(f"unsupported includeFiles pattern shape: {pattern!r}")
    prefix, alternatives, suffix = match.groups()
    return [f"{prefix}{alt}{suffix}" for alt in alternatives.split(",")]


def extract_function_include_files(vercel_json_source: str, function_key: str) -> str:
    """Parses dashboard/vercel.json and returns the raw includeFiles string
    declared for `function_key`. Raises if the file doesn't parse as JSON,
    or the function/field is missing -- never silently treats "not found"
    as "nothing required"."""
    try:
        config = json.loads(vercel_json_source)
    except json.JSONDecodeError as e:
        raise ValueError(f"dashboard/vercel.json is not valid JSON: {e}") from e
    functions = config.get("functions") or {}
    entry = functions.get(function_key)
    if entry is None:
        raise ValueError(f"dashboard/vercel.json has no functions[{function_key!r}] entry")
    include_files = entry.get("includeFiles")
    if not include_files or not isinstance(include_files, str):
        raise ValueError(f"dashboard/vercel.json functions[{function_key!r}] has no usable includeFiles string")
    return include_files


def check_vercel_config_requires(vercel_json_path: Path, function_key: str, required: list[str]) -> tuple[bool, list[str]]:
    """Verifies dashboard/vercel.json's declared includeFiles for
    `function_key`, once brace-expanded, is a superset of `required` --
    catches a future edit that narrows or drops an entry from includeFiles
    without anyone updating GOOGLE_REQUIRED_RELPATHS to match (or vice
    versa). Pure except for the one file read.

    `required` is relative to the export directory (private-data/ itself,
    matching check_required_files()'s/check_bundle_file_path_map()'s own
    convention), but includeFiles entries in dashboard/vercel.json are
    written relative to dashboard/ -- i.e. always "private-data/<relpath>".
    The "private-data/" prefix is added here, at the comparison boundary,
    rather than baked into GOOGLE_REQUIRED_RELPATHS itself, so that one
    constant stays valid for every other required-file check in this file."""
    if not vercel_json_path.is_file():
        return False, [f"{vercel_json_path} does not exist"]
    include_files = extract_function_include_files(vercel_json_path.read_text(encoding="utf-8"), function_key)
    declared = set(expand_include_files_pattern(include_files))
    missing = [relpath for relpath in required if f"private-data/{relpath}" not in declared]
    return len(missing) == 0, missing


def check_valid_nonempty_json(export_dir: Path, required: list[str]) -> tuple[bool, list[str]]:
    """Returns (ok, problem_relpaths) -- each required file must exist, be
    non-empty, and parse as JSON. Never includes file contents in its
    return value or in any message a caller prints from it -- only the
    relative path and a short reason."""
    problems = []
    for relpath in required:
        path = export_dir / relpath
        if not path.is_file():
            problems.append(f"{relpath} (missing)")
            continue
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as e:
            problems.append(f"{relpath} (unreadable: {e})")
            continue
        if len(raw) == 0:
            problems.append(f"{relpath} (empty)")
            continue
        try:
            json.loads(raw)
        except json.JSONDecodeError:
            problems.append(f"{relpath} (not valid JSON)")
    return len(problems) == 0, problems


def check_not_exposed_via_data_allowlist(data_js_source: str, required: list[str]) -> tuple[bool, list[str]]:
    """Ports dashboard/api/data.js's own isAllowed() logic (EXACT_ALLOWLIST
    membership + the 3 DYNAMIC_ALLOWLIST slug patterns) just far enough to
    assert that none of `required`'s paths would ever be served by the
    public /api/data endpoint -- these are `_internal/`-prefixed files by
    convention specifically BECAUSE they must never reach that allowlist
    (see data.js's own header comment on the _internal/ convention).
    Returns (ok, exposed_relpaths) -- exposed_relpaths is empty on a pass."""
    exact_allowlist = set(extract_exact_allowlist(data_js_source))
    slug = r"[a-z0-9]+(?:-[a-z0-9]+)*"
    dynamic_allowlist = [
        re.compile(rf"^insights/{slug}\.json$"),
        re.compile(rf"^reviews/by-location/{slug}\.json$"),
        re.compile(rf"^intelligence/locations/{slug}\.json$"),
    ]
    exposed = [
        relpath for relpath in required
        if relpath in exact_allowlist or any(pattern.match(relpath) for pattern in dynamic_allowlist)
    ]
    return len(exposed) == 0, exposed


# --- Post-build serverless-bundle check ------------------------------------
# "Fix confirmed production /api/data 404s" investigation: files existing in
# the CI working directory before `vercel --prod` (checked above) does NOT
# prove the deployed api/data Serverless Function can actually read them at
# runtime -- dashboard/api/data.js's dynamic path construction
# (readPrivateDataFile()) is invisible to Vercel's static Node File Trace,
# which is exactly why dashboard/vercel.json declares an explicit
# `includeFiles: "private-data/**"` for that function. A `vercel build`
# (Vercel CLI 59.x+) satisfies that with a `filePathMap` in the built
# function's own .vc-config.json -- a lazily-resolved mapping, not files
# physically copied into the function's directory tree. This check proves
# that map actually lists every file EXACT_ALLOWLIST requires, using the
# EXACT path shape a monorepo-aware build (invoked from the repository root,
# exactly like the real "Deploy to Vercel" step) produces:
# "dashboard/private-data/<relpath>" -> "dashboard/private-data/<relpath>".
# Root-caused via a controlled local reproduction (a full, freshly generated
# 113-file export_chunks.py run, built with `vercel build` from the repo
# root using the same .vercel/repo.json + dashboard/.vercel/project.json
# linking the real deploy uses) that PASSED even though the real production
# deployment 404'd on these exact files -- pointing at Vercel's build-cache
# restoration (every real deploy log inspected during this investigation
# "Restored build cache from previous deployment", chained back for days)
# as the likely runtime culprit, not a config or code defect. This check is
# the second, independent layer that catches a recurrence regardless of
# which of the two turns out to be the real mechanism.
def check_bundle_file_path_map(vc_config_path: Path, required: list[str]) -> tuple[bool, list[str]]:
    """Pure except for the one file read: returns (ok, missing_relative_paths)."""
    if not vc_config_path.is_file():
        return False, [f"{vc_config_path} does not exist -- was `vercel build` run first?"]
    try:
        config = json.loads(vc_config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return False, [f"{vc_config_path} is not valid JSON: {e}"]
    file_path_map = config.get("filePathMap") or {}
    missing = [relpath for relpath in required if f"dashboard/private-data/{relpath}" not in file_path_map]
    return len(missing) == 0, missing


def _run_data_target(args) -> int:
    """Original behavior, unchanged byte-for-byte -- required = EXACT_ALLOWLIST
    parsed from dashboard/api/data.js."""
    if not DATA_JS_PATH.is_file():
        print(f"::error::verify_private_data_artifacts.py: {DATA_JS_PATH} does not exist")
        return 1

    try:
        required = extract_exact_allowlist(DATA_JS_PATH.read_text(encoding="utf-8"))
    except ValueError as e:
        print(f"::error::verify_private_data_artifacts.py: {e}")
        return 1

    if args.bundle_config is not None:
        ok_bundle, missing = check_bundle_file_path_map(Path(args.bundle_config), required)
        if not ok_bundle:
            print(f"::error::verify_private_data_artifacts.py: {len(missing)} of {len(required)} required "
                  f"private-data files are missing from the built api/data function's filePathMap "
                  f"({args.bundle_config}): {', '.join(missing)}")
            return 1
        print(f"All {len(required)} EXACT_ALLOWLIST files present in the built api/data function's filePathMap.")
        return 0

    try:
        export_dir = tenant_paths.resolve_export_dir(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::verify_private_data_artifacts.py: {e}")
        return 1

    ok_files, missing = check_required_files(export_dir, required)
    if not ok_files:
        print(f"::error::verify_private_data_artifacts.py: {len(missing)} of {len(required)} required "
              f"private-data files are missing from {export_dir}: {', '.join(missing)}")
        return 1
    print(f"All {len(required)} EXACT_ALLOWLIST files present in {export_dir}.")

    ok_fresh, message = check_meta_freshness(export_dir, datetime.now(timezone.utc))
    if not ok_fresh:
        print(f"::error::verify_private_data_artifacts.py: {message}")
        return 1
    print(message)

    return 0


def _run_google_target(args) -> int:
    """Phase A.1 CI hardening: verifies api/google/[action].js's own private
    runtime requirements (GOOGLE_REQUIRED_RELPATHS) -- distinct files, a
    distinct function, never confused with --target data's EXACT_ALLOWLIST.

    --bundle-config given: ONLY the post-build filePathMap check runs
    (mirrors --target data's own --bundle-config behavior) -- this is the
    real, physical "is it in the deployed Lambda" proof, now reliable
    because `vercel build` (see update-reviews.yml) no longer depends on
    the known-broken `vercel pull`.

    --bundle-config absent: runs every deterministic, pre-build check that
    does not require a Vercel build at all -- source files exist, are
    non-empty valid JSON, are declared in dashboard/vercel.json's own
    includeFiles for this function, and are NOT exposed via /api/data's
    allowlist. This is the check that MUST block deployment even if the
    bundle check above is ever unavailable for some future reason."""
    if args.bundle_config is not None:
        ok_bundle, missing = check_bundle_file_path_map(Path(args.bundle_config), GOOGLE_REQUIRED_RELPATHS)
        if not ok_bundle:
            print(f"::error::verify_private_data_artifacts.py: {len(missing)} of {len(GOOGLE_REQUIRED_RELPATHS)} "
                  f"required private-data files are missing from the built api/google/[action] function's "
                  f"filePathMap ({args.bundle_config}): {', '.join(missing)}")
            return 1
        print(f"All {len(GOOGLE_REQUIRED_RELPATHS)} required files present in the built "
              f"api/google/[action] function's filePathMap.")
        return 0

    try:
        export_dir = tenant_paths.resolve_export_dir(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::verify_private_data_artifacts.py: {e}")
        return 1

    ok_files, missing = check_required_files(export_dir, GOOGLE_REQUIRED_RELPATHS)
    if not ok_files:
        print(f"::error::verify_private_data_artifacts.py: {len(missing)} of {len(GOOGLE_REQUIRED_RELPATHS)} "
              f"required google-function files are missing from {export_dir}: {', '.join(missing)}")
        return 1
    print(f"All {len(GOOGLE_REQUIRED_RELPATHS)} required google-function files present in {export_dir}.")

    ok_valid, problems = check_valid_nonempty_json(export_dir, GOOGLE_REQUIRED_RELPATHS)
    if not ok_valid:
        print(f"::error::verify_private_data_artifacts.py: invalid required google-function file(s): "
              f"{', '.join(problems)}")
        return 1
    print(f"All {len(GOOGLE_REQUIRED_RELPATHS)} required google-function files are non-empty, valid JSON.")

    if not DATA_JS_PATH.is_file():
        print(f"::error::verify_private_data_artifacts.py: {DATA_JS_PATH} does not exist")
        return 1
    ok_hidden, exposed = check_not_exposed_via_data_allowlist(
        DATA_JS_PATH.read_text(encoding="utf-8"), GOOGLE_REQUIRED_RELPATHS)
    if not ok_hidden:
        print(f"::error::verify_private_data_artifacts.py: required google-function file(s) are exposed "
              f"via /api/data's allowlist, which must never happen: {', '.join(exposed)}")
        return 1
    print("None of the required google-function files are exposed via /api/data's allowlist.")

    ok_declared, missing_from_config = check_vercel_config_requires(
        VERCEL_JSON_PATH, GOOGLE_FUNCTION_KEY, GOOGLE_REQUIRED_RELPATHS)
    if not ok_declared:
        print(f"::error::verify_private_data_artifacts.py: dashboard/vercel.json's functions[{GOOGLE_FUNCTION_KEY!r}] "
              f"includeFiles does not declare required path(s): {', '.join(missing_from_config)}")
        return 1
    print(f"dashboard/vercel.json declares includeFiles for {GOOGLE_FUNCTION_KEY} covering all "
          f"{len(GOOGLE_REQUIRED_RELPATHS)} required files.")

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant whose export directory to verify. REQUIRED -- no default.")
    parser.add_argument("--target", choices=["data", "google"], default="data",
                         help="Which function's private runtime requirements to verify: 'data' (default, "
                              "unchanged original behavior -- api/data.js's EXACT_ALLOWLIST) or 'google' "
                              "(Phase A.1 -- api/google/[action].js's GOOGLE_REQUIRED_RELPATHS).")
    parser.add_argument("--bundle-config", default=None,
                         help="Path to a built function's .vc-config.json (from `vercel build`). When given, "
                              "ONLY the serverless-bundle filePathMap check runs for the selected --target "
                              "(the export directory/freshness/config checks are assumed already done by an "
                              "earlier, plain invocation of this same script) -- this is the post-build "
                              "verification layer, run as its own separate CI step after `vercel build`.")
    args = parser.parse_args()

    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::verify_private_data_artifacts.py: invalid --tenant-id {args.tenant_id!r}")
        return 1

    if args.target == "google":
        return _run_google_target(args)
    return _run_data_target(args)


if __name__ == "__main__":
    raise SystemExit(main())
