"""
Regression tests for tenant_config_store.py -- Multi-Tenant Phase 4F. Same
mocking convention as test_google_api_redis_token.py: urllib.request.urlopen
is monkeypatched, no real Upstash account or network call anywhere here.

Run directly: py tests/test_tenant_config_store.py
"""
import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import tenant_config_store as tcs  # noqa: E402
import tenant_keys  # noqa: E402

TEST_TENANT_ID = "t_synthetic-config-store-tenant"


def fake_upstash_get_response(record_dict):
    payload = json.dumps({"result": json.dumps(record_dict) if record_dict is not None else None}).encode()
    mock_resp = MagicMock()
    mock_resp.read.return_value = payload
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = False
    return mock_resp


def fake_upstash_ok_response():
    mock_resp = MagicMock()
    mock_resp.read.return_value = json.dumps({"result": "OK"}).encode()
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = False
    return mock_resp


class TenantConfigStoreTestCase(unittest.TestCase):
    def setUp(self):
        self._env_backup = dict(os.environ)
        os.environ["UPSTASH_REDIS_REST_URL"] = "https://fake-upstash.example.com"
        os.environ["UPSTASH_REDIS_REST_TOKEN"] = "fake-rest-token"

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env_backup)

    def test_missing_config_raises_without_network_call(self):
        os.environ.pop("UPSTASH_REDIS_REST_URL", None)
        with patch("urllib.request.urlopen") as mock_urlopen:
            with self.assertRaises(tcs.TenantConfigStoreUnavailableError):
                tcs.get_tenant_config(TEST_TENANT_ID)
            mock_urlopen.assert_not_called()

    def test_get_returns_none_for_no_record(self):
        with patch("urllib.request.urlopen", return_value=fake_upstash_get_response(None)):
            self.assertIsNone(tcs.get_tenant_config(TEST_TENANT_ID))

    def test_get_parses_a_real_record(self):
        record = {"tenantId": TEST_TENANT_ID, "status": "active", "locationCatalogEnabled": True}
        with patch("urllib.request.urlopen", return_value=fake_upstash_get_response(record)):
            result = tcs.get_tenant_config(TEST_TENANT_ID)
        self.assertEqual(result, record)

    def test_get_malformed_json_raises(self):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"result": "not valid json {{{"}).encode()
        mock_resp.__enter__.return_value = mock_resp
        mock_resp.__exit__.return_value = False
        with patch("urllib.request.urlopen", return_value=mock_resp):
            with self.assertRaises(tcs.TenantConfigStoreUnavailableError):
                tcs.get_tenant_config(TEST_TENANT_ID)

    def test_network_error_raises_unavailable_not_generic_exception(self):
        with patch("urllib.request.urlopen", side_effect=OSError("ECONNREFUSED fake outage")):
            with self.assertRaises(tcs.TenantConfigStoreUnavailableError):
                tcs.get_tenant_config(TEST_TENANT_ID)

    def test_invalid_tenant_id_fails_closed_before_any_network_call(self):
        for bad in (None, "", "not-a-tenant-id", "T_UPPER", 123, "t_a/b", "t_../.."):
            with patch("urllib.request.urlopen") as mock_urlopen:
                with self.assertRaises(tenant_keys.InvalidTenantIdError):
                    tcs.get_tenant_config(bad)
                mock_urlopen.assert_not_called()

    def test_upsert_fills_in_defaults_for_a_brand_new_tenant(self):
        captured = []

        def fake_urlopen(req, timeout=None):
            if req.data is None:
                return fake_upstash_get_response(None)  # the internal "read existing" call
            captured.append(json.loads(req.data.decode()))
            return fake_upstash_ok_response()

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            record = tcs.upsert_tenant_config(TEST_TENANT_ID, {"status": "locations_approved"})

        self.assertEqual(record["tenantId"], TEST_TENANT_ID)
        self.assertEqual(record["status"], "locations_approved")
        self.assertEqual(record["locationCatalogEnabled"], False)
        self.assertEqual(record["approvedLocations"], [])
        self.assertEqual(record["locationIdMap"], {})
        self.assertEqual(record["nextLocationId"], 1)
        self.assertEqual(record["provisioning"]["status"], "none")
        self.assertEqual(len(captured), 1, "exactly one HSET command must be issued")
        self.assertEqual(captured[0][0], "HSET")
        self.assertEqual(captured[0][1], tcs.TENANT_CONFIG_KEY)
        self.assertEqual(captured[0][2], TEST_TENANT_ID)

    def test_upsert_rejects_an_invalid_status(self):
        with patch("urllib.request.urlopen", return_value=fake_upstash_get_response(None)):
            with self.assertRaises(ValueError):
                tcs.upsert_tenant_config(TEST_TENANT_ID, {"status": "not-a-real-status"})

    def test_upsert_never_lets_the_patch_override_tenant_id(self):
        with patch("urllib.request.urlopen", return_value=fake_upstash_get_response(None)):
            def fake_urlopen(req, timeout=None):
                if req.data is None:
                    return fake_upstash_get_response(None)
                return fake_upstash_ok_response()
            with patch("urllib.request.urlopen", side_effect=fake_urlopen):
                record = tcs.upsert_tenant_config(TEST_TENANT_ID, {"tenantId": "t_forged-tenant-id"})
        self.assertEqual(record["tenantId"], TEST_TENANT_ID, "the patch must never be able to override tenantId")


if __name__ == "__main__":
    unittest.main()
