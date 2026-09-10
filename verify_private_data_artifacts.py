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

Run directly: python verify_private_data_artifacts.py --tenant-id t_los-tres-amigos
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant whose export directory to verify. REQUIRED -- no default.")
    parser.add_argument("--bundle-config", default=None,
                         help="Path to a built api/data function's .vc-config.json (from `vercel build`). "
                              "When given, ONLY the serverless-bundle filePathMap check runs (the export "
                              "directory/freshness checks are assumed already done by an earlier, plain "
                              "invocation of this same script) -- this is the post-build verification layer, "
                              "run as its own separate CI step after `vercel build`.")
    args = parser.parse_args()

    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::verify_private_data_artifacts.py: invalid --tenant-id {args.tenant_id!r}")
        return 1

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


if __name__ == "__main__":
    raise SystemExit(main())
