"""
Multi-Tenant Phase 4M -- regression tests for encryption_key_challenge_probe.py's
split create/poll lifecycle.

Proves: `create` never prints or writes to the --out file anything but the
request_id (or the NONE sentinel) -- never CREDENTIAL_ENCRYPTION_KEY, a
derived key, either HMAC value, or the nonce; `poll` never needs
CREDENTIAL_ENCRYPTION_KEY at all; cleanup always runs regardless of
outcome; and the two stages compose correctly end to end via the shared
request-id file (the same mechanism the workflow uses to hand the
non-secret request_id to a GitHub Actions artifact between them).

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
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import encryption_key_challenge_probe as probe  # noqa: E402
import tenant_config_store as tcs  # noqa: E402


def _run_create(out_path):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = probe.create(out_path)
    return code, buf.getvalue()


def _run_poll(request_id_file):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = probe.poll(request_id_file)
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
        fd, self._out_path = tempfile.mkstemp()
        os.close(fd)

    def tearDown(self):
        self._config_patch.stop()
        self._timeout_patch.stop()
        self._interval_patch.stop()
        del os.environ["CREDENTIAL_ENCRYPTION_KEY"]
        if os.path.exists(self._out_path):
            os.remove(self._out_path)

    def _out_contents(self):
        with open(self._out_path, "r", encoding="utf-8") as f:
            return f.read().strip()

    # =======================================================================
    # create: challenge write is a disposable, non-tenant record
    # =======================================================================

    def test_create_writes_synthetic_challenge_and_request_id_file(self):
        captured_commands = []

        def fake_generic_command(url, token, command):
            captured_commands.append(command)
            return {"result": "OK"}

        with mock.patch.object(tcs, "_upstash_generic_command", side_effect=fake_generic_command):
            code, out = _run_create(self._out_path)

        self.assertEqual(code, 0)
        set_commands = [c for c in captured_commands if c[0] == "SET"]
        self.assertEqual(len(set_commands), 1)
        self.assertTrue(set_commands[0][1].startswith("credential_key_challenge:"))
        payload = json.loads(set_commands[0][2])
        self.assertIn("nonce", payload)
        self.assertIn("hmacGh", payload)
        self.assertNotIn("t_blue-seafood-grill", json.dumps(payload))
        self.assertNotIn("t_los-tres-amigos", json.dumps(payload))

        request_id = self._out_contents()
        self.assertRegex(request_id, r"^[0-9a-f]{32}$", "the --out file must contain exactly the 32-hex-char request_id")
        self.assertIn(f"request_id: {request_id}", out)

    def test_create_TTL_is_the_preserved_300_second_default(self):
        captured_commands = []
        with mock.patch.object(tcs, "_upstash_generic_command", side_effect=lambda u, t, c: (captured_commands.append(c), {"result": "OK"})[1]):
            _run_create(self._out_path)
        set_command = next(c for c in captured_commands if c[0] == "SET")
        self.assertEqual(set_command[-2], "EX")
        self.assertEqual(set_command[-1], "300", "the challenge TTL must remain the existing 300 seconds, not silently change")
        self.assertEqual(probe.CHALLENGE_TTL_SECONDS, 300)

    # =======================================================================
    # create: failure/unconfigured paths write the NONE sentinel, never a
    # half-valid request_id
    # =======================================================================

    def test_create_write_failure_writes_sentinel_and_inconclusive(self):
        with mock.patch.object(tcs, "_upstash_generic_command", side_effect=OSError("network down")):
            code, out = _run_create(self._out_path)
        self.assertEqual(code, 0)
        self.assertIn("challenge write: failed", out)
        self.assertEqual(self._out_contents(), probe.NO_CHALLENGE_SENTINEL)

    def test_create_missing_redis_config_writes_sentinel_and_makes_no_calls(self):
        self._config_patch.stop()
        with mock.patch.object(tcs, "_upstash_config", return_value=None), \
             mock.patch.object(tcs, "_upstash_generic_command") as mock_cmd:
            code, out = _run_create(self._out_path)
        self._config_patch.start()
        self.assertEqual(code, 0)
        self.assertIn("INCONCLUSIVE", out)
        self.assertEqual(self._out_contents(), probe.NO_CHALLENGE_SENTINEL)
        mock_cmd.assert_not_called()

    def test_create_missing_encryption_key_writes_sentinel_and_makes_no_redis_calls(self):
        del os.environ["CREDENTIAL_ENCRYPTION_KEY"]
        try:
            with mock.patch.object(tcs, "_upstash_generic_command") as mock_cmd:
                code, out = _run_create(self._out_path)
        finally:
            os.environ["CREDENTIAL_ENCRYPTION_KEY"] = "test-encryption-key-should-never-appear-in-output"
        self.assertEqual(code, 0)
        self.assertIn("INCONCLUSIVE", out)
        self.assertEqual(self._out_contents(), probe.NO_CHALLENGE_SENTINEL)
        mock_cmd.assert_not_called()

    # =======================================================================
    # poll: classification, always using a request_id produced by a real
    # (mocked) create call -- proves the split lifecycle composes correctly
    # =======================================================================

    def test_poll_match_true_classifies_same_encryption_key(self):
        with mock.patch.object(tcs, "_upstash_generic_command", return_value={"result": "OK"}):
            _run_create(self._out_path)
        with mock.patch.object(tcs, "_upstash_generic_command", return_value={"result": "OK"}) as mock_cmd, \
             mock.patch.object(tcs, "_upstash_path_command", return_value={"result": json.dumps({"match": True})}):
            code, out = _run_poll(self._out_path)
        self.assertEqual(code, 0)
        self.assertIn("CLASSIFICATION: SAME_ENCRYPTION_KEY", out)
        self.assertIn("cleanup: succeeded", out)
        del_commands = [c.args[2] for c in mock_cmd.call_args_list if c.args[2][0] == "DEL"]
        self.assertEqual(len(del_commands), 2, "both the challenge and result keys must be deleted")

    def test_poll_match_false_classifies_different_encryption_key(self):
        with mock.patch.object(tcs, "_upstash_generic_command", return_value={"result": "OK"}):
            _run_create(self._out_path)
        with mock.patch.object(tcs, "_upstash_generic_command", return_value={"result": "OK"}), \
             mock.patch.object(tcs, "_upstash_path_command", return_value={"result": json.dumps({"match": False})}):
            code, out = _run_poll(self._out_path)
        self.assertEqual(code, 0)
        self.assertIn("CLASSIFICATION: DIFFERENT_ENCRYPTION_KEY", out)

    def test_poll_timeout_classifies_inconclusive_but_still_cleans_up(self):
        with mock.patch.object(tcs, "_upstash_generic_command", return_value={"result": "OK"}):
            _run_create(self._out_path)
        with mock.patch.object(tcs, "_upstash_generic_command", return_value={"result": "OK"}) as mock_cmd, \
             mock.patch.object(tcs, "_upstash_path_command", return_value={"result": None}):
            code, out = _run_poll(self._out_path)
        self.assertEqual(code, 0)
        self.assertIn("CLASSIFICATION: INCONCLUSIVE", out)
        self.assertIn("timed out", out)
        self.assertIn("cleanup: succeeded", out)
        del_commands = [c.args[2] for c in mock_cmd.call_args_list if c.args[2][0] == "DEL"]
        self.assertEqual(len(del_commands), 2, "cleanup must run even after a timeout")

    def test_poll_with_none_sentinel_is_inconclusive_and_makes_no_calls(self):
        with open(self._out_path, "w", encoding="utf-8") as f:
            f.write(probe.NO_CHALLENGE_SENTINEL)
        with mock.patch.object(tcs, "_upstash_generic_command") as mock_cmd, \
             mock.patch.object(tcs, "_upstash_path_command") as mock_path:
            code, out = _run_poll(self._out_path)
        self.assertEqual(code, 0)
        self.assertIn("CLASSIFICATION: INCONCLUSIVE", out)
        mock_cmd.assert_not_called()
        mock_path.assert_not_called()

    def test_poll_missing_redis_config_is_inconclusive(self):
        with mock.patch.object(tcs, "_upstash_generic_command", return_value={"result": "OK"}):
            _run_create(self._out_path)
        self._config_patch.stop()
        with mock.patch.object(tcs, "_upstash_config", return_value=None), \
             mock.patch.object(tcs, "_upstash_path_command") as mock_path:
            code, out = _run_poll(self._out_path)
        self._config_patch.start()
        self.assertEqual(code, 0)
        self.assertIn("INCONCLUSIVE", out)
        mock_path.assert_not_called()

    # =======================================================================
    # poll never needs CREDENTIAL_ENCRYPTION_KEY -- the whole point of
    # splitting create/poll into separate steps is that the poll (and the
    # artifact-upload step between them) never see it at all.
    # =======================================================================

    def test_poll_succeeds_with_no_encryption_key_in_its_environment(self):
        with mock.patch.object(tcs, "_upstash_generic_command", return_value={"result": "OK"}):
            _run_create(self._out_path)
        del os.environ["CREDENTIAL_ENCRYPTION_KEY"]
        try:
            with mock.patch.object(tcs, "_upstash_generic_command", return_value={"result": "OK"}), \
                 mock.patch.object(tcs, "_upstash_path_command", return_value={"result": json.dumps({"match": True})}):
                code, out = _run_poll(self._out_path)
        finally:
            os.environ["CREDENTIAL_ENCRYPTION_KEY"] = "test-encryption-key-should-never-appear-in-output"
        self.assertEqual(code, 0)
        self.assertIn("CLASSIFICATION: SAME_ENCRYPTION_KEY", out)

    # =======================================================================
    # End-to-end split lifecycle: create's request_id is exactly what poll
    # consumes and cleans up -- proves the file handoff (the artifact, in
    # the real workflow) actually carries the right value.
    # =======================================================================

    def test_create_then_poll_end_to_end_uses_the_same_request_id(self):
        captured = {}

        def fake_generic_command(url, token, command):
            if command[0] == "SET":
                captured["request_id"] = command[1].split(":", 1)[1]
            if command[0] == "DEL":
                captured.setdefault("deleted", []).append(command[1])
            return {"result": "OK"}

        with mock.patch.object(tcs, "_upstash_generic_command", side_effect=fake_generic_command):
            _create_code, _create_out = _run_create(self._out_path)

        request_id_from_file = self._out_contents()
        self.assertEqual(request_id_from_file, captured["request_id"])

        with mock.patch.object(tcs, "_upstash_generic_command", side_effect=fake_generic_command), \
             mock.patch.object(tcs, "_upstash_path_command", return_value={"result": json.dumps({"match": True})}):
            poll_code, poll_out = _run_poll(self._out_path)

        self.assertEqual(poll_code, 0)
        self.assertIn("CLASSIFICATION: SAME_ENCRYPTION_KEY", poll_out)
        self.assertIn(f"credential_key_challenge:{request_id_from_file}", captured["deleted"])
        self.assertIn(f"credential_key_challenge_result:{request_id_from_file}", captured["deleted"])

    # =======================================================================
    # Never prints/writes the encryption key, a derived key, either HMAC,
    # or the nonce -- checked across BOTH stages and the --out file itself.
    # =======================================================================

    def test_output_and_request_id_file_never_contain_key_hmac_or_nonce_values(self):
        captured_payload = {}

        def fake_generic_command(url, token, command):
            if command[0] == "SET":
                captured_payload.update(json.loads(command[2]))
            return {"result": "OK"}

        with mock.patch.object(tcs, "_upstash_generic_command", side_effect=fake_generic_command):
            create_code, create_out = _run_create(self._out_path)
        with mock.patch.object(tcs, "_upstash_generic_command", side_effect=fake_generic_command), \
             mock.patch.object(tcs, "_upstash_path_command", return_value={"result": json.dumps({"match": True})}):
            poll_code, poll_out = _run_poll(self._out_path)

        self.assertEqual(create_code, 0)
        self.assertEqual(poll_code, 0)
        combined = create_out + poll_out + self._out_contents()
        self.assertNotIn("test-encryption-key-should-never-appear-in-output", combined)
        self.assertNotIn("CREDENTIAL_ENCRYPTION_KEY", combined)
        self.assertNotIn(captured_payload["hmacGh"], combined, "the raw HMAC must never be printed or written to the request-id file")
        self.assertNotIn(captured_payload["nonce"], combined, "the raw nonce must never be printed or written to the request-id file")


if __name__ == "__main__":
    unittest.main()
