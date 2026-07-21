"""
retry.py -- Phase 3 Milestone 1: a generic exponential-backoff helper,
extracted from google_api.py's previously-private _request() loop so any
provider's client code can reuse the same retry logic instead of each
hand-rolling its own.

Behavior is identical to what google_api.py implemented inline: up to
max_retries attempts, exponential backoff (base_backoff * 2**attempt) capped
at MAX_SLEEP_SECONDS, with two intentional escape hatches callers can use to
match provider-specific semantics that a one-size-fits-all backoff can't
express on its own:
  - `retry_after_seconds(err)` lets a caller honor a server-provided
    Retry-After value, or force a specific wait (including an explicit 0 for
    "retry immediately, no backoff" -- google_api.py needs this for a 401
    that was just resolved by refreshing the access token). Returning None
    means "use the default exponential formula."
  - `on_retry(err, attempt)` runs once per retry, before the wait -- for
    google_api.py this is where the access token actually gets refreshed on
    a 401 before the next attempt.
"""
import time
from typing import Callable, Optional, TypeVar

from provider_base import ProviderError

T = TypeVar("T")

DEFAULT_MAX_RETRIES = 5
DEFAULT_BASE_BACKOFF_SECONDS = 1.0
MAX_SLEEP_SECONDS = 30


def _default_is_retryable(err: Exception) -> bool:
    return isinstance(err, ProviderError) and err.retryable


def with_retry(
    fn: Callable[[], T],
    *,
    max_retries: int = DEFAULT_MAX_RETRIES,
    base_backoff: float = DEFAULT_BASE_BACKOFF_SECONDS,
    is_retryable: Callable[[Exception], bool] = _default_is_retryable,
    retry_after_seconds: Callable[[Exception], Optional[float]] = lambda e: None,
    on_retry: Optional[Callable[[Exception, int], None]] = None,
) -> T:
    """Calls fn() (no arguments -- callers close over whatever state they
    need) up to max_retries times. Re-raises immediately if is_retryable
    says no. `retry_after_seconds` returning None (not 0 -- the two are
    deliberately distinct) means "use the exponential default"."""
    last_err: Optional[Exception] = None
    for attempt in range(max_retries):
        try:
            return fn()
        except Exception as e:
            if not is_retryable(e):
                raise
            last_err = e
            if on_retry:
                on_retry(e, attempt)
            wait = retry_after_seconds(e)
            if wait is None:
                wait = base_backoff * (2 ** attempt)
            time.sleep(min(wait, MAX_SLEEP_SECONDS))

    if last_err is not None:
        raise last_err
    raise RuntimeError("with_retry exhausted retries with no captured error")
