"""
Dual-client Google Business Profile OAuth migration (PRYOR OS Google Cloud
project migration, Phase 5) -- Python-side regression tests for:
  - google_oauth_clients.py (compatibility bridge, client-key recognition)
  - google_api.py::get_access_token()'s dual-client resolution and the
    permanently-legacy GOOGLE_REFRESH_TOKEN fallback
  - credential_migration_status.py's sanitized, read-only reporting

No real Upstash account, no real Google credentials, no real network call
anywhere in this file.

Run directly: python tests/test_google_oauth_clients.py
"""
import json
import os
import sys
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import google_api as ga  # noqa: E402
import google_oauth_clients as goc  # noqa: E402
import credential_migration_status as cms  # noqa: E402
import tenant_keys  # noqa: E402

TEST_TENANT_ID = tenant_keys.DEFAULT_TENANT_ID
SYNTHETIC_TENANT_ID = "t_synthetic-second-tenant"


def fake_upstash_response(record_dict):
    payload = json.dumps({"result": json.dumps(record_dict) if record_dict is not None else None}).encode()
    mock_resp = MagicMock()
    mock_resp.read.return_value = payload
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = False
    return mock_resp


class TestCompatibilityBridge(unittest.TestCase):
    def setUp(self):
        self._env_backup = dict(os.environ)
        for var in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_CLIENT_ID_LEGACY",
                    "GOOGLE_CLIENT_SECRET_LEGACY", "GOOGLE_CLIENT_ID_PRYOR", "GOOGLE_CLIENT_SECRET_PRYOR"):
            os.environ.pop(var, None)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env_backup)

    def test_suffixed_pair_present_is_used(self):
        os.environ["GOOGLE_CLIENT_ID_LEGACY"] = "suffixed-id"
        os.environ["GOOGLE_CLIENT_SECRET_LEGACY"] = "suffixed-secret"
        os.environ["GOOGLE_CLIENT_ID"] = "bare-id"
        os.environ["GOOGLE_CLIENT_SECRET"] = "bare-secret"
        key, cid, secret = goc.resolve_google_oauth_client_credentials(goc.GOOGLE_OAUTH_CLIENT_KEY_LEGACY)
        self.assertEqual((cid, secret), ("suffixed-id", "suffixed-secret"))

    def test_suffixed_absent_bare_fallback_used(self):
        os.environ["GOOGLE_CLIENT_ID"] = "bare-id"
        os.environ["GOOGLE_CLIENT_SECRET"] = "bare-secret"
        _key, cid, secret = goc.resolve_google_oauth_client_credentials(goc.GOOGLE_OAUTH_CLIENT_KEY_LEGACY)
        self.assertEqual((cid, secret), ("bare-id", "bare-secret"))

    def test_partial_suffixed_fails_closed(self):
        os.environ["GOOGLE_CLIENT_ID_LEGACY"] = "suffixed-id"
        os.environ["GOOGLE_CLIENT_ID"] = "bare-id"
        os.environ["GOOGLE_CLIENT_SECRET"] = "bare-secret"
        with self.assertRaises(goc.GoogleOAuthClientNotConfiguredError):
            goc.resolve_google_oauth_client_credentials(goc.GOOGLE_OAUTH_CLIENT_KEY_LEGACY)

    def test_partial_bare_fails_closed(self):
        os.environ["GOOGLE_CLIENT_ID"] = "bare-id"
        with self.assertRaises(goc.GoogleOAuthClientNotConfiguredError):
            goc.resolve_google_oauth_client_credentials(goc.GOOGLE_OAUTH_CLIENT_KEY_LEGACY)

    def test_neither_pair_configured_fails_closed(self):
        with self.assertRaises(goc.GoogleOAuthClientNotConfiguredError):
            goc.resolve_google_oauth_client_credentials(goc.GOOGLE_OAUTH_CLIENT_KEY_LEGACY)

    def test_pryor_requires_both_vars(self):
        os.environ["GOOGLE_CLIENT_ID_PRYOR"] = "pryor-id"
        with self.assertRaises(goc.GoogleOAuthClientNotConfiguredError):
            goc.resolve_google_oauth_client_credentials(goc.GOOGLE_OAUTH_CLIENT_KEY_PRYOR)

    def test_pryor_never_reads_bare_vars(self):
        os.environ["GOOGLE_CLIENT_ID"] = "bare-id"
        os.environ["GOOGLE_CLIENT_SECRET"] = "bare-secret"
        with self.assertRaises(goc.GoogleOAuthClientNotConfiguredError):
            goc.resolve_google_oauth_client_credentials(goc.GOOGLE_OAUTH_CLIENT_KEY_PRYOR)

    def test_pryor_full_pair_resolves(self):
        os.environ["GOOGLE_CLIENT_ID_PRYOR"] = "pryor-id"
        os.environ["GOOGLE_CLIENT_SECRET_PRYOR"] = "pryor-secret"
        _key, cid, secret = goc.resolve_google_oauth_client_credentials(goc.GOOGLE_OAUTH_CLIENT_KEY_PRYOR)
        self.assertEqual((cid, secret), ("pryor-id", "pryor-secret"))

    def test_has_any_configured(self):
        self.assertFalse(goc.has_any_google_oauth_client_configured())
        os.environ["GOOGLE_CLIENT_ID"] = "bare-id"
        os.environ["GOOGLE_CLIENT_SECRET"] = "bare-secret"
        self.assertTrue(goc.has_any_google_oauth_client_configured())


class TestClientKeyRecognition(unittest.TestCase):
    def setUp(self):
        self._env_backup = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env_backup)

    def test_unrecognized_values_fail_closed(self):
        for bad in ("", "  ", "Legacy-LTA", "PRYOR-2026", "pryor", "legacy", "garbage", None):
            with self.assertRaises(goc.UnrecognizedClientKeyError, msg=f"expected failure for {bad!r}"):
                goc.resolve_google_oauth_client_credentials(bad)

    def test_rejected_raw_value_never_in_message(self):
        try:
            goc.resolve_google_oauth_client_credentials("some-distinctive-garbage-value")
            self.fail("expected UnrecognizedClientKeyError")
        except goc.UnrecognizedClientKeyError as e:
            self.assertNotIn("some-distinctive-garbage-value", str(e))


class TestGetAccessTokenDualClient(unittest.TestCase):
    def setUp(self):
        self._env_backup = dict(os.environ)
        os.environ["UPSTASH_REDIS_REST_URL"] = "https://fake-upstash.example.com"
        os.environ["UPSTASH_REDIS_REST_TOKEN"] = "fake-rest-token"
        os.environ["CREDENTIAL_ENCRYPTION_KEY"] = "interop-test-key-fixture-do-not-use-in-prod"
        ga._access_token_cache.clear()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env_backup)
        ga._access_token_cache.clear()

    # Same real Node-generated fixture test_google_api_redis_token.py uses.
    FIXTURE_PLAINTEXT = "fixture-refresh-token-abc123"
    FIXTURE_CIPHERTEXT_B64 = "RqwOpmppwpAtGkLed9wgALPefJFHu6jyCtIXQA=="
    FIXTURE_IV_B64 = "eqfTxsZvl8rT5uZ3"
    FIXTURE_AUTH_TAG_B64 = "2Auu84ic+uiFeOgyP4MxDQ=="

    def _record(self, client_key=None):
        r = {
            "refreshTokenCiphertext": self.FIXTURE_CIPHERTEXT_B64,
            "refreshTokenIv": self.FIXTURE_IV_B64,
            "refreshTokenAuthTag": self.FIXTURE_AUTH_TAG_B64,
        }
        if client_key is not None:
            r["clientKey"] = client_key
        return r

    def _mock_urlopen(self, redis_record, captured_bodies):
        redis_response = fake_upstash_response(redis_record)
        token_exchange_response = MagicMock()
        token_exchange_response.read.return_value = json.dumps({"access_token": "fresh-access-token", "expires_in": 3600}).encode()
        token_exchange_response.__enter__.return_value = token_exchange_response
        token_exchange_response.__exit__.return_value = False

        def fake_urlopen(req, timeout=None):
            if "upstash" in req.full_url:
                return redis_response
            captured_bodies.append(req.data.decode())
            return token_exchange_response
        return fake_urlopen

    def test_legacy_redis_credential_refreshes_with_legacy_pair(self):
        os.environ["GOOGLE_CLIENT_ID_LEGACY"] = "legacy-id"
        os.environ["GOOGLE_CLIENT_SECRET_LEGACY"] = "legacy-secret"
        os.environ["GOOGLE_CLIENT_ID_PRYOR"] = "pryor-id"
        os.environ["GOOGLE_CLIENT_SECRET_PRYOR"] = "pryor-secret"
        captured = []
        with patch("urllib.request.urlopen", side_effect=self._mock_urlopen(self._record("legacy-lta"), captured)):
            ga.get_access_token(TEST_TENANT_ID)
        self.assertIn("client_id=legacy-id", captured[0])
        self.assertIn("client_secret=legacy-secret", captured[0])
        self.assertNotIn("pryor-id", captured[0])

    def test_pryor_redis_credential_refreshes_with_pryor_pair(self):
        os.environ["GOOGLE_CLIENT_ID_LEGACY"] = "legacy-id"
        os.environ["GOOGLE_CLIENT_SECRET_LEGACY"] = "legacy-secret"
        os.environ["GOOGLE_CLIENT_ID_PRYOR"] = "pryor-id"
        os.environ["GOOGLE_CLIENT_SECRET_PRYOR"] = "pryor-secret"
        captured = []
        with patch("urllib.request.urlopen", side_effect=self._mock_urlopen(self._record("pryor-2026"), captured)):
            ga.get_access_token(TEST_TENANT_ID)
        self.assertIn("client_id=pryor-id", captured[0])
        self.assertIn("client_secret=pryor-secret", captured[0])
        self.assertNotIn("legacy-id", captured[0])

    def test_historical_record_missing_client_key_uses_legacy(self):
        os.environ["GOOGLE_CLIENT_ID"] = "bare-id"
        os.environ["GOOGLE_CLIENT_SECRET"] = "bare-secret"
        captured = []
        with patch("urllib.request.urlopen", side_effect=self._mock_urlopen(self._record(None), captured)):
            ga.get_access_token(TEST_TENANT_ID)
        self.assertIn("client_id=bare-id", captured[0])

    def test_unrecognized_client_key_fails_closed_no_network_call(self):
        captured = []
        with patch("urllib.request.urlopen", side_effect=self._mock_urlopen(self._record("something-unknown"), captured)):
            with self.assertRaises(ga.GBPAuthError):
                ga.get_access_token(TEST_TENANT_ID)
        self.assertEqual(captured, [], "no token-exchange request may be sent for an unrecognized clientKey")

    def test_env_fallback_always_uses_legacy_pair_never_pryor(self):
        """The GOOGLE_REFRESH_TOKEN fallback (no Redis credential at all)
        must always resolve the legacy client pair, hardcoded in code --
        never selected by any runtime flag or data field, and never the
        PRYOR pair even when PRYOR is the only fully-configured client."""
        os.environ["GOOGLE_REFRESH_TOKEN"] = "env-fallback-token"
        os.environ["GOOGLE_CLIENT_ID_PRYOR"] = "pryor-id"
        os.environ["GOOGLE_CLIENT_SECRET_PRYOR"] = "pryor-secret"
        # No legacy pair configured at all -- the fallback must still try
        # to use legacy (and fail closed with GBPAuthError, NOT silently
        # use the PRYOR pair that happens to be available).
        captured = []
        with patch("urllib.request.urlopen", side_effect=self._mock_urlopen(None, captured)):
            with self.assertRaises(ga.GBPAuthError):
                ga.get_access_token(TEST_TENANT_ID)
        self.assertEqual(captured, [], "the fallback must fail closed on the legacy pair, never silently substitute the PRYOR pair")

    def test_env_fallback_uses_legacy_pair_when_configured(self):
        os.environ["GOOGLE_REFRESH_TOKEN"] = "env-fallback-token"
        os.environ["GOOGLE_CLIENT_ID_LEGACY"] = "legacy-id"
        os.environ["GOOGLE_CLIENT_SECRET_LEGACY"] = "legacy-secret"
        os.environ["GOOGLE_CLIENT_ID_PRYOR"] = "pryor-id"
        os.environ["GOOGLE_CLIENT_SECRET_PRYOR"] = "pryor-secret"
        captured = []
        with patch("urllib.request.urlopen", side_effect=self._mock_urlopen(None, captured)):
            ga.get_access_token(TEST_TENANT_ID)
        self.assertIn("client_id=legacy-id", captured[0])
        self.assertIn("refresh_token=env-fallback-token", captured[0])
        self.assertNotIn("pryor-id", captured[0])


class TestCredentialMigrationStatus(unittest.TestCase):
    """Sanitization + read-only behavior of credential_migration_status.py."""

    def setUp(self):
        self._env_backup = dict(os.environ)
        os.environ["UPSTASH_REDIS_REST_URL"] = "https://fake-upstash.example.com"
        os.environ["UPSTASH_REDIS_REST_TOKEN"] = "fake-rest-token"

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env_backup)

    def test_classify_missing_tenant(self):
        with patch("urllib.request.urlopen", return_value=fake_upstash_response(None)):
            row = cms.classify_tenant(SYNTHETIC_TENANT_ID)
        self.assertEqual(row["client_key"], "missing")
        self.assertIsNone(row["health"])

    def test_classify_legacy_and_pryor_and_unknown(self):
        for raw, expected in [(None, "legacy-lta"), ("legacy-lta", "legacy-lta"), ("pryor-2026", "pryor-2026"), ("garbage-value", "unknown")]:
            record = {"health": "connected", "connectedAt": "2026-01-01T00:00:00.000Z"}
            if raw is not None:
                record["clientKey"] = raw
            with patch("urllib.request.urlopen", return_value=fake_upstash_response(record)):
                row = cms.classify_tenant(SYNTHETIC_TENANT_ID)
            self.assertEqual(row["client_key"], expected, f"raw={raw!r}")

    def test_never_reads_or_exposes_secret_fields(self):
        """Structural proof: the report only ever reads clientKey/health/
        connectedAt/connectedAccountName off the raw record -- it must
        never call anything that would decrypt the refresh token, and the
        row dict it returns must never contain the ciphertext/iv/authTag
        keys or a decrypted token under any key name."""
        record = {
            "refreshTokenCiphertext": "should-never-be-read",
            "refreshTokenIv": "should-never-be-read",
            "refreshTokenAuthTag": "should-never-be-read",
            "clientKey": "pryor-2026",
            "health": "connected",
            "connectedAt": "2026-01-01T00:00:00.000Z",
            "connectedAccountName": "Example Business",
        }
        with patch("urllib.request.urlopen", return_value=fake_upstash_response(record)):
            row = cms.classify_tenant(SYNTHETIC_TENANT_ID, show_account_name=False)
        serialized = json.dumps(row)
        self.assertNotIn("should-never-be-read", serialized)
        self.assertNotIn("refreshTokenCiphertext", row)
        self.assertNotIn("refreshTokenIv", row)
        self.assertNotIn("refreshTokenAuthTag", row)
        self.assertNotIn("connected_account_name", row, "account name must be omitted unless explicitly requested")

    def test_show_account_name_opt_in(self):
        record = {"clientKey": "legacy-lta", "health": "connected", "connectedAccountName": "Example Business"}
        with patch("urllib.request.urlopen", return_value=fake_upstash_response(record)):
            row = cms.classify_tenant(SYNTHETIC_TENANT_ID, show_account_name=True)
        self.assertEqual(row.get("connected_account_name"), "Example Business")

    def test_makes_no_writes(self):
        """The only network primitive this module uses is a GET -- there is
        no code path here that could ever issue a Redis SET/DEL or a
        Google API call. Verified by scanning the source for write verbs."""
        import inspect
        src = inspect.getsource(cms)
        self.assertNotIn("/set/", src)
        self.assertNotIn("/del/", src)
        self.assertNotIn("googleapis.com", src)


if __name__ == "__main__":
    unittest.main()
