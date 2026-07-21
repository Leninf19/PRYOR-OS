"""
Google Business Profile API client -- read accounts/locations/reviews, reply
to a review. Used by gbp_sync.py (scheduled incremental sync), gbp_import.py
(one-time historical backfill), and the frequent critical-alert check.

Google split the old monolithic v4 "My Business API" into several
purpose-built APIs in 2022. Only review read/reply stayed on the legacy v4
host; account and location listing moved to their own APIs and 404 on the
old v4 paths. This client calls each on its correct current host, but
normalizes the account/location dicts it returns back into the old v4 shape
(accountName, locationName, address, locationState.isVerified) so gbp_sync.py
and gbp_import.py don't need to know any of this happened.

Auth: exchanges GOOGLE_REFRESH_TOKEN for a short-lived access token via the
standard OAuth2 refresh-token grant -- the same mechanics as
dashboard/api/google/status.js and publish.js use client-side; this is the
Python-side equivalent for the scheduled pipeline, which runs in GitHub
Actions rather than a Vercel serverless function.

Every failure path raises one of the typed exceptions below with a specific
message -- callers never have to parse or display a raw Google error blob.
Every call is wrapped with exponential backoff (respecting Retry-After when
Google sends one) so a transient 429/5xx doesn't fail a whole sync run.
"""
import json
import os
import time
import urllib.request
import urllib.error
import urllib.parse

import retry as retry_lib
from provider_base import ProviderError

TOKEN_URL = "https://oauth2.googleapis.com/token"
API_BASE = "https://mybusiness.googleapis.com/v4"                          # reviews + reply only
ACCOUNTS_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1"    # accounts.list
LOCATIONS_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1"  # locations.list
LOCATIONS_READ_MASK = "name,title,storefrontAddress,metadata"

_MAX_RETRIES = 5
_BASE_BACKOFF_SECONDS = 1.0

_access_token_cache = {"token": None, "expires_at": 0}


class GBPError(ProviderError):
    """Base class for all Google Business Profile API errors. Reparented
    onto the shared ProviderError (Phase 3 Milestone 1) so generic
    provider-agnostic code can `except ProviderError` and catch this
    alongside any other provider's failures -- every existing
    `except ga.GBPError` in gbp_sync.py/gbp_import.py/critical_alert_check.py
    still catches exactly the same instances, since GBPError itself is
    unchanged other than its base class."""
    def __init__(self, message, status=None):
        super().__init__(message, status=status)


class GBPAuthError(GBPError):
    """Refresh/access token missing, invalid, expired, or revoked -- the
    Google account needs to be reconnected via Settings."""


class GBPRateLimitError(GBPError):
    """Rate limited (429) even after retries were exhausted."""


class GBPPermissionError(GBPError):
    """Authenticated, but lacking permission for this location/review (403)."""


class GBPNotFoundError(GBPError):
    """The requested account/location/review no longer exists (404)."""


class GBPServerError(GBPError):
    """Google returned a 5xx after retries were exhausted."""


def _env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        raise GBPAuthError(f"{name} is not set")
    return val


def get_access_token(force_refresh: bool = False) -> str:
    """Exchanges GOOGLE_REFRESH_TOKEN for a short-lived access token, cached
    in-process for the remainder of its lifetime (minus a safety margin) so a
    single script run doesn't re-exchange it on every API call."""
    now = time.time()
    if not force_refresh and _access_token_cache["token"] and now < _access_token_cache["expires_at"]:
        return _access_token_cache["token"]

    client_id = _env("GOOGLE_CLIENT_ID")
    client_secret = _env("GOOGLE_CLIENT_SECRET")
    refresh_token = _env("GOOGLE_REFRESH_TOKEN")

    body = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }).encode()

    req = urllib.request.Request(
        TOKEN_URL, data=body, method="POST",
        headers={"content-type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise GBPAuthError(f"Refresh token exchange failed ({e.code}): {detail[:300]}", status=e.code) from e
    except urllib.error.URLError as e:
        raise GBPError(f"Network error contacting Google's token endpoint: {e.reason}") from e

    token = data.get("access_token")
    if not token:
        raise GBPAuthError(f"Google did not return an access_token: {data.get('error_description', data)}")

    expires_in = data.get("expires_in", 3600)
    _access_token_cache["token"] = token
    _access_token_cache["expires_at"] = now + expires_in - 60  # 60s safety margin
    return token


def _request(method: str, url: str, body: dict | None = None, params: dict | None = None) -> dict:
    """Single authenticated request against the GBP v4 API, with exponential
    backoff on 429/5xx and typed exceptions on every failure path.

    The retry loop itself now lives in retry.py (Phase 3 Milestone 1) --
    this function only builds one attempt (_do_request) and classifies each
    failure into the right typed exception, exactly as it did inline
    before. Retry/backoff behavior is unchanged: same attempt count, same
    exponential formula, same Retry-After honoring on 429/5xx, and a 401
    still forces a fresh token and retries immediately with no backoff
    (via retry_after_seconds returning 0 for that case specifically --
    0 and "not specified" are deliberately different in retry.py)."""
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"

    def _do_request():
        token = get_access_token()
        headers = {"Authorization": f"Bearer {token}"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            status = e.code
            detail = e.read().decode(errors="replace")
            try:
                message = json.loads(detail).get("error", {}).get("message", detail[:300])
            except json.JSONDecodeError:
                message = detail[:300]

            if status == 401:
                err = GBPAuthError(f"Unauthorized: {message}", status=status)
                err.retryable = True
                err.retry_after_override = 0  # retry immediately once the token's refreshed, no backoff
                raise err from e
            if status == 403:
                raise GBPPermissionError(f"Permission denied: {message}", status=status) from e
            if status == 404:
                raise GBPNotFoundError(f"Not found: {message}", status=status) from e
            if status == 429 or status >= 500:
                err = (GBPRateLimitError if status == 429 else GBPServerError)(
                    f"Google API {status}: {message}", status=status)
                err.retryable = True
                retry_after = e.headers.get("Retry-After")
                if retry_after:
                    err.retry_after_override = float(retry_after)
                raise err from e
            raise GBPError(f"Google API {status}: {message}", status=status) from e
        except urllib.error.URLError as e:
            err = GBPError(f"Network error calling Google API: {e.reason}")
            err.retryable = True
            raise err from e

    def _on_retry(err, _attempt):
        # Access token expired/revoked mid-run -- force a fresh one before
        # the next attempt (which will call get_access_token() again).
        if isinstance(err, GBPAuthError):
            get_access_token(force_refresh=True)

    def _retry_after(err):
        return getattr(err, "retry_after_override", None)

    return retry_lib.with_retry(
        _do_request,
        max_retries=_MAX_RETRIES,
        base_backoff=_BASE_BACKOFF_SECONDS,
        retry_after_seconds=_retry_after,
        on_retry=_on_retry,
    )


def list_accounts() -> list:
    data = _request("GET", f"{ACCOUNTS_BASE}/accounts")
    return data.get("accounts", [])


def _v4_location_path(account_name: str, location_api_name: str) -> str:
    """The Business Information API's location.name may or may not include
    the parent account segment (its canonical form is just
    'locations/{id}'). The legacy v4 reviews/reply endpoints require the
    full 'accounts/{acct}/locations/{id}' path, so this rebuilds it from
    whatever segment Google actually returned, regardless of which form."""
    tail = location_api_name.split("locations/")[-1]
    return f"{account_name}/locations/{tail}"


def list_locations(account_name: str) -> list:
    """Paginates through ALL locations for an account (publish.js today stops
    at page 1/100 -- this follows nextPageToken to completion). Normalizes
    each location dict back into the old v4 shape (name as the full
    accounts/*/locations/* path, locationName, address, locationState) so
    callers don't need to know the underlying API moved."""
    locations = []
    page_token = None
    while True:
        params = {"pageSize": 100, "readMask": LOCATIONS_READ_MASK}
        if page_token:
            params["pageToken"] = page_token
        data = _request("GET", f"{LOCATIONS_BASE}/{account_name}/locations", params=params)
        for loc in data.get("locations", []):
            address = loc.get("storefrontAddress") or {}
            locations.append({
                **loc,
                "name": _v4_location_path(account_name, loc.get("name", "")),
                "locationName": loc.get("title"),
                "address": address,
                # Verification state isn't exposed by the Business Information
                # API's readMask fields used here (it lives in the separate,
                # not-integrated Verifications API) -- left absent rather than
                # guessed, so downstream code's "UNVERIFIED" fallback reads as
                # "unknown," not a false claim of an actually-checked status.
            })
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return locations


def list_reviews(location_name: str, page_size: int = 50, max_pages: int | None = None) -> list:
    """Paginates through reviews for a location (publish.js today stops at the
    first 50 -- this follows nextPageToken, optionally capped via max_pages for
    the fast/incremental path where only the newest page or two is needed)."""
    reviews = []
    page_token = None
    pages_fetched = 0
    while True:
        params = {"pageSize": page_size}
        if page_token:
            params["pageToken"] = page_token
        data = _request("GET", f"{API_BASE}/{location_name}/reviews", params=params)
        reviews.extend(data.get("reviews", []))
        pages_fetched += 1
        page_token = data.get("nextPageToken")
        if not page_token or (max_pages and pages_fetched >= max_pages):
            break
    return reviews


def reply_to_review(review_name: str, comment: str) -> None:
    _request("PUT", f"{API_BASE}/{review_name}/reply", body={"comment": comment})


def is_configured() -> bool:
    """Cheap check (no network call) for whether Google credentials are
    present at all -- callers can skip the sync entirely rather than fail
    loudly when the integration hasn't been set up yet."""
    return bool(
        os.environ.get("GOOGLE_CLIENT_ID")
        and os.environ.get("GOOGLE_CLIENT_SECRET")
        and os.environ.get("GOOGLE_REFRESH_TOKEN")
    )
