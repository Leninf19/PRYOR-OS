"""
Multi-Tenant Phase 4H.1 -- tests for tenant_status_report.py, the GitHub
Actions Job Summary generator .github/workflows/tenant-lifecycle.yml calls.
Proves it never crashes on missing/unavailable state and never prints a
credential/token/raw sensitive value. No real Upstash account, no real
Vercel Blob store, no production data.

Run directly: py tests/test_tenant_status_report.py
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import google_api  # noqa: E402
import tenant_config_store  # noqa: E402
import tenant_status_report as report  # noqa: E402

TENANT_A = "t_synthetic-status-report-tenant"


class TenantStatusReportTestCase(unittest.TestCase):
    def test_unknown_tenant_reports_missing_record_without_crashing(self):
        with mock.patch.object(tenant_config_store, "get_tenant_config", return_value=None):
            summary = report.build_summary(TENANT_A, "initial_sync")
        self.assertIn("No tenant_config record exists", summary)

    def test_store_unavailable_reports_cleanly_without_crashing(self):
        with mock.patch.object(tenant_config_store, "get_tenant_config",
                                side_effect=tenant_config_store.TenantConfigStoreUnavailableError("boom")):
            summary = report.build_summary(TENANT_A, "provision")
        self.assertIn("store unavailable", summary)

    def test_full_summary_contains_every_required_field(self):
        config = {
            "tenantId": TENANT_A, "status": "active", "storageMode": "BLOB",
            "approvedLocations": [{"locationId": 1, "googleLocationId": "accounts/1/locations/1"}],
            "provisioning": {"status": "provisioned", "lastAttemptAt": "2026-01-01T00:00:00Z", "artifactGeneration": "gen-abc123"},
            "initialSync": {
                "status": "completed", "startedAt": "2026-01-01T00:01:00Z", "completedAt": "2026-01-01T00:02:00Z",
                "failedAt": None, "reviewCount": 42, "locationCount": 1, "lastError": None,
            },
        }
        with mock.patch.object(tenant_config_store, "get_tenant_config", return_value=config), \
             mock.patch.object(google_api, "has_tenant_credential", return_value=True):
            summary = report.build_summary(TENANT_A, "initial_sync")

        for expected in ("active", "BLOB", "provisioned", "completed", "42", "gen-abc123", "True"):
            self.assertIn(expected, summary, f"expected {expected!r} in summary:\n{summary}")

    def test_last_error_is_surfaced_when_present(self):
        config = {
            "tenantId": TENANT_A, "status": "initial_sync_failed", "storageMode": "BLOB",
            "approvedLocations": [],
            "provisioning": {"status": "provisioned", "lastAttemptAt": None, "artifactGeneration": "gen-abc123"},
            "initialSync": {
                "status": "failed", "startedAt": None, "completedAt": None, "failedAt": "2026-01-01T00:00:00Z",
                "reviewCount": None, "locationCount": None, "lastError": "GoogleSyncFailedError: simulated failure",
            },
        }
        with mock.patch.object(tenant_config_store, "get_tenant_config", return_value=config), \
             mock.patch.object(google_api, "has_tenant_credential", return_value=False):
            summary = report.build_summary(TENANT_A, "initial_sync")
        self.assertIn("GoogleSyncFailedError: simulated failure", summary)

    def test_credential_check_failure_degrades_to_unknown_never_crashes(self):
        config = {
            "tenantId": TENANT_A, "status": "provisioned", "storageMode": "BLOB",
            "approvedLocations": [], "provisioning": {}, "initialSync": {},
        }
        with mock.patch.object(tenant_config_store, "get_tenant_config", return_value=config), \
             mock.patch.object(google_api, "has_tenant_credential", side_effect=RuntimeError("redis down")):
            summary = report.build_summary(TENANT_A, "provision")
        self.assertIn("unknown", summary)

    def test_invalid_tenant_id_never_reads_the_store(self):
        with mock.patch.object(tenant_config_store, "get_tenant_config") as mock_get:
            with mock.patch("sys.argv", ["tenant_status_report.py", "--tenant-id", "not-valid", "--operation", "provision"]):
                report.main()
            mock_get.assert_not_called()

    def test_summary_never_contains_a_credential_shaped_value(self):
        """The one thing this script must never do: print a raw refresh
        token or any other secret-shaped value. has_tenant_credential()
        only ever returns a bool, never the credential itself -- this
        proves the summary text reflects that (a bare True/False, never a
        token string)."""
        config = {
            "tenantId": TENANT_A, "status": "active", "storageMode": "BLOB",
            "approvedLocations": [], "provisioning": {}, "initialSync": {},
        }
        fake_token = "1//0gFAKE_REFRESH_TOKEN_VALUE_SHOULD_NEVER_APPEAR"
        with mock.patch.object(tenant_config_store, "get_tenant_config", return_value=config), \
             mock.patch.object(google_api, "has_tenant_credential", return_value=True), \
             mock.patch.object(google_api, "_fetch_refresh_token_from_redis", return_value=fake_token):
            summary = report.build_summary(TENANT_A, "initial_sync")
        self.assertNotIn(fake_token, summary)
        self.assertNotIn("refresh_token", summary.lower())


if __name__ == "__main__":
    unittest.main()
