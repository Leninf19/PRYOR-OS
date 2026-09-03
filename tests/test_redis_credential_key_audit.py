"""
Multi-Tenant Phase 4M -- regression tests for redis_credential_key_audit.py.

Proves: the script makes exactly one read-only Redis command (GET, never a
write/delete), never decrypts anything, never prints a refresh token,
ciphertext, IV, auth tag, CREDENTIAL_ENCRYPTION_KEY, or connectedAccountName
value, and classifies correctly across every schema/existence outcome.

Mocks ONLY tenant_config_store.py's low-level Upstash helper
(_upstash_path_command) -- never reimplements the REST protocol, never
makes a real network call, never touches a real Upstash account.

Run directly: py tests/test_redis_credential_key_audit.py
"""
import contextlib
import io
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import redis_credential_key_audit as audit  # noqa: E402
import tenant_config_store as tcs  # noqa: E402
import tenant_keys  # noqa: E402

TENANT_ID = "t_blue-seafood-grill"
EXPECTED_KEY = "gbp_credentials:v2:t_blue-seafood-grill"

FULL_RECORD = {
    "refreshTokenCiphertext": "REDACTED_CIPHERTEXT_SHOULD_NEVER_APPEAR",
    "refreshTokenIv": "REDACTED_IV_SHOULD_NEVER_APPEAR",
    "refreshTokenAuthTag": "REDACTED_TAG_SHOULD_NEVER_APPEAR",
    "connectedAccountName": "accounts/12345",
    "connectedAt": "2026-08-01T00:00:00.000Z",
    "lastOAuthRefreshAt": "2026-08-01T00:00:00.000Z",
    "lastSuccessfulSyncAt": None,
    "lastFailedSyncAt": None,
    "lastFailureReason": None,
    "health": "connected",
    "credentialVersion": 1,
}


def _run(args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        with mock.patch.object(sys, "argv", ["redis_credential_key_audit.py", *args]):
            code = audit.main()
    return code, buf.getvalue()


class RedisCredentialKeyAuditTestCase(unittest.TestCase):
    def setUp(self):
        self._config_patch = mock.patch.object(tcs, "_upstash_config", return_value=("https://fake-upstash.example", "fake-token"))
        self._config_patch.start()

    def tearDown(self):
        self._config_patch.stop()

    # =======================================================================
    # Key derivation -- Node and Python resolve the SAME formula
    # =======================================================================

    def test_reports_the_expected_v2_key_for_a_cutover_tenant(self):
        with mock.patch.object(tcs, "_upstash_path_command", return_value={"result": None}):
            _code, out = _run(["--tenant-id", TENANT_ID])
        self.assertIn(f"Node expected key   (credentialStore.js resolveCredentialKey):  {EXPECTED_KEY}", out)
        self.assertIn(f"Python expected key (tenant_keys.resolve_credential_key):       {EXPECTED_KEY}", out)
        self.assertIn("keys identical: True", out)

    def test_makes_exactly_one_read_only_get_command(self):
        with mock.patch.object(tcs, "_upstash_path_command", return_value={"result": None}) as mock_cmd:
            _run(["--tenant-id", TENANT_ID])
        self.assertEqual(mock_cmd.call_count, 1, "must make exactly one Redis command")
        _url, _token, segments = mock_cmd.call_args.args
        self.assertEqual(segments[0], "get", "must be a read-only GET, never a write/delete")
        self.assertEqual(segments[1], EXPECTED_KEY)

    # =======================================================================
    # Classification: NODE_DID_NOT_PERSIST_CREDENTIAL
    # =======================================================================

    def test_missing_key_classifies_node_did_not_persist_credential(self):
        with mock.patch.object(tcs, "_upstash_path_command", return_value={"result": None}):
            code, out = _run(["--tenant-id", TENANT_ID])
        self.assertEqual(code, 0)
        self.assertIn("key exists: False", out)
        self.assertIn("CLASSIFICATION: NODE_DID_NOT_PERSIST_CREDENTIAL", out)

    # =======================================================================
    # Classification: NODE_PYTHON_SCHEMA_MISMATCH
    # =======================================================================

    def test_record_missing_expected_field_classifies_schema_mismatch(self):
        incomplete = dict(FULL_RECORD)
        del incomplete["refreshTokenAuthTag"]
        with mock.patch.object(tcs, "_upstash_path_command", return_value={"result": json.dumps(incomplete)}):
            code, out = _run(["--tenant-id", TENANT_ID])
        self.assertEqual(code, 0)
        self.assertIn("key exists: True", out)
        self.assertIn("CLASSIFICATION: NODE_PYTHON_SCHEMA_MISMATCH", out)
        self.assertIn("refreshTokenAuthTag", out)  # field NAME reported, not any value

    # =======================================================================
    # Classification: CREDENTIAL_EXISTS_AND_PYTHON_READER_BUG
    # =======================================================================

    def test_full_matching_schema_classifies_reader_bug_hypothesis(self):
        with mock.patch.object(tcs, "_upstash_path_command", return_value={"result": json.dumps(FULL_RECORD)}):
            code, out = _run(["--tenant-id", TENANT_ID])
        self.assertEqual(code, 0)
        self.assertIn("key exists: True", out)
        self.assertIn("missing expected fields: []", out)
        self.assertIn("CLASSIFICATION: CREDENTIAL_EXISTS_AND_PYTHON_READER_BUG", out)
        self.assertIn("credentialVersion: 1", out)
        self.assertIn("health: connected", out)

    # =======================================================================
    # Classification: OTHER (malformed value)
    # =======================================================================

    def test_non_json_value_classifies_other(self):
        with mock.patch.object(tcs, "_upstash_path_command", return_value={"result": "not-json-at-all"}):
            code, out = _run(["--tenant-id", TENANT_ID])
        self.assertEqual(code, 0)
        self.assertIn("key exists: True", out)
        self.assertIn("CLASSIFICATION: OTHER", out)

    def test_missing_redis_config_is_inconclusive_and_makes_no_calls(self):
        self._config_patch.stop()
        with mock.patch.object(tcs, "_upstash_config", return_value=None), \
             mock.patch.object(tcs, "_upstash_path_command") as mock_cmd:
            code, out = _run(["--tenant-id", TENANT_ID])
        self._config_patch.start()
        self.assertEqual(code, 0)
        self.assertIn("INCONCLUSIVE", out)
        mock_cmd.assert_not_called()

    # =======================================================================
    # Never prints a secret, token, ciphertext, or account identity value
    # =======================================================================

    def test_output_never_contains_secret_or_ciphertext_or_account_values(self):
        os.environ["CREDENTIAL_ENCRYPTION_KEY"] = "should-never-appear-in-output"
        try:
            with mock.patch.object(tcs, "_upstash_path_command", return_value={"result": json.dumps(FULL_RECORD)}):
                code, out = _run(["--tenant-id", TENANT_ID])
        finally:
            del os.environ["CREDENTIAL_ENCRYPTION_KEY"]

        self.assertEqual(code, 0)
        self.assertNotIn("should-never-appear-in-output", out)
        self.assertNotIn("REDACTED_CIPHERTEXT_SHOULD_NEVER_APPEAR", out)
        self.assertNotIn("REDACTED_IV_SHOULD_NEVER_APPEAR", out)
        self.assertNotIn("REDACTED_TAG_SHOULD_NEVER_APPEAR", out)
        self.assertNotIn("accounts/12345", out)  # connectedAccountName value must never print
        self.assertNotIn("CREDENTIAL_ENCRYPTION_KEY", out)

    def test_invalid_tenant_id_is_rejected(self):
        for bad in ("not-a-tenant-id", "t_../../etc", "T_UpperCase", ""):
            with mock.patch.object(tcs, "_upstash_path_command") as mock_cmd:
                with self.assertRaises(tenant_keys.InvalidTenantIdError, msg=f"{bad!r} must be rejected"):
                    _run(["--tenant-id", bad])
                mock_cmd.assert_not_called()


if __name__ == "__main__":
    unittest.main()
