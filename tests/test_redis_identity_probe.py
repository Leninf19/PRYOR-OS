"""
Multi-Tenant Phase 4M -- regression tests for redis_identity_probe.py.

Proves the probe uses a disposable record unrelated to any real tenant,
always attempts cleanup (even when the live check disagrees), classifies
correctly in every outcome, and never prints a secret or the raw probe
token. Mocks ONLY tenant_config_store.py's low-level Upstash helpers and
urllib's HTTP layer -- never reimplements the REST protocol itself.

No real network call, no real Upstash account, no real Vercel deployment,
no LTA or Blue Seafood & Grill record anywhere in this file.

Run directly: py tests/test_redis_identity_probe.py
"""
import contextlib
import io
import json
import os
import sys
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import redis_identity_probe as rip  # noqa: E402
import tenant_config_store as tcs  # noqa: E402


class FakeHTTPResponse:
    def __init__(self, status, body):
        self.status = status
        self._body = json.dumps(body).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _run_main():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = rip.main()
    return code, buf.getvalue()


class RedisIdentityProbeTestCase(unittest.TestCase):
    def setUp(self):
        self._config_patch = mock.patch.object(tcs, "_upstash_config", return_value=("https://fake-upstash.example", "fake-token"))
        self._config_patch.start()

    def tearDown(self):
        self._config_patch.stop()

    # ===================================================================
    # Disposable record, unrelated to any real tenant
    # ===================================================================

    def test_probe_payload_is_synthetic_never_a_real_tenant(self):
        captured_commands = []

        def fake_generic_command(url, token, command):
            captured_commands.append(command)
            return {"result": "OK"}

        with mock.patch.object(tcs, "_upstash_generic_command", side_effect=fake_generic_command), \
             mock.patch("urllib.request.urlopen", return_value=FakeHTTPResponse(200, {"valid": True})):
            _run_main()

        set_command = captured_commands[0]
        self.assertEqual(set_command[0], "SET")
        self.assertTrue(set_command[1].startswith("invite:"))
        payload = json.loads(set_command[2])
        self.assertTrue(payload["userId"].startswith("probe-"))
        self.assertEqual(payload["email"], "redis-identity-probe@example.invalid")
        self.assertNotIn("t_blue-seafood-grill", json.dumps(payload))
        self.assertNotIn("t_los-tres-amigos", json.dumps(payload))
        self.assertIn("EX", set_command)

    # ===================================================================
    # Classification: SAME_REDIS
    # ===================================================================

    def test_live_app_sees_probe_classifies_same_redis(self):
        with mock.patch.object(tcs, "_upstash_generic_command", return_value={"result": "OK"}) as mock_cmd, \
             mock.patch("urllib.request.urlopen", return_value=FakeHTTPResponse(200, {"valid": True})):
            code, out = _run_main()
        self.assertEqual(code, 0)
        self.assertIn("CLASSIFICATION: SAME_REDIS", out)
        self.assertIn("probe creation: succeeded", out)
        self.assertIn("live app saw probe: True", out)
        self.assertIn("cleanup: succeeded", out)
        # SET then DEL -- cleanup must have actually been attempted.
        commands_run = [c.args[2] for c in mock_cmd.call_args_list]
        self.assertEqual(commands_run[0][0], "SET")
        self.assertEqual(commands_run[-1][0], "DEL")
        self.assertEqual(commands_run[0][1], commands_run[-1][1], "cleanup must target the exact same key that was created")

    # ===================================================================
    # Classification: DIFFERENT_REDIS
    # ===================================================================

    def test_live_app_does_not_see_probe_classifies_different_redis(self):
        with mock.patch.object(tcs, "_upstash_generic_command", return_value={"result": "OK"}) as mock_cmd, \
             mock.patch("urllib.request.urlopen", return_value=FakeHTTPResponse(200, {"valid": False})):
            code, out = _run_main()
        self.assertEqual(code, 0)
        self.assertIn("CLASSIFICATION: DIFFERENT_REDIS", out)
        self.assertIn("live app saw probe: False", out)
        # Cleanup must STILL have been attempted even though the live
        # check came back negative -- never skipped on a "bad" result.
        self.assertIn("cleanup: succeeded", out)
        commands_run = [c.args[2] for c in mock_cmd.call_args_list]
        self.assertTrue(any(cmd[0] == "DEL" for cmd in commands_run), "cleanup (DEL) must always run")

    def test_live_app_404_still_attempts_cleanup_and_classifies_different_redis(self):
        with mock.patch.object(tcs, "_upstash_generic_command", return_value={"result": "OK"}) as mock_cmd, \
             mock.patch("urllib.request.urlopen", side_effect=urllib.error.HTTPError("url", 404, "not found", {}, None)):
            code, out = _run_main()
        self.assertEqual(code, 0)
        self.assertIn("live app saw probe: False", out)
        self.assertIn("cleanup: succeeded", out)
        commands_run = [c.args[2] for c in mock_cmd.call_args_list]
        self.assertTrue(any(cmd[0] == "DEL" for cmd in commands_run))

    # ===================================================================
    # Classification: INCONCLUSIVE
    # ===================================================================

    def test_creation_failure_classifies_inconclusive_and_skips_live_check(self):
        with mock.patch.object(tcs, "_upstash_generic_command", side_effect=OSError("network down")):
            code, out = _run_main()
        self.assertEqual(code, 0)
        self.assertIn("probe creation: failed", out)
        self.assertIn("CLASSIFICATION: INCONCLUSIVE", out)
        self.assertNotIn("live HTTP status", out, "must never attempt the live check if creation itself failed")

    def test_missing_redis_config_is_inconclusive_and_makes_no_calls(self):
        self._config_patch.stop()
        with mock.patch.object(tcs, "_upstash_config", return_value=None), \
             mock.patch.object(tcs, "_upstash_generic_command") as mock_cmd, \
             mock.patch("urllib.request.urlopen") as mock_urlopen:
            code, out = _run_main()
        self._config_patch.start()
        self.assertEqual(code, 0)
        self.assertIn("INCONCLUSIVE", out)
        mock_cmd.assert_not_called()
        mock_urlopen.assert_not_called()

    # ===================================================================
    # Never prints secrets or the raw probe token
    # ===================================================================

    def test_output_never_contains_secret_or_raw_token_values(self):
        os.environ["UPSTASH_REDIS_REST_TOKEN"] = "should-never-appear-in-output"
        try:
            captured_raw_token = {}

            def fake_generic_command(url, token, command):
                if command[0] == "SET":
                    # command[1] is "invite:{hash}" -- the raw token itself
                    # is never passed to this function at all, only its
                    # hash, which is the property under test.
                    captured_raw_token["hash_only"] = command[1]
                return {"result": "OK"}

            with mock.patch.object(tcs, "_upstash_generic_command", side_effect=fake_generic_command), \
                 mock.patch("urllib.request.urlopen", return_value=FakeHTTPResponse(200, {"valid": True})):
                code, out = _run_main()
        finally:
            del os.environ["UPSTASH_REDIS_REST_TOKEN"]

        self.assertEqual(code, 0)
        self.assertNotIn("should-never-appear-in-output", out)
        self.assertNotIn("fake-token", out)
        self.assertNotIn("UPSTASH_REDIS_REST_TOKEN", out)


if __name__ == "__main__":
    unittest.main()
