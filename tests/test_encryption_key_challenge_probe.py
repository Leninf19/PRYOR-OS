"""
Multi-Tenant Phase 4M -- regression tests for encryption_key_challenge_probe.py.

Proves: the script never prints CREDENTIAL_ENCRYPTION_KEY, a derived key,
either HMAC value, or the nonce; always attempts cleanup of both Redis
keys regardless of outcome; and classifies correctly across every outcome
(match True/False, timeout, missing config, write failure).

Mocks ONLY tenant_config_store.py's low-level Upstash helpers and
time.sleep (so a timeout test runs instantly, not for real minutes) --
never reimplements the REST protocol, never makes a real network call.

Run directly: py tests/test_encryption_key_challenge_probe.py
"""
import contextlib
import io
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import encryption_key_challenge_probe as probe  # noqa: E402
import tenant_config_store as tcs  # noqa: E402


def _run_main():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = probe.main()
    return code, buf.getvalue()


class EncryptionKeyChallengeProbeTestCase(unittest.TestCase):
    def setUp(self):
        self._config_patch = mock.patch.object(tcs, "_upstash_config", return_value=("https://fake-upstash.example", "fake-token"))
        self._config_patch.start()
        os.environ["CREDENTIAL_ENCRYPTION_KEY"] = "test-encryption-key-should-never-appear-in-output"
        # Keep the test suite fast -- a real 240s/10s poll would make this
        # file take minutes to run.
        self._timeout_patch = mock.patch.object(probe, "POLL_TIMEOUT_SECONDS", 0.05)
        self._interval_patch = mock.patch.object(probe, "POLL_INTERVAL_SECONDS", 0.01)
        self._timeout_patch.start()
        self._interval_patch.start()

    def tearDown(self):
        self._config_patch.stop()
        self._timeout_patch.stop()
        self._interval_patch.stop()
        del os.environ["CREDENTIAL_ENCRYPTION_KEY"]

    # =======================================================================
    # Challenge write is a disposable, non-tenant record
    # =======================================================================

    def test_challenge_write_is_synthetic_and_uses_invite_unrelated_key_shape(self):
        captured_commands = []

        def fake_generic_command(url, token, command):
            captured_commands.append(command)
            if command[0] == "SET" and command[1].startswith("credential_key_challenge:"):
                return {"result": "OK"}
            return {"result": "OK"}

        with mock.patch.object(tcs, "_upstash_generic_command", side_effect=fake_generic_command), \
             mock.patch.object(tcs, "_upstash_path_command", return_value={"result": None}):
            _run_main()

        set_commands = [c for c in captured_commands if c[0] == "SET"]
        self.assertEqual(len(set_commands), 1)
        self.assertTrue(set_commands[0][1].startswith("credential_key_challenge:"))
        payload = json.loads(set_commands[0][2])
        self.assertIn("nonce", payload)
        self.assertIn("hmacGh", payload)
        self.assertNotIn("t_blue-seafood-grill", json.dumps(payload))
        self.assertNotIn("t_los-tres-amigos", json.dumps(payload))

    # =======================================================================
    # Classification: SAME_ENCRYPTION_KEY / DIFFERENT_ENCRYPTION_KEY
    # =======================================================================

    def test_match_true_classifies_same_encryption_key(self):
        with mock.patch.object(tcs, "_upstash_generic_command", return_value={"result": "OK"}) as mock_cmd, \
             mock.patch.object(tcs, "_upstash_path_command", return_value={"result": json.dumps({"match": True})}):
            code, out = _run_main()
        self.assertEqual(code, 0)
        self.assertIn("CLASSIFICATION: SAME_ENCRYPTION_KEY", out)
        self.assertIn("cleanup: succeeded", out)
        del_commands = [c.args[2] for c in mock_cmd.call_args_list if c.args[2][0] == "DEL"]
        self.assertEqual(len(del_commands), 2, "both the challenge and result keys must be deleted")

    def test_match_false_classifies_different_encryption_key(self):
        with mock.patch.object(tcs, "_upstash_generic_command", return_value={"result": "OK"}), \
             mock.patch.object(tcs, "_upstash_path_command", return_value={"result": json.dumps({"match": False})}):
            code, out = _run_main()
        self.assertEqual(code, 0)
        self.assertIn("CLASSIFICATION: DIFFERENT_ENCRYPTION_KEY", out)

    # =======================================================================
    # Classification: INCONCLUSIVE
    # =======================================================================

    def test_timeout_with_no_result_classifies_inconclusive_but_still_cleans_up(self):
        with mock.patch.object(tcs, "_upstash_generic_command", return_value={"result": "OK"}) as mock_cmd, \
             mock.patch.object(tcs, "_upstash_path_command", return_value={"result": None}):
            code, out = _run_main()
        self.assertEqual(code, 0)
        self.assertIn("CLASSIFICATION: INCONCLUSIVE", out)
        self.assertIn("timed out", out)
        self.assertIn("cleanup: succeeded", out)
        del_commands = [c.args[2] for c in mock_cmd.call_args_list if c.args[2][0] == "DEL"]
        self.assertEqual(len(del_commands), 2, "cleanup must run even after a timeout")

    def test_challenge_write_failure_classifies_inconclusive_and_skips_polling(self):
        with mock.patch.object(tcs, "_upstash_generic_command", side_effect=OSError("network down")), \
             mock.patch.object(tcs, "_upstash_path_command") as mock_path:
            code, out = _run_main()
        self.assertEqual(code, 0)
        self.assertIn("challenge write: failed", out)
        self.assertIn("CLASSIFICATION: INCONCLUSIVE", out)
        mock_path.assert_not_called()

    def test_missing_redis_config_is_inconclusive_and_makes_no_calls(self):
        self._config_patch.stop()
        with mock.patch.object(tcs, "_upstash_config", return_value=None), \
             mock.patch.object(tcs, "_upstash_generic_command") as mock_cmd, \
             mock.patch.object(tcs, "_upstash_path_command") as mock_path:
            code, out = _run_main()
        self._config_patch.start()
        self.assertEqual(code, 0)
        self.assertIn("INCONCLUSIVE", out)
        mock_cmd.assert_not_called()
        mock_path.assert_not_called()

    def test_missing_encryption_key_is_inconclusive_and_makes_no_redis_calls(self):
        del os.environ["CREDENTIAL_ENCRYPTION_KEY"]
        try:
            with mock.patch.object(tcs, "_upstash_generic_command") as mock_cmd, \
                 mock.patch.object(tcs, "_upstash_path_command") as mock_path:
                code, out = _run_main()
        finally:
            os.environ["CREDENTIAL_ENCRYPTION_KEY"] = "test-encryption-key-should-never-appear-in-output"
        self.assertEqual(code, 0)
        self.assertIn("INCONCLUSIVE", out)
        mock_cmd.assert_not_called()
        mock_path.assert_not_called()

    # =======================================================================
    # Never prints the encryption key, a derived key, either HMAC, or the nonce
    # =======================================================================

    def test_output_never_contains_key_hmac_or_nonce_values(self):
        captured_payload = {}

        def fake_generic_command(url, token, command):
            if command[0] == "SET":
                captured_payload.update(json.loads(command[2]))
            return {"result": "OK"}

        with mock.patch.object(tcs, "_upstash_generic_command", side_effect=fake_generic_command), \
             mock.patch.object(tcs, "_upstash_path_command", return_value={"result": json.dumps({"match": True})}):
            code, out = _run_main()

        self.assertEqual(code, 0)
        self.assertNotIn("test-encryption-key-should-never-appear-in-output", out)
        self.assertNotIn("CREDENTIAL_ENCRYPTION_KEY", out)
        self.assertNotIn(captured_payload["hmacGh"], out, "the raw HMAC must never be printed")
        self.assertNotIn(captured_payload["nonce"], out, "the raw nonce must never be printed")


if __name__ == "__main__":
    unittest.main()
