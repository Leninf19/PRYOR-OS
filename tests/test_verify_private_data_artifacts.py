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
