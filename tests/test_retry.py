"""
Regression tests for retry.py (Phase 3 Milestone 1) -- the generic
exponential-backoff helper extracted from google_api.py's previously-private
_request() loop. Tested in isolation from google_api.py here; the
integration-level behavior (does google_api.py's _request() still retry
401/429/5xx exactly as before) is covered separately in
tests/test_google_api_endpoints.py.

time.sleep is mocked throughout so this suite runs instantly regardless of
backoff durations.

Run directly: py tests/test_retry.py
"""
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import retry
from provider_base import ProviderError

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def test_succeeds_on_first_try_without_sleeping():
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        return "ok"

    with mock.patch("retry.time.sleep") as sleep_mock:
        result = retry.with_retry(fn)

    assert result == "ok"
    assert calls["n"] == 1, f"expected exactly one call, got {calls['n']}"
    sleep_mock.assert_not_called()


def test_retries_a_retryable_error_then_succeeds():
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        if calls["n"] < 3:
            raise ProviderError("transient", retryable=True)
        return "recovered"

    with mock.patch("retry.time.sleep"):
        result = retry.with_retry(fn, max_retries=5)

    assert result == "recovered"
    assert calls["n"] == 3, f"expected 3 attempts (2 failures + 1 success), got {calls['n']}"


def test_exhausts_retries_and_raises_the_last_error():
    def fn():
        raise ProviderError("always fails", retryable=True, status=500)

    with mock.patch("retry.time.sleep") as sleep_mock:
        try:
            retry.with_retry(fn, max_retries=3)
            raise AssertionError("expected with_retry to raise after exhausting retries")
        except ProviderError as e:
            assert str(e) == "always fails"
            assert e.status == 500

    # Matches the original inline loop's exact behavior (preserved
    # faithfully, not "improved"): every failed attempt sleeps inside its
    # own except block, including the last one, before the for loop
    # naturally exhausts -- so 3 attempts means 3 sleeps, not 2.
    assert sleep_mock.call_count == 3, f"3 failed attempts should each sleep once (matching the original loop), got {sleep_mock.call_count}"


def test_non_retryable_error_raises_immediately_without_retrying():
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        raise ProviderError("permission denied", retryable=False, status=403)

    with mock.patch("retry.time.sleep") as sleep_mock:
        try:
            retry.with_retry(fn, max_retries=5)
            raise AssertionError("expected immediate raise for a non-retryable error")
        except ProviderError:
            pass

    assert calls["n"] == 1, f"a non-retryable error must not be retried, got {calls['n']} attempts"
    sleep_mock.assert_not_called()


def test_a_plain_non_provider_exception_is_never_retried_by_default():
    """The default is_retryable only recognizes ProviderError instances --
    an unrelated exception (a real bug, a KeyError, etc.) must propagate
    immediately rather than being silently retried."""
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        raise ValueError("not a provider error")

    with mock.patch("retry.time.sleep") as sleep_mock:
        try:
            retry.with_retry(fn, max_retries=5)
            raise AssertionError("expected ValueError to propagate immediately")
        except ValueError:
            pass

    assert calls["n"] == 1
    sleep_mock.assert_not_called()


def test_retry_after_seconds_zero_means_immediate_retry_not_default_backoff():
    """0 and None are deliberately distinct: None means 'use the default
    exponential formula', 0 means 'retry right now, no wait at all' --
    this is exactly what google_api.py needs for a 401 that was just
    resolved by refreshing the token."""
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        if calls["n"] < 2:
            raise ProviderError("needs immediate retry", retryable=True)
        return "ok"

    with mock.patch("retry.time.sleep") as sleep_mock:
        result = retry.with_retry(fn, retry_after_seconds=lambda e: 0)

    assert result == "ok"
    sleep_mock.assert_called_once_with(0)


def test_retry_after_seconds_none_falls_back_to_exponential_default():
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        if calls["n"] < 2:
            raise ProviderError("transient", retryable=True)
        return "ok"

    with mock.patch("retry.time.sleep") as sleep_mock:
        retry.with_retry(fn, base_backoff=2.0, retry_after_seconds=lambda e: None)

    sleep_mock.assert_called_once_with(2.0)  # base_backoff * 2**0


def test_sleep_is_capped_at_max_sleep_seconds():
    def fn():
        raise ProviderError("huge retry-after", retryable=True)

    with mock.patch("retry.time.sleep") as sleep_mock:
        try:
            retry.with_retry(fn, max_retries=2, retry_after_seconds=lambda e: 9999)
        except ProviderError:
            pass

    assert sleep_mock.call_count == 2
    sleep_mock.assert_called_with(retry.MAX_SLEEP_SECONDS)


def test_on_retry_callback_invoked_once_per_retry_before_the_wait():
    events = []

    def fn():
        if len(events) < 2:
            raise ProviderError("transient", retryable=True)
        return "ok"

    def on_retry(err, attempt):
        events.append(("retry", attempt))

    with mock.patch("retry.time.sleep"):
        retry.with_retry(fn, on_retry=on_retry)

    assert events == [("retry", 0), ("retry", 1)], f"expected two on_retry calls at attempts 0 and 1, got {events}"


def main():
    run("succeeds on the first try, never sleeps", test_succeeds_on_first_try_without_sleeping)
    run("retries a retryable error then succeeds", test_retries_a_retryable_error_then_succeeds)
    run("exhausts retries and raises the last captured error", test_exhausts_retries_and_raises_the_last_error)
    run("a non-retryable error raises immediately, never retried", test_non_retryable_error_raises_immediately_without_retrying)
    run("a plain non-ProviderError exception is never retried by default", test_a_plain_non_provider_exception_is_never_retried_by_default)
    run("retry_after_seconds returning 0 means immediate retry, not the default backoff", test_retry_after_seconds_zero_means_immediate_retry_not_default_backoff)
    run("retry_after_seconds returning None falls back to the exponential default", test_retry_after_seconds_none_falls_back_to_exponential_default)
    run("sleep duration is capped at MAX_SLEEP_SECONDS", test_sleep_is_capped_at_max_sleep_seconds)
    run("on_retry callback fires once per retry, before the wait", test_on_retry_callback_invoked_once_per_retry_before_the_wait)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
