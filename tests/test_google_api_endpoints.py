"""
Regression test for the GBP account/location 404 bug (2026-07-15).

Google split the old monolithic v4 "My Business API" into several
purpose-built APIs in 2022. Only review read/reply stayed on the legacy
mybusiness.googleapis.com/v4 host; account listing moved to
mybusinessaccountmanagement.googleapis.com/v1 and location listing moved to
mybusinessbusinessinformation.googleapis.com/v1. Calling the old v4 paths for
accounts/locations now returns 404 -- this is exactly what production hit.

This test mocks urllib.request.urlopen (no real network/credentials) and
asserts google_api.py's list_accounts()/list_locations() hit the current
correct hosts, while list_reviews()/reply_to_review() still correctly use
the legacy v4 host (unaffected by the 2022 split).

No pytest dependency in this repo -- run directly: py tests/test_google_api_endpoints.py
Exits 0 on success, 1 with a clear message on failure.
"""
import io
import json
import sys
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import google_api as ga
from provider_base import ProviderError

OLD_ACCOUNTS_URL_PREFIX = "https://mybusiness.googleapis.com/v4/accounts"
OLD_LOCATIONS_URL_PREFIX = "https://mybusiness.googleapis.com/v4/accounts/123/locations"
NEW_ACCOUNTS_URL_PREFIX = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts"
NEW_LOCATIONS_URL_PREFIX = "https://mybusinessbusinessinformation.googleapis.com/v1/accounts/123/locations"


def _fake_response(payload: dict):
    body = json.dumps(payload).encode()
    resp = io.BytesIO(body)
    resp.getcode = lambda: 200
    return resp


def _run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        return True
    except AssertionError as e:
        print(f"FAIL: {name} -- {e}")
        return False


def test_list_accounts_hits_new_host():
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        return _fake_response({"accounts": [{"name": "accounts/123", "accountName": "Test Account"}]})

    with mock.patch.object(ga, "get_access_token", return_value="fake-token"), \
         mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
        accounts = ga.list_accounts()

    assert not captured["url"].startswith(OLD_ACCOUNTS_URL_PREFIX), (
        f"list_accounts() called the deprecated v4 host that 404s in production: {captured['url']}"
    )
    assert captured["url"].startswith(NEW_ACCOUNTS_URL_PREFIX), (
        f"Expected {NEW_ACCOUNTS_URL_PREFIX}, got {captured['url']}"
    )
    assert accounts == [{"name": "accounts/123", "accountName": "Test Account"}]


def test_list_locations_hits_new_host_with_readmask():
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        return _fake_response({
            "locations": [{"name": "locations/456", "title": "Casa Tequila Testtown",
                           "storefrontAddress": {"locality": "Testtown"}}]
        })

    with mock.patch.object(ga, "get_access_token", return_value="fake-token"), \
         mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
        locations = ga.list_locations("accounts/123")

    assert not captured["url"].startswith(OLD_LOCATIONS_URL_PREFIX), (
        f"list_locations() called the deprecated v4 host that 404s in production: {captured['url']}"
    )
    assert captured["url"].startswith(NEW_LOCATIONS_URL_PREFIX), (
        f"Expected {NEW_LOCATIONS_URL_PREFIX}, got {captured['url']}"
    )
    assert "readMask=" in captured["url"], "locations.list requires readMask on the new API; it was omitted"

    # Normalized back to the old v4 shape so gbp_sync.py/gbp_import.py need no changes.
    loc = locations[0]
    assert loc["name"] == "accounts/123/locations/456", (
        f"location name should be reconstructed as a full v4 path for reviews calls, got {loc['name']}"
    )
    assert loc["locationName"] == "Casa Tequila Testtown"
    assert loc["address"] == {"locality": "Testtown"}


def test_list_locations_handles_account_prefixed_name_too():
    """Some responses may already include the account segment -- the
    normalizer must not double it up."""
    def fake_urlopen(req, timeout=None):
        return _fake_response({
            "locations": [{"name": "accounts/999/locations/456", "title": "X"}]
        })

    with mock.patch.object(ga, "get_access_token", return_value="fake-token"), \
         mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
        locations = ga.list_locations("accounts/123")

    assert locations[0]["name"] == "accounts/123/locations/456", (
        f"Expected the passed-in account (123) to win, got {locations[0]['name']}"
    )


def test_list_reviews_and_reply_still_use_v4():
    """Reviews read/reply were NOT part of the 2022 API split and must stay
    on the legacy v4 host -- confirms the fix didn't over-correct."""
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        return _fake_response({"reviews": []})

    with mock.patch.object(ga, "get_access_token", return_value="fake-token"), \
         mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
        ga.list_reviews("accounts/123/locations/456")

    assert captured["url"].startswith("https://mybusiness.googleapis.com/v4/accounts/123/locations/456/reviews"), (
        f"list_reviews() must stay on the v4 host, got {captured['url']}"
    )

    def fake_urlopen_reply(req, timeout=None):
        captured["url"] = req.full_url
        return _fake_response({})

    with mock.patch.object(ga, "get_access_token", return_value="fake-token"), \
         mock.patch("urllib.request.urlopen", side_effect=fake_urlopen_reply):
        ga.reply_to_review("accounts/123/locations/456/reviews/789", "Thank you!")

    assert captured["url"].startswith("https://mybusiness.googleapis.com/v4/accounts/123/locations/456/reviews/789/reply"), (
        f"reply_to_review() must stay on the v4 host, got {captured['url']}"
    )


def _http_error(code, message=None, retry_after=None, url="https://example.com"):
    body = json.dumps({"error": {"message": message}}).encode() if message else b""
    headers = {"Retry-After": retry_after} if retry_after else {}
    return urllib.error.HTTPError(url=url, code=code, msg="error", hdrs=headers, fp=io.BytesIO(body))


# --- Phase 3 Milestone 1: retry.py extraction must preserve _request()'s
# exact original retry/backoff behavior for every status-code path. These
# mock urllib.request.urlopen directly (no real network) and mock
# time.sleep so they run instantly regardless of backoff duration.

def test_401_forces_token_refresh_and_retries_immediately_without_sleep():
    call_count = {"n": 0}

    def fake_urlopen(req, timeout=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise _http_error(401, "token expired")
        return _fake_response({"accounts": []})

    with mock.patch.object(ga, "get_access_token", return_value="fake-token") as token_mock, \
         mock.patch("urllib.request.urlopen", side_effect=fake_urlopen), \
         mock.patch("retry.time.sleep") as sleep_mock:
        result = ga.list_accounts()

    assert result == []
    assert call_count["n"] == 2, f"expected exactly 2 attempts (1 failure + 1 success), got {call_count['n']}"
    token_mock.assert_any_call(force_refresh=True)
    # a 401 must retry immediately (0s wait), not the default exponential backoff
    sleep_mock.assert_called_once_with(0)


def test_429_honors_retry_after_header():
    call_count = {"n": 0}

    def fake_urlopen(req, timeout=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise _http_error(429, "quota exceeded", retry_after="2")
        return _fake_response({"accounts": []})

    with mock.patch.object(ga, "get_access_token", return_value="fake-token"), \
         mock.patch("urllib.request.urlopen", side_effect=fake_urlopen), \
         mock.patch("retry.time.sleep") as sleep_mock:
        ga.list_accounts()

    sleep_mock.assert_called_once_with(2.0)


def test_5xx_retries_with_exponential_backoff_when_no_retry_after_header():
    call_count = {"n": 0}

    def fake_urlopen(req, timeout=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise _http_error(503, "server error")
        return _fake_response({"accounts": []})

    with mock.patch.object(ga, "get_access_token", return_value="fake-token"), \
         mock.patch("urllib.request.urlopen", side_effect=fake_urlopen), \
         mock.patch("retry.time.sleep") as sleep_mock:
        ga.list_accounts()

    sleep_mock.assert_called_once_with(ga._BASE_BACKOFF_SECONDS * (2 ** 0))


def test_403_raises_immediately_without_retry():
    def fake_urlopen(req, timeout=None):
        raise _http_error(403, "permission denied")

    with mock.patch.object(ga, "get_access_token", return_value="fake-token"), \
         mock.patch("urllib.request.urlopen", side_effect=fake_urlopen) as urlopen_mock, \
         mock.patch("retry.time.sleep") as sleep_mock:
        try:
            ga.list_accounts()
            raise AssertionError("expected GBPPermissionError to be raised")
        except ga.GBPPermissionError as e:
            assert e.status == 403

    assert urlopen_mock.call_count == 1, "403 must never be retried"
    sleep_mock.assert_not_called()


def test_404_raises_immediately_without_retry():
    def fake_urlopen(req, timeout=None):
        raise _http_error(404, "not found")

    with mock.patch.object(ga, "get_access_token", return_value="fake-token"), \
         mock.patch("urllib.request.urlopen", side_effect=fake_urlopen) as urlopen_mock, \
         mock.patch("retry.time.sleep") as sleep_mock:
        try:
            ga.list_accounts()
            raise AssertionError("expected GBPNotFoundError to be raised")
        except ga.GBPNotFoundError as e:
            assert e.status == 404

    assert urlopen_mock.call_count == 1, "404 must never be retried"
    sleep_mock.assert_not_called()


def test_network_error_retries_with_backoff():
    call_count = {"n": 0}

    def fake_urlopen(req, timeout=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise urllib.error.URLError("connection refused")
        return _fake_response({"accounts": []})

    with mock.patch.object(ga, "get_access_token", return_value="fake-token"), \
         mock.patch("urllib.request.urlopen", side_effect=fake_urlopen), \
         mock.patch("retry.time.sleep") as sleep_mock:
        result = ga.list_accounts()

    assert result == []
    assert call_count["n"] == 2
    sleep_mock.assert_called_once_with(ga._BASE_BACKOFF_SECONDS * (2 ** 0))


def test_get_access_token_invalid_grant_raises_typed_gbpautherror():
    """Recovery audit (2026-08-20): production's actual failure mode --
    the refresh token itself being rejected by Google's token endpoint
    with invalid_grant -- happens inside get_access_token() itself, a
    different code path from _request()'s mid-run 401 handling (which is
    already covered above). This is the exact error shape observed in
    real GitHub Actions logs: a 400 HTTPError from oauth2.googleapis.com/
    token whose body is {"error": "invalid_grant", "error_description":
    "Token has been expired or revoked."}."""
    ga._access_token_cache["token"] = None
    ga._access_token_cache["expires_at"] = 0

    body = json.dumps({"error": "invalid_grant", "error_description": "Token has been expired or revoked."}).encode()
    err = urllib.error.HTTPError(url=ga.TOKEN_URL, code=400, msg="Bad Request", hdrs={}, fp=io.BytesIO(body))

    with mock.patch.dict("os.environ", {
        "GOOGLE_CLIENT_ID": "fake-client-id",
        "GOOGLE_CLIENT_SECRET": "fake-client-secret",
        "GOOGLE_REFRESH_TOKEN": "fake-refresh-token",
    }, clear=False), \
         mock.patch.object(ga, "_fetch_refresh_token_from_redis", return_value=None), \
         mock.patch("urllib.request.urlopen", side_effect=err):
        try:
            ga.get_access_token()
            raise AssertionError("expected GBPAuthError to be raised")
        except ga.GBPAuthError as e:
            assert e.status == 400, f"expected status=400, got {e.status}"
            assert "invalid_grant" in str(e), f"the raw Google error detail must be preserved in the message: {e}"
        except Exception as e:
            raise AssertionError(f"expected ga.GBPAuthError specifically, got {type(e).__name__}: {e}")


def test_get_access_token_success_caches_token_until_expiry():
    ga._access_token_cache["token"] = None
    ga._access_token_cache["expires_at"] = 0
    call_count = {"n": 0}

    def fake_urlopen(req, timeout=None):
        call_count["n"] += 1
        return _fake_response({"access_token": "fresh-token", "expires_in": 3600})

    with mock.patch.dict("os.environ", {
        "GOOGLE_CLIENT_ID": "fake-client-id",
        "GOOGLE_CLIENT_SECRET": "fake-client-secret",
        "GOOGLE_REFRESH_TOKEN": "fake-refresh-token",
    }, clear=False), \
         mock.patch.object(ga, "_fetch_refresh_token_from_redis", return_value=None), \
         mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
        first = ga.get_access_token()
        second = ga.get_access_token()  # must be served from the in-process cache, no second exchange

    assert first == "fresh-token"
    assert second == "fresh-token"
    assert call_count["n"] == 1, f"expected exactly one token exchange (second call served from cache), got {call_count['n']}"


def test_gbp_error_hierarchy_is_reparented_onto_provider_error():
    """Phase 3 Milestone 1: GBPError and its subclasses must now be
    ProviderError instances too, so generic provider-agnostic code can
    `except ProviderError` and catch these alongside any other provider's
    failures -- while every existing `except ga.GBPError` still works
    unchanged."""
    assert issubclass(ga.GBPError, ProviderError)
    for subclass in (ga.GBPAuthError, ga.GBPRateLimitError, ga.GBPPermissionError,
                     ga.GBPNotFoundError, ga.GBPServerError):
        assert issubclass(subclass, ga.GBPError)
        assert issubclass(subclass, ProviderError)

    err = ga.GBPPermissionError("denied", status=403)
    assert err.status == 403, "GBPError's own status attribute behavior must be unchanged"
    assert err.retryable is False, "retryable defaults to False unless explicitly set (e.g. by _request())"


def main():
    tests = [
        ("list_accounts() uses the current Account Management API host, not the deprecated v4 path", test_list_accounts_hits_new_host),
        ("list_locations() uses the current Business Information API host + required readMask", test_list_locations_hits_new_host_with_readmask),
        ("list_locations() normalizes an already-account-prefixed name without doubling it", test_list_locations_handles_account_prefixed_name_too),
        ("list_reviews()/reply_to_review() remain on the legacy v4 host (unaffected by the 2022 split)", test_list_reviews_and_reply_still_use_v4),
        ("_request(): a 401 forces a token refresh and retries immediately with no sleep", test_401_forces_token_refresh_and_retries_immediately_without_sleep),
        ("_request(): a 429 honors the Retry-After header", test_429_honors_retry_after_header),
        ("_request(): a 5xx with no Retry-After retries with exponential backoff", test_5xx_retries_with_exponential_backoff_when_no_retry_after_header),
        ("_request(): a 403 raises immediately, never retried", test_403_raises_immediately_without_retry),
        ("_request(): a 404 raises immediately, never retried", test_404_raises_immediately_without_retry),
        ("_request(): a network error retries with exponential backoff", test_network_error_retries_with_backoff),
        ("GBPError and subclasses are reparented onto the shared ProviderError", test_gbp_error_hierarchy_is_reparented_onto_provider_error),
        ("get_access_token(): invalid_grant raises a typed GBPAuthError with the raw detail preserved", test_get_access_token_invalid_grant_raises_typed_gbpautherror),
        ("get_access_token(): a successful exchange is cached until expiry", test_get_access_token_success_caches_token_until_expiry),
    ]
    results = [_run(name, fn) for name, fn in tests]
    print()
    if all(results):
        print(f"ALL {len(results)} REGRESSION TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} REGRESSION TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
