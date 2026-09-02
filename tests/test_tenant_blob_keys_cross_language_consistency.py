"""
Multi-Tenant Phase 4F.1 -- validates tenant_blob_keys.py's key-derivation
formula against the shared cross-language fixture (see
tenantBlobKeys.js's own test file for the Node-side counterpart).

Run directly: py tests/test_tenant_blob_keys_cross_language_consistency.py
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import tenant_blob_keys as tbk  # noqa: E402

_FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "tenant_blob_keys_shape.json")


class TenantBlobKeysCrossLanguageConsistencyTestCase(unittest.TestCase):
    def setUp(self):
        with open(_FIXTURE_PATH, encoding="utf-8") as f:
            self.fixture = json.load(f)

    def test_tenant_blob_root_matches_fixture(self):
        self.assertEqual(tbk.tenant_blob_root(self.fixture["exampleTenantId"]), self.fixture["expected"]["tenantBlobRoot"])

    def test_review_db_blob_key_matches_fixture(self):
        self.assertEqual(tbk.review_db_blob_key(self.fixture["exampleTenantId"]), self.fixture["expected"]["reviewDbBlobKey"])

    def test_private_data_prefix_matches_fixture(self):
        self.assertEqual(tbk.private_data_prefix(self.fixture["exampleTenantId"]), self.fixture["expected"]["privateDataPrefix"])

    def test_private_data_blob_key_matches_fixture_for_every_listed_rel_path(self):
        for rel_path, expected_key in self.fixture["expected"]["privateDataBlobKeys"].items():
            self.assertEqual(tbk.private_data_blob_key(self.fixture["exampleTenantId"], rel_path), expected_key)

    def test_private_data_blob_key_accepts_an_explicit_prefix_matching_the_derived_one(self):
        prefix = tbk.private_data_prefix(self.fixture["exampleTenantId"])
        key = tbk.private_data_blob_key(self.fixture["exampleTenantId"], "meta.json", prefix)
        self.assertEqual(key, self.fixture["expected"]["privateDataBlobKeys"]["meta.json"])

    def test_every_fixture_listed_invalid_rel_path_is_rejected(self):
        for bad in self.fixture["invalidRelPaths"]:
            with self.assertRaises(tbk.InvalidBlobKeyInputError, msg=f"expected rejection for relPath {bad!r}"):
                tbk.private_data_blob_key(self.fixture["exampleTenantId"], bad)

    def test_an_invalid_tenant_id_is_rejected_before_any_key_is_computed(self):
        import tenant_keys
        for bad in ("", "t_..", "t_a/b", "../evil", "not-even-prefixed"):
            with self.assertRaises(tenant_keys.InvalidTenantIdError, msg=f"expected rejection for tenantId {bad!r}"):
                tbk.review_db_blob_key(bad)


if __name__ == "__main__":
    unittest.main()
