"""
Regression tests for verify_private_data_artifacts.py -- every case runs
against a scratch export directory inside a tempfile.TemporaryDirectory() and
a synthetic data.js source string. The real dashboard/api/data.js and
dashboard/private-data/ are only touched by the two "real repository" tests
at the bottom, which read (never write) them.

Run directly: py tests/test_verify_private_data_artifacts.py
"""
import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import verify_private_data_artifacts as vpda

REPO_ROOT = Path(__file__).resolve().parent.parent

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


SAMPLE_DATA_JS = """
const EXACT_ALLOWLIST = new Set([
  'meta.json',
  'action-items.json',
  'intelligence/complaint-intelligence.json',
])
"""


def test_extract_exact_allowlist_parses_real_shape():
    entries = vpda.extract_exact_allowlist(SAMPLE_DATA_JS)
    assert entries == ['meta.json', 'action-items.json', 'intelligence/complaint-intelligence.json'], entries


def test_extract_exact_allowlist_raises_on_missing_block():
    try:
        vpda.extract_exact_allowlist("// no allowlist here at all")
        raise AssertionError("expected ValueError for missing EXACT_ALLOWLIST block")
    except ValueError:
        pass


def test_extract_exact_allowlist_raises_on_empty_block():
    try:
        vpda.extract_exact_allowlist("const EXACT_ALLOWLIST = new Set([\n])")
        raise AssertionError("expected ValueError for an empty EXACT_ALLOWLIST block")
    except ValueError:
        pass


def _write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj), encoding="utf-8")


def test_check_required_files_all_present():
    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp)
        required = ['meta.json', 'intelligence/complaint-intelligence.json']
        for rel in required:
            _write(export_dir / rel, {})
        ok, missing = vpda.check_required_files(export_dir, required)
        assert ok, missing
        assert missing == []


def test_check_required_files_reports_every_missing_one():
    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp)
        _write(export_dir / "meta.json", {})
        required = ['meta.json', 'intelligence/complaint-intelligence.json', 'action-items.json']
        ok, missing = vpda.check_required_files(export_dir, required)
        assert not ok
        assert set(missing) == {'intelligence/complaint-intelligence.json', 'action-items.json'}, missing


def test_meta_freshness_missing_file_fails():
    with tempfile.TemporaryDirectory() as tmp:
        ok, message = vpda.check_meta_freshness(Path(tmp), datetime.now(timezone.utc))
        assert not ok
        assert "does not exist" in message


def test_meta_freshness_invalid_json_fails():
    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp)
        (export_dir / "meta.json").write_text("{not valid json", encoding="utf-8")
        ok, message = vpda.check_meta_freshness(export_dir, datetime.now(timezone.utc))
        assert not ok
        assert "not valid JSON" in message


def test_meta_freshness_missing_generated_at_fails():
    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp)
        _write(export_dir / "meta.json", {"locations": []})
        ok, message = vpda.check_meta_freshness(export_dir, datetime.now(timezone.utc))
        assert not ok
        assert "generatedAt" in message


def test_meta_freshness_fresh_timestamp_passes():
    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp)
        now = datetime.now(timezone.utc)
        _write(export_dir / "meta.json", {"generatedAt": now.isoformat()})
        ok, message = vpda.check_meta_freshness(export_dir, now)
        assert ok, message


def test_meta_freshness_stale_timestamp_fails():
    """The exact scenario that motivated this check: a meta.json left over
    from days ago (e.g. the Sep 6 deployment investigation) must never pass
    as if it were this run's own fresh export."""
    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp)
        now = datetime.now(timezone.utc)
        stale = now - timedelta(days=4)
        _write(export_dir / "meta.json", {"generatedAt": stale.isoformat()})
        ok, message = vpda.check_meta_freshness(export_dir, now)
        assert not ok
        assert "old" in message


def test_meta_freshness_future_timestamp_fails():
    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp)
        now = datetime.now(timezone.utc)
        future = now + timedelta(hours=2)
        _write(export_dir / "meta.json", {"generatedAt": future.isoformat()})
        ok, message = vpda.check_meta_freshness(export_dir, now)
        assert not ok
        assert "future" in message


def test_meta_freshness_within_window_boundary_passes():
    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp)
        now = datetime.now(timezone.utc)
        almost_stale = now - timedelta(minutes=vpda.MAX_META_AGE_MINUTES - 1)
        _write(export_dir / "meta.json", {"generatedAt": almost_stale.isoformat()})
        ok, message = vpda.check_meta_freshness(export_dir, now)
        assert ok, message


def test_bundle_check_missing_config_fails():
    with tempfile.TemporaryDirectory() as tmp:
        ok, missing = vpda.check_bundle_file_path_map(Path(tmp) / "does-not-exist.json", ['meta.json'])
        assert not ok
        assert any("does not exist" in m for m in missing)


def test_bundle_check_invalid_json_fails():
    with tempfile.TemporaryDirectory() as tmp:
        config_path = Path(tmp) / ".vc-config.json"
        config_path.write_text("{not valid json", encoding="utf-8")
        ok, missing = vpda.check_bundle_file_path_map(config_path, ['meta.json'])
        assert not ok
        assert any("not valid JSON" in m for m in missing)


def test_bundle_check_all_present_passes():
    with tempfile.TemporaryDirectory() as tmp:
        config_path = Path(tmp) / ".vc-config.json"
        _write(config_path, {"filePathMap": {
            "dashboard/private-data/meta.json": "dashboard/private-data/meta.json",
            "dashboard/private-data/analytics/kpis.json": "dashboard/private-data/analytics/kpis.json",
        }})
        ok, missing = vpda.check_bundle_file_path_map(config_path, ['meta.json', 'analytics/kpis.json'])
        assert ok, missing


def test_bundle_check_reports_every_missing_file():
    """The exact scenario this investigation found: files present in the
    export directory but absent from the deployed function's filePathMap."""
    with tempfile.TemporaryDirectory() as tmp:
        config_path = Path(tmp) / ".vc-config.json"
        _write(config_path, {"filePathMap": {
            "dashboard/private-data/meta.json": "dashboard/private-data/meta.json",
        }})
        required = ['meta.json', 'analytics/kpis.json', 'intelligence/complaint-intelligence.json']
        ok, missing = vpda.check_bundle_file_path_map(config_path, required)
        assert not ok
        assert set(missing) == {'analytics/kpis.json', 'intelligence/complaint-intelligence.json'}, missing


def test_bundle_check_empty_file_path_map_fails_for_any_required_file():
    with tempfile.TemporaryDirectory() as tmp:
        config_path = Path(tmp) / ".vc-config.json"
        _write(config_path, {"filePathMap": {}})
        ok, missing = vpda.check_bundle_file_path_map(config_path, ['meta.json'])
        assert not ok
        assert missing == ['meta.json']


# --- Phase A.1 CI hardening: --target google -------------------------------

def test_expand_include_files_pattern_no_braces_returns_literal():
    assert vpda.expand_include_files_pattern("private-data/**") == ["private-data/**"]


def test_expand_include_files_pattern_expands_brace_group():
    result = vpda.expand_include_files_pattern("private-data/_internal/{a.json,b.json}")
    assert result == ["private-data/_internal/a.json", "private-data/_internal/b.json"], result


def test_expand_include_files_pattern_three_way_brace_with_prefix_only():
    result = vpda.expand_include_files_pattern("private-data/{x.json,y.json,z.json}")
    assert result == ["private-data/x.json", "private-data/y.json", "private-data/z.json"], result


def test_check_vercel_config_requires_passes_when_both_declared():
    with tempfile.TemporaryDirectory() as tmp:
        vercel_json = Path(tmp) / "vercel.json"
        _write(vercel_json, {"functions": {"api/google/[action].js": {
            "includeFiles": "private-data/_internal/{review-location-index.json,gbp-location-link-map.json}"
        }}})
        ok, missing = vpda.check_vercel_config_requires(vercel_json, "api/google/[action].js", vpda.GOOGLE_REQUIRED_RELPATHS)
        assert ok, missing


def test_check_vercel_config_requires_fails_when_one_entry_missing():
    """The exact scenario item 6 asks for: google includeFiles missing
    either entry must fail."""
    with tempfile.TemporaryDirectory() as tmp:
        vercel_json = Path(tmp) / "vercel.json"
        _write(vercel_json, {"functions": {"api/google/[action].js": {
            "includeFiles": "private-data/_internal/review-location-index.json"
        }}})
        ok, missing = vpda.check_vercel_config_requires(vercel_json, "api/google/[action].js", vpda.GOOGLE_REQUIRED_RELPATHS)
        assert not ok
        assert missing == ["_internal/gbp-location-link-map.json"], missing


def test_check_vercel_config_requires_fails_when_function_missing_entirely():
    with tempfile.TemporaryDirectory() as tmp:
        vercel_json = Path(tmp) / "vercel.json"
        _write(vercel_json, {"functions": {}})
        try:
            vpda.check_vercel_config_requires(vercel_json, "api/google/[action].js", vpda.GOOGLE_REQUIRED_RELPATHS)
            raise AssertionError("expected ValueError for a missing function entry")
        except ValueError:
            pass


def test_check_valid_nonempty_json_passes_for_valid_files():
    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp)
        required = ['_internal/a.json', '_internal/b.json']
        for rel in required:
            _write(export_dir / rel, {"ok": True})
        ok, problems = vpda.check_valid_nonempty_json(export_dir, required)
        assert ok, problems


def test_check_valid_nonempty_json_fails_for_missing_file():
    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp)
        ok, problems = vpda.check_valid_nonempty_json(export_dir, ['_internal/missing.json'])
        assert not ok
        assert any("missing" in p for p in problems), problems


def test_check_valid_nonempty_json_fails_for_empty_file():
    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp)
        path = export_dir / "_internal" / "empty.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("", encoding="utf-8")
        ok, problems = vpda.check_valid_nonempty_json(export_dir, ['_internal/empty.json'])
        assert not ok
        assert any("empty" in p for p in problems), problems


def test_check_valid_nonempty_json_fails_for_malformed_json():
    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp)
        path = export_dir / "_internal" / "bad.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not valid json", encoding="utf-8")
        ok, problems = vpda.check_valid_nonempty_json(export_dir, ['_internal/bad.json'])
        assert not ok
        assert any("not valid JSON" in p for p in problems), problems


def test_check_valid_nonempty_json_never_includes_file_contents_in_output():
    """Item 6's explicit requirement: no secrets/artifact contents in
    failure output."""
    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp)
        path = export_dir / "_internal" / "secret.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        secret_marker = "TOTALLY-SECRET-CONTENT-MARKER-12345"
        path.write_text(f'{{"leak": "{secret_marker}"', encoding="utf-8")  # malformed on purpose
        ok, problems = vpda.check_valid_nonempty_json(export_dir, ['_internal/secret.json'])
        assert not ok
        joined = " ".join(problems)
        assert secret_marker not in joined, f"artifact content leaked into check output: {joined!r}"


def test_check_not_exposed_via_data_allowlist_passes_for_internal_paths():
    """The exact scenario item 6 asks for: _internal files must remain
    inaccessible through api/data."""
    ok, exposed = vpda.check_not_exposed_via_data_allowlist(SAMPLE_DATA_JS, vpda.GOOGLE_REQUIRED_RELPATHS)
    assert ok, exposed
    assert exposed == []


def test_check_not_exposed_via_data_allowlist_fails_for_exact_allowlist_member():
    ok, exposed = vpda.check_not_exposed_via_data_allowlist(SAMPLE_DATA_JS, ['meta.json'])
    assert not ok
    assert exposed == ['meta.json']


def test_check_not_exposed_via_data_allowlist_fails_for_dynamic_allowlist_match():
    ok, exposed = vpda.check_not_exposed_via_data_allowlist(SAMPLE_DATA_JS, ['insights/some-location.json'])
    assert not ok
    assert exposed == ['insights/some-location.json']


def _write_google_export_fixture(export_dir: Path) -> None:
    for rel in vpda.GOOGLE_REQUIRED_RELPATHS:
        _write(export_dir / rel, {"ok": True})


class _Args:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def test_google_target_source_mode_passes_when_everything_present():
    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp) / "export"
        _write_google_export_fixture(export_dir)
        with mock.patch.object(vpda.tenant_paths, "resolve_export_dir", return_value=export_dir):
            args = _Args(tenant_id="t_test", bundle_config=None)
            assert vpda._run_google_target(args) == 0


def test_google_target_source_mode_fails_missing_review_location_index():
    """Item 6's explicit requirement: missing review-location-index fails."""
    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp) / "export"
        _write(export_dir / "_internal/gbp-location-link-map.json", {"ok": True})
        with mock.patch.object(vpda.tenant_paths, "resolve_export_dir", return_value=export_dir):
            args = _Args(tenant_id="t_test", bundle_config=None)
            assert vpda._run_google_target(args) == 1


def test_google_target_source_mode_fails_missing_gbp_location_link_map():
    """Item 6's explicit requirement: missing gbp-location-link-map fails."""
    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp) / "export"
        _write(export_dir / "_internal/review-location-index.json", {"ok": True})
        with mock.patch.object(vpda.tenant_paths, "resolve_export_dir", return_value=export_dir):
            args = _Args(tenant_id="t_test", bundle_config=None)
            assert vpda._run_google_target(args) == 1


def test_google_target_bundle_mode_passes_when_both_mapped():
    with tempfile.TemporaryDirectory() as tmp:
        config_path = Path(tmp) / ".vc-config.json"
        _write(config_path, {"filePathMap": {
            f"dashboard/private-data/{rel}": f"dashboard/private-data/{rel}"
            for rel in vpda.GOOGLE_REQUIRED_RELPATHS
        }})
        args = _Args(tenant_id="t_test", bundle_config=str(config_path))
        assert vpda._run_google_target(args) == 0


def test_google_target_bundle_mode_fails_when_one_missing():
    with tempfile.TemporaryDirectory() as tmp:
        config_path = Path(tmp) / ".vc-config.json"
        _write(config_path, {"filePathMap": {
            "dashboard/private-data/_internal/review-location-index.json": "dashboard/private-data/_internal/review-location-index.json",
        }})
        args = _Args(tenant_id="t_test", bundle_config=str(config_path))
        assert vpda._run_google_target(args) == 1


def test_target_defaults_to_data_for_backward_compatibility():
    """Item 6's explicit requirement: data-function verification still
    works unchanged. Every pre-Phase-A.1 caller of this script omits
    --target entirely -- so the default MUST stay 'data', or every existing
    invocation (in both workflow files, and in this same test file's own
    "real repository" checks below) would silently start checking the
    wrong function's requirements."""
    orig_argv = sys.argv
    try:
        sys.argv = ["verify_private_data_artifacts.py", "--tenant-id", "t_test"]
        with mock.patch.object(vpda, "_run_data_target", return_value=0) as run_data, \
             mock.patch.object(vpda, "_run_google_target", return_value=0) as run_google, \
             mock.patch.object(vpda.tenant_keys, "is_valid_tenant_id", return_value=True):
            assert vpda.main() == 0
            assert run_data.call_count == 1, "omitting --target must still dispatch to the data-target function"
            assert run_google.call_count == 0
    finally:
        sys.argv = orig_argv


def test_target_google_dispatches_to_google_target_function():
    orig_argv = sys.argv
    try:
        sys.argv = ["verify_private_data_artifacts.py", "--tenant-id", "t_test", "--target", "google"]
        with mock.patch.object(vpda, "_run_data_target", return_value=0) as run_data, \
             mock.patch.object(vpda, "_run_google_target", return_value=0) as run_google, \
             mock.patch.object(vpda.tenant_keys, "is_valid_tenant_id", return_value=True):
            assert vpda.main() == 0
            assert run_google.call_count == 1
            assert run_data.call_count == 0
    finally:
        sys.argv = orig_argv


def test_real_vercel_json_google_function_declares_both_required_files():
    """Guards the real dashboard/vercel.json against ever silently dropping
    one of the two required includeFiles entries for api/google/[action].js."""
    ok, missing = vpda.check_vercel_config_requires(
        vpda.VERCEL_JSON_PATH, vpda.GOOGLE_FUNCTION_KEY, vpda.GOOGLE_REQUIRED_RELPATHS)
    assert ok, f"dashboard/vercel.json is missing required google includeFiles entries: {missing}"


def test_real_google_required_relpaths_not_exposed_via_real_data_js():
    """Guards the real dashboard/api/data.js against ever accidentally
    exposing an _internal/ file via the public allowlist."""
    ok, exposed = vpda.check_not_exposed_via_data_allowlist(
        vpda.DATA_JS_PATH.read_text(encoding="utf-8"), vpda.GOOGLE_REQUIRED_RELPATHS)
    assert ok, f"required google-function file(s) are exposed via /api/data's real allowlist: {exposed}"


# --- Real-repository checks: no writes, no mutation -------------------------

def test_real_data_js_exact_allowlist_is_parseable():
    """Guards against extract_exact_allowlist() silently going stale if
    data.js's EXACT_ALLOWLIST block is ever reshaped."""
    source = vpda.DATA_JS_PATH.read_text(encoding="utf-8")
    entries = vpda.extract_exact_allowlist(source)
    assert 'meta.json' in entries, entries
    assert 'action-items.json' in entries, entries
    assert len(entries) >= 10, f"expected the real EXACT_ALLOWLIST to have many entries, got {len(entries)}"


def test_vercel_json_disables_native_git_deployments():
    """Static regression guard for the actual production fix this test file
    accompanies -- Vercel's native Git integration must stay disabled so
    GitHub Actions' `vercel --prod` step (which always runs the data
    pipeline first) is the only path to production."""
    import json as _json
    vercel_json_path = REPO_ROOT / "dashboard" / "vercel.json"
    config = _json.loads(vercel_json_path.read_text(encoding="utf-8"))
    assert config.get("git", {}).get("deploymentEnabled") is False, (
        "dashboard/vercel.json must set git.deploymentEnabled: false -- "
        "see 'Make GitHub Actions the single PRYOR production deployment owner'"
    )
    # Everything else this fix was told to preserve exactly:
    assert config.get("buildCommand") == "npm run build"
    assert config.get("outputDirectory") == "dist"
    assert config.get("framework") == "vite"
    assert "functions" in config
    assert "rewrites" in config


def main() -> int:
    tests = [
        ("extract_exact_allowlist parses the real Set([...]) shape", test_extract_exact_allowlist_parses_real_shape),
        ("extract_exact_allowlist raises on a missing block", test_extract_exact_allowlist_raises_on_missing_block),
        ("extract_exact_allowlist raises on an empty block", test_extract_exact_allowlist_raises_on_empty_block),
        ("check_required_files passes when everything exists", test_check_required_files_all_present),
        ("check_required_files reports every missing file", test_check_required_files_reports_every_missing_one),
        ("check_meta_freshness fails when meta.json is missing", test_meta_freshness_missing_file_fails),
        ("check_meta_freshness fails on invalid JSON", test_meta_freshness_invalid_json_fails),
        ("check_meta_freshness fails when generatedAt is missing", test_meta_freshness_missing_generated_at_fails),
        ("check_meta_freshness passes for a fresh timestamp", test_meta_freshness_fresh_timestamp_passes),
        ("check_meta_freshness fails for a stale (days-old) timestamp", test_meta_freshness_stale_timestamp_fails),
        ("check_meta_freshness fails for a future timestamp", test_meta_freshness_future_timestamp_fails),
        ("check_meta_freshness passes just inside the freshness window", test_meta_freshness_within_window_boundary_passes),
        ("check_bundle_file_path_map fails when the config file is missing", test_bundle_check_missing_config_fails),
        ("check_bundle_file_path_map fails on invalid JSON", test_bundle_check_invalid_json_fails),
        ("check_bundle_file_path_map passes when every required file is mapped", test_bundle_check_all_present_passes),
        ("check_bundle_file_path_map reports every missing file -- the exact bug this investigation found", test_bundle_check_reports_every_missing_file),
        ("check_bundle_file_path_map fails for any required file against an empty map", test_bundle_check_empty_file_path_map_fails_for_any_required_file),
        ("the real data.js EXACT_ALLOWLIST is parseable and non-trivial", test_real_data_js_exact_allowlist_is_parseable),
        ("dashboard/vercel.json disables native Git deployments", test_vercel_json_disables_native_git_deployments),

        # --- Phase A.1 CI hardening: --target google ---
        ("expand_include_files_pattern returns the literal string when there's no brace group", test_expand_include_files_pattern_no_braces_returns_literal),
        ("expand_include_files_pattern expands a 2-item brace group", test_expand_include_files_pattern_expands_brace_group),
        ("expand_include_files_pattern expands a 3-item brace group with only a prefix", test_expand_include_files_pattern_three_way_brace_with_prefix_only),
        ("check_vercel_config_requires passes when both required files are declared", test_check_vercel_config_requires_passes_when_both_declared),
        ("check_vercel_config_requires fails when google includeFiles is missing one entry", test_check_vercel_config_requires_fails_when_one_entry_missing),
        ("check_vercel_config_requires raises when the function entry is missing entirely", test_check_vercel_config_requires_fails_when_function_missing_entirely),
        ("check_valid_nonempty_json passes for valid, non-empty files", test_check_valid_nonempty_json_passes_for_valid_files),
        ("check_valid_nonempty_json fails for a missing file", test_check_valid_nonempty_json_fails_for_missing_file),
        ("check_valid_nonempty_json fails for an empty file", test_check_valid_nonempty_json_fails_for_empty_file),
        ("check_valid_nonempty_json fails for malformed JSON", test_check_valid_nonempty_json_fails_for_malformed_json),
        ("check_valid_nonempty_json never leaks artifact contents into its output", test_check_valid_nonempty_json_never_includes_file_contents_in_output),
        ("check_not_exposed_via_data_allowlist passes for _internal-shaped paths", test_check_not_exposed_via_data_allowlist_passes_for_internal_paths),
        ("check_not_exposed_via_data_allowlist fails for an EXACT_ALLOWLIST member", test_check_not_exposed_via_data_allowlist_fails_for_exact_allowlist_member),
        ("check_not_exposed_via_data_allowlist fails for a DYNAMIC_ALLOWLIST match", test_check_not_exposed_via_data_allowlist_fails_for_dynamic_allowlist_match),
        ("--target google source mode passes when both required files are present", test_google_target_source_mode_passes_when_everything_present),
        ("--target google source mode fails when review-location-index.json is missing", test_google_target_source_mode_fails_missing_review_location_index),
        ("--target google source mode fails when gbp-location-link-map.json is missing", test_google_target_source_mode_fails_missing_gbp_location_link_map),
        ("--target google bundle mode passes when both files are mapped", test_google_target_bundle_mode_passes_when_both_mapped),
        ("--target google bundle mode fails when one file is missing from the map", test_google_target_bundle_mode_fails_when_one_missing),
        ("--target defaults to 'data' for full backward compatibility", test_target_defaults_to_data_for_backward_compatibility),
        ("--target google dispatches to the google-target function", test_target_google_dispatches_to_google_target_function),
        ("the real dashboard/vercel.json declares both required google includeFiles entries", test_real_vercel_json_google_function_declares_both_required_files),
        ("the real required google files are not exposed via the real data.js allowlist", test_real_google_required_relpaths_not_exposed_via_real_data_js),
    ]
    for name, fn in tests:
        run(name, fn)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
