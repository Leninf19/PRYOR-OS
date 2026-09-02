"""
Cross-language consistency check -- Multi-Tenant Phase 4F. Node's
dashboard/api/_lib/tenantConfigStore.js and Python's tenant_config_store.py
both read and write the literal same tenant_config:v1 Upstash Redis hash;
there must be exactly ONE record shape, never two independently-evolving
Python/Node copies that can silently drift apart (this is the same risk
this phase's report calls out for the numeric location-id namespace, and
it applies equally to the record shape itself).

There is no live shared Redis available to two separate test runners in
different languages, so this file implements the fallback the review
explicitly allows: both languages' test suites validate their own
default-producing function against the SAME committed JSON fixture
(tests/fixtures/tenant_config_shape.json) -- see
test_tenant_config_cross_language_consistency.js for the Node half of this
same check. If either language's defaults ever drift from the fixture, that
language's own test fails immediately, without needing the other language's
test suite to run.

Run directly: py tests/test_tenant_config_cross_language_consistency.py
"""
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import tenant_config_store as tcs  # noqa: E402

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "tenant_config_shape.json"
TEST_TENANT_ID = "t_synthetic-cross-language-tenant"


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


class TenantConfigCrossLanguageConsistencyTestCase(unittest.TestCase):
    def setUp(self):
        self._env_backup = dict(os.environ)
        os.environ["UPSTASH_REDIS_REST_URL"] = "https://fake-upstash.example.com"
        os.environ["UPSTASH_REDIS_REST_TOKEN"] = "fake-rest-token"
        self.fixture = json.loads(FIXTURE_PATH.read_text())

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env_backup)

    def _fresh_default_record(self, patch_fields=None):
        def fake_urlopen(req, timeout=None):
            if req.data is None:
                return fake_upstash_get_response(None)
            return fake_upstash_ok_response()
        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            return tcs.upsert_tenant_config(TEST_TENANT_ID, patch_fields or {})

    def test_python_default_record_has_exactly_the_fixtures_top_level_fields(self):
        record = self._fresh_default_record()
        actual_fields = set(record.keys()) - {"createdAt", "updatedAt"}  # timestamps are always-present but not enumerable ahead of time
        expected_fields = set(self.fixture["topLevelFields"]) - {"createdAt", "updatedAt"}
        self.assertEqual(actual_fields, expected_fields,
                          "tenant_config_store.py's default record fields have drifted from the shared fixture -- "
                          "update tenantConfigStore.js AND this fixture together, never one side alone")

    def test_python_default_provisioning_sub_object_matches_fixture(self):
        record = self._fresh_default_record()
        self.assertEqual(set(record["provisioning"].keys()), set(self.fixture["provisioningFields"]))

    def test_python_default_values_match_fixture(self):
        record = self._fresh_default_record()
        for field, expected_value in self.fixture["defaultValues"].items():
            self.assertEqual(record[field], expected_value, f"default value for {field!r} has drifted from the shared fixture")

    def test_python_accepts_every_fixture_listed_status_rejects_unlisted(self):
        for status in self.fixture["validStatuses"]:
            record = self._fresh_default_record({"status": status})
            self.assertEqual(record["status"], status)
        with self.assertRaises(ValueError):
            self._fresh_default_record({"status": "not-in-the-fixture-at-all"})


if __name__ == "__main__":
    unittest.main()
