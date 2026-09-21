"""
Dual-client Google Business Profile OAuth credential resolution
(PRYOR OS Google Cloud project migration, Phase 5) -- the Python mirror of
dashboard/api/google/_lib/googleOAuthClients.js. See that file's header
comment for the full rationale; this module applies the identical rules
so a token refresh works identically whether it's the Node dashboard or
this Python pipeline performing it.

Deliberately separate from tenant_keys.py's LEGACY/CUTOVER "which Redis
KEY is authoritative for this tenant" system -- that is an orthogonal
concern (which physical record) from this one (which OAuth client issued
the token INSIDE whichever record).
"""
from __future__ import annotations

import os

GOOGLE_OAUTH_CLIENT_KEY_LEGACY = "legacy-lta"
GOOGLE_OAUTH_CLIENT_KEY_PRYOR = "pryor-2026"

_RECOGNIZED_CLIENT_KEYS = frozenset({GOOGLE_OAUTH_CLIENT_KEY_LEGACY, GOOGLE_OAUTH_CLIENT_KEY_PRYOR})


class UnrecognizedClientKeyError(ValueError):
    """A clientKey was present but was not exactly one of the two
    recognized values (blank, malformed, wrong case, or simply unknown).
    NEVER caught and silently downgraded to legacy anywhere in this
    module -- an explicit-but-wrong value is a configuration/data
    integrity problem that must fail closed and loud, never be guessed at.
    The raw value is deliberately never included in the message, since it
    may originate from stored Redis data."""


class GoogleOAuthClientNotConfiguredError(ValueError):
    """A recognized clientKey's required environment variables are not
    (yet) fully configured."""

    def __init__(self, client_key: str):
        super().__init__(f'Google OAuth client "{client_key}" is not configured')
        self.client_key = client_key


# --- Legacy compatibility bridge -------------------------------------------
# Mirrors googleOAuthClients.js's resolveLegacyClientPair() exactly -- see
# that file's header comment for the full 6-rule specification. Resolution
# order: complete suffixed pair -> complete bare fallback pair -> None
# (never a partial/mixed pair from either family).
#
# TODO(google-oauth-migration-cutover): remove this bridge (always read
# GOOGLE_CLIENT_ID_LEGACY/SECRET_LEGACY) once Production GitHub Actions
# secrets have been configured with the suffixed legacy pair and that
# configuration has been verified present. Do not remove in this phase.
def _resolve_legacy_client_pair() -> tuple[str, str] | None:
    suffixed_id = os.environ.get("GOOGLE_CLIENT_ID_LEGACY")
    suffixed_secret = os.environ.get("GOOGLE_CLIENT_SECRET_LEGACY")
    suffixed_id_present = bool(suffixed_id)
    suffixed_secret_present = bool(suffixed_secret)

    if suffixed_id_present and suffixed_secret_present:
        return suffixed_id, suffixed_secret
    if suffixed_id_present != suffixed_secret_present:
        # Exactly one suffixed value present -- never complete the pair
        # from the bare fallback (that would be mixing across families).
        return None

    bare_id = os.environ.get("GOOGLE_CLIENT_ID")
    bare_secret = os.environ.get("GOOGLE_CLIENT_SECRET")
    if bare_id and bare_secret:
        return bare_id, bare_secret
    return None


def _resolve_pryor_client_pair() -> tuple[str, str] | None:
    client_id = os.environ.get("GOOGLE_CLIENT_ID_PRYOR")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET_PRYOR")
    if client_id and client_secret:
        return client_id, client_secret
    return None


def resolve_google_oauth_client_credentials(client_key: str | None) -> tuple[str, str, str]:
    """THE one function every Python caller uses to turn a clientKey (from
    a Redis-stored credential record) into the actual client_id/client_secret
    to use for a Google token request. Returns (client_key, client_id,
    client_secret).

    `client_key` should already have had "absent -> legacy-lta" applied by
    the CALLER (reading a Redis record) before reaching here -- this
    function itself only ever recognizes the two exact enum values;
    passing it anything else (including None) raises
    UnrecognizedClientKeyError rather than guessing."""
    if client_key not in _RECOGNIZED_CLIENT_KEYS:
        raise UnrecognizedClientKeyError("unrecognized Google OAuth clientKey")
    pair = _resolve_legacy_client_pair() if client_key == GOOGLE_OAUTH_CLIENT_KEY_LEGACY else _resolve_pryor_client_pair()
    if pair is None:
        raise GoogleOAuthClientNotConfiguredError(client_key)
    client_id, client_secret = pair
    return client_key, client_id, client_secret


def has_any_google_oauth_client_configured() -> bool:
    """Coarse 'is a Google OAuth client configured AT ALL' check (no
    network call) -- used only by google_api.py's is_configured(), which
    runs before any specific tenant's credential (and therefore its own
    clientKey) is known, so it accepts either family being present."""
    return _resolve_legacy_client_pair() is not None or _resolve_pryor_client_pair() is not None
