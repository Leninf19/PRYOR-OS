"""
Regression tests for gbp_reply_reconciliation_diagnostic.py's
check_google_state() -- Phase 6 of the Google Reply Moderation State fix.
Covers the new fields this read-only diagnostic now reports
(reviewReplyState, policyViolation, normalized reply-text match, and the
final diagnostic interpretation string) without ever making a real network
call -- google_api.get_review() is monkeypatched for the duration of each
test.

No Redis, no database writes, no reply publishing anywhere in this file.

Run directly: py tests/test_gbp_reply_reconciliation_diagnostic.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import gbp_reply_reconciliation_diagnostic as diag
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


def test_approved_reply_reports_approved_interpretation():
    def run_test():
        state = diag.check_google_state("t_los-tres-amigos", "accounts/1/locations/2/reviews/abc")
        assert state["verifiable"]
        assert state["has_reply"] is True
        assert state["review_reply_state_normalized"] == "APPROVED"
        assert state["moderation_outcome"] == "approved_by_google"
        assert "APPROVED" in state["interpretation"]

    _with_fake_get_review(
        lambda tenant_id, name: {"reviewReply": {"comment": "Thanks!", "reviewReplyState": "APPROVED", "updateTime": "2026-08-22T14:00:00Z"}},
        run_test,
    )


def test_rejected_reply_reports_policy_violation_and_interpretation():
    def run_test():
        state = diag.check_google_state("t_los-tres-amigos", "accounts/1/locations/2/reviews/abc")
        assert state["moderation_outcome"] == "rejected_by_google"
        assert state["policy_violation"]["reasonCodes"] == ["HARASSMENT"]
        assert "REJECTED" in state["interpretation"]
        assert "must NOT be treated as answered" in state["interpretation"]

    _with_fake_get_review(
        lambda tenant_id, name: {"reviewReply": {"comment": "Thanks!", "reviewReplyState": "REJECTED", "policyViolation": "HARASSMENT"}},
        run_test,
    )


def test_pending_reply_reports_pending_interpretation():
    def run_test():
        state = diag.check_google_state("t_los-tres-amigos", "accounts/1/locations/2/reviews/abc")
        assert state["moderation_outcome"] == "pending_google_approval"
        assert "PENDING" in state["interpretation"]

    _with_fake_get_review(
        lambda tenant_id, name: {"reviewReply": {"comment": "Thanks!", "reviewReplyState": "PENDING"}},
        run_test,
    )


def test_missing_moderation_state_with_comment_is_unresolved_never_approved():
    """THE reported bug reproduced directly against the diagnostic: reply
    text present, no reviewReplyState at all -- must be reported as
    unresolved, never interpreted as approval."""
    def run_test():
        state = diag.check_google_state("t_los-tres-amigos", "accounts/1/locations/2/reviews/abc")
        assert state["has_reply"] is True
        assert state["review_reply_state_normalized"] is None
        assert state["moderation_outcome"] is None
        assert "UNRESOLVED" in state["interpretation"]
        assert "APPROVED" not in state["interpretation"]

    _with_fake_get_review(
        lambda tenant_id, name: {"reviewReply": {"comment": "Thanks!", "updateTime": "2026-08-22T14:00:00Z"}},
        run_test,
    )


def test_unspecified_state_treated_same_as_missing():
    def run_test():
        state = diag.check_google_state("t_los-tres-amigos", "accounts/1/locations/2/reviews/abc")
        assert state["review_reply_state_normalized"] is None
        assert state["moderation_outcome"] is None

    _with_fake_get_review(
        lambda tenant_id, name: {"reviewReply": {"comment": "Thanks!", "reviewReplyState": "REVIEW_REPLY_STATE_UNSPECIFIED"}},
        run_test,
    )


def test_unknown_future_state_treated_same_as_missing():
    def run_test():
        state = diag.check_google_state("t_los-tres-amigos", "accounts/1/locations/2/reviews/abc")
        assert state["review_reply_state_normalized"] is None
        assert state["moderation_outcome"] is None

    _with_fake_get_review(
        lambda tenant_id, name: {"reviewReply": {"comment": "Thanks!", "reviewReplyState": "A_FUTURE_STATE_NOT_YET_INVENTED"}},
        run_test,
    )


def test_no_reply_at_all_is_genuinely_unanswered():
    def run_test():
        state = diag.check_google_state("t_los-tres-amigos", "accounts/1/locations/2/reviews/abc")
        assert state["has_reply"] is False
        assert "genuinely unanswered" in state["interpretation"]

    _with_fake_get_review(lambda tenant_id, name: {}, run_test)


def test_reply_text_match_reported_when_local_text_supplied():
    def run_test():
        state = diag.check_google_state("t_los-tres-amigos", "accounts/1/locations/2/reviews/abc", local_reply_text="Thanks so much!")
        assert state["reply_text_matches_local"] is True

    _with_fake_get_review(
        lambda tenant_id, name: {"reviewReply": {"comment": "  Thanks so much!  ", "reviewReplyState": "APPROVED"}},
        run_test,
    )


def test_reply_text_mismatch_reported_when_local_text_differs():
    def run_test():
        state = diag.check_google_state("t_los-tres-amigos", "accounts/1/locations/2/reviews/abc", local_reply_text="A completely different reply")
        assert state["reply_text_matches_local"] is False

    _with_fake_get_review(
        lambda tenant_id, name: {"reviewReply": {"comment": "Thanks so much!", "reviewReplyState": "APPROVED"}},
        run_test,
    )


def test_fetch_error_reports_unverifiable_never_crashes():
    def run_test():
        state = diag.check_google_state("t_los-tres-amigos", "accounts/1/locations/2/reviews/abc")
        assert state["verifiable"] is False
        assert "error" in state

    def raise_error(tenant_id, name):
        raise RuntimeError("network error")

    _with_fake_get_review(raise_error, run_test)


def test_malformed_policy_violation_never_crashes():
    def run_test():
        state = diag.check_google_state("t_los-tres-amigos", "accounts/1/locations/2/reviews/abc")
        assert state["moderation_outcome"] == "rejected_by_google"
        assert state["policy_violation"]["reasonCodes"] == []

    _with_fake_get_review(
        lambda tenant_id, name: {"reviewReply": {"comment": "Thanks!", "reviewReplyState": "REJECTED", "policyViolation": {"unexpectedShape": True}}},
        run_test,
    )


def main() -> int:
    tests = [
        ("APPROVED reply reports approved interpretation", test_approved_reply_reports_approved_interpretation),
        ("REJECTED reply reports policyViolation and interpretation", test_rejected_reply_reports_policy_violation_and_interpretation),
        ("PENDING reply reports pending interpretation", test_pending_reply_reports_pending_interpretation),
        ("comment present but no moderation state -> unresolved, never approved (the reported bug)", test_missing_moderation_state_with_comment_is_unresolved_never_approved),
        ("REVIEW_REPLY_STATE_UNSPECIFIED treated same as missing", test_unspecified_state_treated_same_as_missing),
        ("an unrecognized future state treated same as missing", test_unknown_future_state_treated_same_as_missing),
        ("no reply at all -> genuinely unanswered", test_no_reply_at_all_is_genuinely_unanswered),
        ("reply text match reported when local text supplied", test_reply_text_match_reported_when_local_text_supplied),
        ("reply text mismatch reported when local text differs", test_reply_text_mismatch_reported_when_local_text_differs),
        ("a fetch error reports unverifiable, never crashes", test_fetch_error_reports_unverifiable_never_crashes),
        ("a malformed policyViolation shape never crashes", test_malformed_policy_violation_never_crashes),
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
