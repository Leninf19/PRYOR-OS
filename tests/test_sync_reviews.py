"""
Regression tests for sync_reviews.py (Phase 3 Milestone 4) -- the
provider-selecting CLI entrypoint. provider_sync.sync_all() is mocked
throughout (its own behavior is covered by tests/test_provider_sync.py) --
this file is about provider selection, CLI/env-var precedence, exit codes,
and GitHub Actions output compatibility.

Run directly: py tests/test_sync_reviews.py
"""
import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import sync_reviews
from provider_gbp import GBPProvider
from provider_mock import MockProvider
from provider_scraper import ScraperProvider

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def _argv(*args):
    return mock.patch.object(sys, "argv", ["sync_reviews.py", *args])


# --- Provider selection: CLI / env var / default ------------------------------

def test_resolve_provider_name_cli_flag_takes_precedence():
    with mock.patch.dict(os.environ, {"REVIEW_PROVIDER": "gbp"}):
        assert sync_reviews.resolve_provider_name("mock") == "mock"


def test_resolve_provider_name_falls_back_to_env_var():
    with mock.patch.dict(os.environ, {"REVIEW_PROVIDER": "gbp"}):
        assert sync_reviews.resolve_provider_name(None) == "gbp"


def test_resolve_provider_name_defaults_to_scraper():
    with mock.patch.dict(os.environ, {}, clear=True):
        assert sync_reviews.resolve_provider_name(None) == "scraper"


def test_build_provider_instantiates_the_correct_class():
    assert isinstance(sync_reviews.build_provider("gbp"), GBPProvider)
    assert isinstance(sync_reviews.build_provider("scraper"), ScraperProvider)
    assert isinstance(sync_reviews.build_provider("mock"), MockProvider)


def test_build_provider_rejects_unknown_name():
    try:
        sync_reviews.build_provider("not_a_real_provider")
        raise AssertionError("expected ValueError")
    except ValueError as e:
        assert "not_a_real_provider" in str(e)


# --- main(): CLI argument handling + exit codes -------------------------------

def test_main_unknown_provider_cli_arg_rejected_by_argparse():
    # argparse's `choices=` rejects an unrecognized --provider value itself,
    # before build_provider() is ever reached -- argparse exits 2 for a
    # usage error.
    with _argv("--provider", "nonsense"):
        try:
            sync_reviews.main()
            raise AssertionError("argparse should have exited on an invalid --provider choice")
        except SystemExit as e:
            assert e.code == 2


def test_main_returns_zero_on_ok_status():
    with _argv("--provider", "mock", "--fast"), \
         mock.patch("sync_reviews.provider_sync.sync_all", new=mock.AsyncMock(
             return_value={"status": "ok", "locations_succeeded": 1, "locations_failed": 0, "new": 1})):
        assert sync_reviews.main() == 0


def test_main_returns_zero_on_skipped_status():
    with _argv("--provider", "gbp"), \
         mock.patch("sync_reviews.provider_sync.sync_all", new=mock.AsyncMock(
             return_value={"status": "skipped", "reason": "not configured"})):
        assert sync_reviews.main() == 0


def test_main_returns_one_on_failed_status():
    """Phase 3 Milestone 4.1 (a deliberate architectural decision, not an
    oversight -- see sync_reviews.py's own module docstring): a total sync
    failure returns exit code 1, deliberately NOT matching auto_update.py's
    historical cloud/CI behavior of always exiting 0 regardless of scrape
    outcome. This is safe because update-reviews.yml never gates its commit
    or deploy steps on this step's own outcome -- both are gated on
    check_db_integrity.py's exit code instead (verified directly against
    update-reviews.yml during the Milestone 4b design review) -- so this
    only makes the workflow run's own reported conclusion accurately
    reflect a total failure, without changing whether anything gets
    committed or deployed."""
    with _argv("--provider", "mock", "--fast"), \
         mock.patch("sync_reviews.provider_sync.sync_all", new=mock.AsyncMock(
             return_value={"status": "failed", "reason": "simulated failure",
                           "locations_succeeded": 0, "locations_failed": 0})):
        assert sync_reviews.main() == 1


def test_main_passes_fast_flag_through_to_sync_all():
    captured = {}

    async def fake_sync_all(provider, *, fast=False):
        captured["fast"] = fast
        return {"status": "ok", "locations_succeeded": 0, "locations_failed": 0, "new": 0}

    with _argv("--provider", "mock", "--fast"), \
         mock.patch("sync_reviews.provider_sync.sync_all", new=fake_sync_all):
        sync_reviews.main()
    assert captured["fast"] is True


# --- GitHub Actions output compatibility --------------------------------------

def test_github_output_format_matches_existing_contract():
    with tempfile.TemporaryDirectory() as tmp:
        output_path = Path(tmp) / "gh_output.txt"
        new_reviews = [
            {"location": "Loc A", "reviewer_name": "Alice", "star_rating": 1, "review_text": "Bad"},
            {"location": "Loc A", "reviewer_name": "Bob", "star_rating": 5, "review_text": "Great"},
        ]
        with _argv("--provider", "mock"), \
             mock.patch.dict(os.environ, {"GITHUB_OUTPUT": str(output_path)}), \
             mock.patch("sync_reviews.provider_sync.sync_all", new=mock.AsyncMock(
                 return_value={"status": "ok", "locations_succeeded": 1, "locations_failed": 0,
                               "new": 2, "new_reviews": new_reviews})):
            sync_reviews.main()

        content = output_path.read_text(encoding="utf-8")
        assert "new_count=2" in content
        assert "negative_count=1" in content
        assert "email_html<<EOF_EMAIL" in content
        assert "Alice" in content, "the 1-star review must appear in the negative-review email"
        assert "Great" not in content, "a 5-star review must never appear in the negative-review email"


def test_no_email_html_output_for_fast_runs():
    """Matches gbp_sync.py's original behavior: the fast/critical-check path
    never touches the GH Actions output at all."""
    with tempfile.TemporaryDirectory() as tmp:
        output_path = Path(tmp) / "gh_output.txt"
        with _argv("--provider", "mock", "--fast"), \
             mock.patch.dict(os.environ, {"GITHUB_OUTPUT": str(output_path)}), \
             mock.patch("sync_reviews.provider_sync.sync_all", new=mock.AsyncMock(
                 return_value={"status": "ok", "locations_succeeded": 1, "locations_failed": 0, "new": 0})):
            sync_reviews.main()
        assert not output_path.exists(), "the --fast path must not write any GitHub Actions output"


def main():
    tests = [
        ("resolve_provider_name(): an explicit CLI flag takes precedence over the env var", test_resolve_provider_name_cli_flag_takes_precedence),
        ("resolve_provider_name(): falls back to $REVIEW_PROVIDER when no CLI flag given", test_resolve_provider_name_falls_back_to_env_var),
        ("resolve_provider_name(): defaults to 'scraper' with neither set", test_resolve_provider_name_defaults_to_scraper),
        ("build_provider(): instantiates the correct class for gbp/scraper/mock", test_build_provider_instantiates_the_correct_class),
        ("build_provider(): rejects an unrecognized provider name", test_build_provider_rejects_unknown_name),
        ("main(): argparse itself rejects an unrecognized --provider choice", test_main_unknown_provider_cli_arg_rejected_by_argparse),
        ("main(): returns 0 on an 'ok' sync result", test_main_returns_zero_on_ok_status),
        ("main(): returns 0 on a 'skipped' sync result", test_main_returns_zero_on_skipped_status),
        ("main(): returns 1 on a 'failed' sync result", test_main_returns_one_on_failed_status),
        ("main(): --fast is passed through to sync_all()", test_main_passes_fast_flag_through_to_sync_all),
        ("GitHub Actions output format matches auto_update.py/gbp_sync.py's existing contract", test_github_output_format_matches_existing_contract),
        ("the --fast path never writes GitHub Actions output", test_no_email_html_output_for_fast_runs),
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
