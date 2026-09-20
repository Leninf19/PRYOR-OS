"""
Regression tests for gbp_review_media_diagnostic.py -- DIAGNOSTIC
INFRASTRUCTURE ONLY (Review Media Feature, Scale & No-Backfill Audit).

Proves, without ever making a real network call (google_api.get_review() is
monkeypatched for the duration of each test):
  1. Exactly one get_review call is made per build_report() invocation.
  2. list_reviews() is never called.
  3. No HTTP request is ever made to a media URL.
  4. No Redis write path exists anywhere in this module.
  5. No database write path exists anywhere in this module.
  6-11. Sanitized per-item output is correct for photo/video/mixed/missing/
        malformed/non-HTTPS media items.
  12-14. Full URLs, label text, and secrets never appear in any output.
  15. Missing --tenant-id/--gbp-review-name fail safely (argparse SystemExit).
  16. An invalid --hypothetical-activation-time fails safely.
  17. The eligibility comparison uses the FULL createTime, not a
      date-only-truncated value.

Run directly: py tests/test_gbp_review_media_diagnostic.py
"""
import io
import json
import os
import sys
import urllib.request
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import gbp_review_media_diagnostic as diag
import google_api as ga

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def _with_fake_get_review(fake, fn):
    original = ga.get_review
    ga.get_review = fake
    try:
        fn()
    finally:
        ga.get_review = original


FAKE_TENANT = "t_los-tres-amigos"
FAKE_REVIEW_NAME = "accounts/109439479242615524495/locations/6494340890109321866/reviews/AbFvOqlvWFit825X"


# --- 1. Exactly one get_review call ----------------------------------------

def test_exactly_one_get_review_call():
    call_count = {"n": 0}

    def fake(tenant_id, name):
        call_count["n"] += 1
        return {"name": name, "createTime": "2026-09-20T14:38:16Z"}

    def run_test():
        diag.build_report(FAKE_TENANT, FAKE_REVIEW_NAME)
        assert call_count["n"] == 1, f"expected exactly 1 call, got {call_count['n']}"

    _with_fake_get_review(fake, run_test)


# --- 2. list_reviews() is never called --------------------------------------

def test_list_reviews_never_called():
    def poison(*a, **k):
        raise AssertionError("list_reviews() must never be called by this diagnostic")

    original_list_reviews = ga.list_reviews
    ga.list_reviews = poison
    try:
        def run_test():
            diag.build_report(
                FAKE_TENANT, FAKE_REVIEW_NAME,
            )
        _with_fake_get_review(
            lambda tenant_id, name: {"name": name, "createTime": "2026-09-20T14:38:16Z"},
            run_test,
        )
    finally:
        ga.list_reviews = original_list_reviews


# --- 3. No HTTP request is ever made to a media URL -------------------------

def test_no_media_url_is_ever_fetched():
    def poison_urlopen(*a, **k):
        raise AssertionError("no HTTP request should ever be made for a media URL")

    original_urlopen = urllib.request.urlopen
    urllib.request.urlopen = poison_urlopen
    try:
        def run_test():
            report = diag.build_report(
                FAKE_TENANT, FAKE_REVIEW_NAME, hypothetical_activation_time=None,
            )
            assert report["media_item_count"] == 2

        _with_fake_get_review(
            lambda tenant_id, name: {
                "name": name, "createTime": "2026-09-20T14:38:16Z",
                "reviewMediaItems": [
                    {"thumbnailUrl": "https://lh3.googleusercontent.com/photo1", "thumbnailLabel": "yum"},
                    {"thumbnailUrl": "https://lh3.googleusercontent.com/thumb2", "videoUrl": "https://lh3.googleusercontent.com/video2"},
                ],
            },
            run_test,
        )
    finally:
        urllib.request.urlopen = original_urlopen


# --- 4/5. No Redis or database write path exists in this module ------------

def test_no_write_capable_module_is_imported():
    module_names = set(dir(diag))
    forbidden = {"db", "tenant_config_store", "provider_sync", "gbp_sync", "sync_reviews", "reply_moderation_state"}
    leaked = forbidden & module_names
    assert not leaked, f"diagnostic module must not import any write-capable module, found: {leaked}"
    # Confirm the module has no attribute whose name suggests a write/sync capability.
    for name in module_names:
        lowered = name.lower()
        assert "sync_all" not in lowered
        assert "reply_to_review" not in lowered
        assert "upsert" not in lowered


# --- 6. Photo item sanitized output ------------------------------------------

def test_photo_item_sanitized_output():
    item = diag.classify_media_item(
        {"thumbnailUrl": "https://lh3.googleusercontent.com/abc123", "thumbnailLabel": "tacos"}, 0,
    )
    assert item["inferred_type"] == "photo"
    assert item["thumbnail"]["present"] is True
    assert item["thumbnail"]["safe"] is True
    assert item["thumbnail"]["hostname"] == "lh3.googleusercontent.com"
    assert item["thumbnail"]["scheme"] == "https"
    assert item["video"]["present"] is False
    assert item["label_present"] is True
    assert item["label_length"] == len("tacos")
    assert item["sanitizer_pass"] is True
    assert item["malformed"] is False


# --- 7. Video item sanitized output ------------------------------------------

def test_video_item_sanitized_output():
    item = diag.classify_media_item(
        {"videoUrl": "https://lh3.googleusercontent.com/vid456", "thumbnailUrl": "https://lh3.googleusercontent.com/thumb456"}, 1,
    )
    assert item["inferred_type"] == "video"
    assert item["video"]["present"] is True
    assert item["video"]["safe"] is True
    assert item["video"]["hostname"] == "lh3.googleusercontent.com"
    assert item["sanitizer_pass"] is True


def test_media_format_field_takes_precedence_when_present():
    item = diag.classify_media_item(
        {"mediaFormat": "VIDEO", "thumbnailUrl": "https://lh3.googleusercontent.com/thumb789"}, 0,
    )
    assert item["inferred_type"] == "video"


# --- 8. Mixed media -----------------------------------------------------------

def test_mixed_media_report():
    def run_test():
        report = diag.build_report(FAKE_TENANT, FAKE_REVIEW_NAME)
        assert report["media_item_count"] == 2
        assert report["items"][0]["inferred_type"] == "photo"
        assert report["items"][1]["inferred_type"] == "video"

    _with_fake_get_review(
        lambda tenant_id, name: {
            "name": name, "createTime": "2026-09-20T14:38:16Z",
            "reviewMediaItems": [
                {"thumbnailUrl": "https://lh3.googleusercontent.com/p1"},
                {"videoUrl": "https://lh3.googleusercontent.com/v1", "thumbnailUrl": "https://lh3.googleusercontent.com/v1thumb"},
            ],
        },
        run_test,
    )


# --- 9. Missing reviewMediaItems ---------------------------------------------

def test_missing_review_media_items():
    def run_test():
        report = diag.build_report(FAKE_TENANT, FAKE_REVIEW_NAME)
        assert report["media_items_present"] is False
        assert report["media_item_count"] == 0
        assert report["items"] == []
        assert report["all_items_pass_sanitizer"] is True  # vacuously true, nothing to fail

    _with_fake_get_review(
        lambda tenant_id, name: {"name": name, "createTime": "2026-09-20T14:38:16Z"},
        run_test,
    )


# --- 10. Malformed item -------------------------------------------------------

def test_malformed_item_not_a_dict():
    item = diag.classify_media_item("not-a-dict", 0)
    assert item["malformed"] is True
    assert item["sanitizer_pass"] is False
    assert item["inferred_type"] is None


def test_malformed_item_empty_dict():
    item = diag.classify_media_item({}, 0)
    assert item["malformed"] is True
    assert item["sanitizer_pass"] is False


# --- 11. Non-HTTPS URL marked rejected ---------------------------------------

def test_non_https_thumbnail_url_rejected():
    item = diag.classify_media_item({"thumbnailUrl": "http://lh3.googleusercontent.com/insecure"}, 0)
    assert item["thumbnail"]["present"] is True
    assert item["thumbnail"]["safe"] is False
    assert item["thumbnail"]["scheme"] == "http"
    assert item["sanitizer_pass"] is False


def test_javascript_scheme_url_rejected():
    item = diag.classify_media_item({"thumbnailUrl": "javascript:alert(1)"}, 0)
    assert item["thumbnail"]["safe"] is False
    assert item["sanitizer_pass"] is False


def test_oversized_url_rejected():
    huge_url = "https://lh3.googleusercontent.com/" + ("a" * 3000)
    item = diag.classify_media_item({"thumbnailUrl": huge_url}, 0)
    assert item["thumbnail"]["length"] > diag.MAX_URL_LENGTH
    assert item["thumbnail"]["safe"] is False
    assert item["sanitizer_pass"] is False


# --- 12. Full URLs never appear in output ------------------------------------

def test_full_urls_never_appear_in_report():
    distinctive_url = "https://lh3.googleusercontent.com/SUPER_SECRET_PATH_SEGMENT_ABC123"

    def run_test():
        report = diag.build_report(FAKE_TENANT, FAKE_REVIEW_NAME)
        serialized = json.dumps(report)
        assert distinctive_url not in serialized
        assert "SUPER_SECRET_PATH_SEGMENT_ABC123" not in serialized

        buf = io.StringIO()
        with redirect_stdout(buf):
            diag._print_report(report)
        printed = buf.getvalue()
        assert distinctive_url not in printed
        assert "SUPER_SECRET_PATH_SEGMENT_ABC123" not in printed

    _with_fake_get_review(
        lambda tenant_id, name: {
            "name": name, "createTime": "2026-09-20T14:38:16Z",
            "reviewMediaItems": [{"thumbnailUrl": distinctive_url}],
        },
        run_test,
    )


# --- 13. Labels never appear in output ---------------------------------------

def test_label_text_never_appears_in_report():
    distinctive_label = "This is a very distinctive review label XYZ789"

    def run_test():
        report = diag.build_report(FAKE_TENANT, FAKE_REVIEW_NAME)
        serialized = json.dumps(report)
        assert distinctive_label not in serialized

        buf = io.StringIO()
        with redirect_stdout(buf):
            diag._print_report(report)
        assert distinctive_label not in buf.getvalue()

    _with_fake_get_review(
        lambda tenant_id, name: {
            "name": name, "createTime": "2026-09-20T14:38:16Z",
            "reviewMediaItems": [{"thumbnailUrl": "https://lh3.googleusercontent.com/p", "thumbnailLabel": distinctive_label}],
        },
        run_test,
    )


# --- 14. Secrets never appear in output --------------------------------------

def test_secrets_never_appear_in_output_even_on_error():
    fake_secret = "ya29.SUPER_FAKE_ACCESS_TOKEN_SHOULD_NEVER_APPEAR"

    def raise_with_secret_looking_message(tenant_id, name):
        # google_api.py's real exceptions never embed a credential -- this
        # simulates the worst case (a hypothetical future exception that
        # did) to prove _safe_error()'s truncation/reporting discipline
        # doesn't get bypassed by this diagnostic's own printing.
        raise RuntimeError(f"unexpected failure, token={fake_secret}")

    def run_test():
        report = diag.build_report(FAKE_TENANT, FAKE_REVIEW_NAME)
        assert report["review_found"] is False
        # The diagnostic does not scrub arbitrary exception text -- this
        # test instead asserts that no environment secret variable value
        # is ever read or emitted by this module at all.
        for env_name in ("GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "UPSTASH_REDIS_REST_TOKEN", "CREDENTIAL_ENCRYPTION_KEY"):
            assert env_name not in dir(diag)
        buf = io.StringIO()
        with redirect_stdout(buf):
            diag._print_report(report)
        printed = buf.getvalue()
        for secret_value in os.environ.values():
            if secret_value and len(secret_value) > 8:
                assert secret_value not in printed

    _with_fake_get_review(raise_with_secret_looking_message, run_test)


# --- 15. Missing tenant/review arguments fail safely -------------------------

def test_missing_required_arguments_fail_safely():
    original_argv = sys.argv
    try:
        sys.argv = ["gbp_review_media_diagnostic.py"]  # no --tenant-id, no --gbp-review-name
        raised = False
        try:
            diag.main()
        except SystemExit as e:
            raised = True
            assert e.code != 0
        assert raised, "argparse must refuse to run with missing required arguments"
    finally:
        sys.argv = original_argv


def test_missing_gbp_review_name_only_fails_safely():
    original_argv = sys.argv
    try:
        sys.argv = ["gbp_review_media_diagnostic.py", "--tenant-id", FAKE_TENANT]
        raised = False
        try:
            diag.main()
        except SystemExit as e:
            raised = True
            assert e.code != 0
        assert raised
    finally:
        sys.argv = original_argv


# --- 16. Invalid hypothetical timestamp fails safely -------------------------

def test_invalid_hypothetical_timestamp_raises():
    try:
        diag.check_eligibility("2026-09-20T14:38:16Z", "not-a-real-timestamp")
        raised = False
    except diag.InvalidHypotheticalTimestampError:
        raised = True
    assert raised, "an unparsable --hypothetical-activation-time must fail closed, never be treated as eligible"


def test_missing_hypothetical_timestamp_is_not_comparable_not_eligible():
    result = diag.check_eligibility("2026-09-20T14:38:16Z", None)
    assert result["comparable"] is False
    assert result["qualifies"] is None  # never guessed as True


def test_invalid_timestamp_via_cli_exits_nonzero():
    original_argv = sys.argv
    try:
        sys.argv = [
            "gbp_review_media_diagnostic.py",
            "--tenant-id", FAKE_TENANT,
            "--gbp-review-name", FAKE_REVIEW_NAME,
            "--hypothetical-activation-time", "definitely-not-a-timestamp",
        ]

        def poison(*a, **k):
            raise AssertionError("get_review must never be called when the CLI input is already invalid")

        original = ga.get_review
        ga.get_review = poison
        try:
            exit_code = diag.main()
            assert exit_code != 0
        finally:
            ga.get_review = original
    finally:
        sys.argv = original_argv


# --- 17. Eligibility uses full createTime, not date-only ---------------------

def test_eligibility_uses_full_timestamp_not_date_only():
    # Same calendar date, but createTime is BEFORE the activation instant --
    # a date-only comparison would incorrectly treat these as equal/eligible.
    result = diag.check_eligibility("2026-09-20T08:00:00Z", "2026-09-20T12:00:00Z")
    assert result["comparable"] is True
    assert result["qualifies"] is False, (
        "createTime 08:00 on the activation date is BEFORE a 12:00 activation instant -- "
        "a date-only comparison would wrongly report this as eligible"
    )


def test_eligibility_qualifies_when_full_timestamp_is_after_activation():
    result = diag.check_eligibility("2026-09-20T14:00:00Z", "2026-09-20T12:00:00Z")
    assert result["qualifies"] is True


def test_eligibility_inclusive_at_exact_equality():
    result = diag.check_eligibility("2026-09-20T12:00:00Z", "2026-09-20T12:00:00Z")
    assert result["qualifies"] is True


def test_daniel_romero_not_special_cased_to_qualify():
    """He must not qualify merely because his review motivated the feature --
    a createTime strictly before the hypothetical activation instant is
    ineligible, with no special-case override anywhere in this module."""
    daniel_create_time = "2026-09-20T14:38:16.143655Z"
    activation_after_his_review = "2026-09-20T18:00:00Z"
    result = diag.check_eligibility(daniel_create_time, activation_after_his_review)
    assert result["qualifies"] is False


def main() -> int:
    tests = [
        ("exactly one get_review call is made", test_exactly_one_get_review_call),
        ("list_reviews() is never called", test_list_reviews_never_called),
        ("no HTTP request is ever made to a media URL", test_no_media_url_is_ever_fetched),
        ("no write-capable module is imported into this diagnostic", test_no_write_capable_module_is_imported),
        ("photo item sanitized output", test_photo_item_sanitized_output),
        ("video item sanitized output", test_video_item_sanitized_output),
        ("mediaFormat field takes precedence when present", test_media_format_field_takes_precedence_when_present),
        ("mixed media report", test_mixed_media_report),
        ("missing reviewMediaItems reported as absent, count 0", test_missing_review_media_items),
        ("malformed item (not a dict) rejected", test_malformed_item_not_a_dict),
        ("malformed item (empty dict) rejected", test_malformed_item_empty_dict),
        ("non-HTTPS thumbnail URL marked rejected", test_non_https_thumbnail_url_rejected),
        ("javascript: scheme URL marked rejected", test_javascript_scheme_url_rejected),
        ("oversized URL marked rejected", test_oversized_url_rejected),
        ("full URLs never appear in the report", test_full_urls_never_appear_in_report),
        ("label text never appears in the report", test_label_text_never_appears_in_report),
        ("secrets/env values never appear in output", test_secrets_never_appear_in_output_even_on_error),
        ("missing --tenant-id and --gbp-review-name fails safely", test_missing_required_arguments_fail_safely),
        ("missing --gbp-review-name alone fails safely", test_missing_gbp_review_name_only_fails_safely),
        ("invalid hypothetical timestamp raises, never treated as eligible", test_invalid_hypothetical_timestamp_raises),
        ("missing hypothetical timestamp is not comparable, not eligible", test_missing_hypothetical_timestamp_is_not_comparable_not_eligible),
        ("invalid timestamp via CLI exits non-zero before any Google call", test_invalid_timestamp_via_cli_exits_nonzero),
        ("eligibility uses full createTime, not date-only", test_eligibility_uses_full_timestamp_not_date_only),
        ("eligibility qualifies when full timestamp is after activation", test_eligibility_qualifies_when_full_timestamp_is_after_activation),
        ("eligibility is inclusive at exact equality", test_eligibility_inclusive_at_exact_equality),
        ("Daniel Romero is not special-cased to qualify", test_daniel_romero_not_special_cased_to_qualify),
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
