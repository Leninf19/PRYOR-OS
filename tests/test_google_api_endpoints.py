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
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import google_api as ga

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


def main():
    tests = [
        ("list_accounts() uses the current Account Management API host, not the deprecated v4 path", test_list_accounts_hits_new_host),
        ("list_locations() uses the current Business Information API host + required readMask", test_list_locations_hits_new_host_with_readmask),
        ("list_locations() normalizes an already-account-prefixed name without doubling it", test_list_locations_handles_account_prefixed_name_too),
        ("list_reviews()/reply_to_review() remain on the legacy v4 host (unaffected by the 2022 split)", test_list_reviews_and_reply_still_use_v4),
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
