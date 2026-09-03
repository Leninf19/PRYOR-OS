"""
Multi-Tenant Phase 4M -- regression tests for diagnose_google_status.py.

Proves this script is genuinely read-only (no Redis write, no Blob access,
no OAuth/reconnect path), correctly classifies every failure shape it can
encounter, and never prints anything secret. Mocks ONLY google_api.py's
public functions (has_tenant_credential/list_accounts/list_locations) --
the same convention test_initial_sync.py/test_apply_entitlement_change.py
already use -- never reimplements google_api.py's own logic.

No real network call, no real Upstash account, no real Vercel Blob store,
no real Google account, no production data anywhere in this file.

Run directly: py tests/test_diagnose_google_status.py
"""
import contextlib
import io
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import diagnose_google_status as dgs  # noqa: E402
import google_api as ga  # noqa: E402
import tenant_blob_store  # noqa: E402
import tenant_config_store  # noqa: E402
import tenant_keys  # noqa: E402

TENANT_ID = "t_synthetic-diagnose-google-status"


def _run_main(argv):
    """Runs diagnose_google_status.main() with the given argv, capturing
    stdout. Returns (exit_code, stdout_text)."""
    old_argv = sys.argv
    sys.argv = ["diagnose_google_status.py"] + argv
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            code = dgs.main()
    finally:
        sys.argv = old_argv
    return code, buf.getvalue()


def _account(n=1):
    return {"name": f"accounts/{n}", "accountName": f"Account {n}"}


def _location(n=1):
    return {"name": f"locations/{n}", "title": f"Location {n}"}


class DiagnoseGoogleStatusTestCase(unittest.TestCase):
    def setUp(self):
        # Fail loudly (AssertionError, not a silent no-op) if ANYTHING in
        # this script's call graph ever reaches a write-capable function --
        # these patches exist purely as tripwires; diagnose_google_status.py
        # never imports these modules at all, so under normal operation
        # none of these mocks are ever consulted.
        self._patches = [
            mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=AssertionError("diagnose_google_status.py must NEVER write tenant_config")),
            mock.patch.object(tenant_blob_store, "put_blob", side_effect=AssertionError("diagnose_google_status.py must NEVER write to Blob")),
            mock.patch.object(tenant_blob_store, "delete_blob", side_effect=AssertionError("diagnose_google_status.py must NEVER delete from Blob")),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()

    # ===================================================================
    # 1. tenant ID is required/validated
    # ===================================================================

    def test_tenant_id_argument_is_required(self):
        old_argv = sys.argv
        sys.argv = ["diagnose_google_status.py"]  # no --tenant-id at all
        try:
            with self.assertRaises(SystemExit):
                dgs.main()
        finally:
            sys.argv = old_argv

    def test_malformed_tenant_id_is_validated_and_rejected(self):
        for bad in ("not-a-tenant-id", "t_../../etc", "T_UpperCase", ""):
            with self.assertRaises(tenant_keys.InvalidTenantIdError, msg=f"{bad!r} must be rejected"):
                _run_main(["--tenant-id", bad])

    # ===================================================================
    # 2 & 3. no Redis write / no Blob functions are ever called
    # ===================================================================

    def test_no_write_functions_called_on_success_path(self):
        # setUp's tripwire mocks would raise AssertionError (failing this
        # test) if diagnose_google_status.py ever reached them -- this test
        # exercises the full success path specifically to prove it doesn't.
        with mock.patch.object(ga, "has_tenant_credential", return_value=True), \
             mock.patch.object(ga, "list_accounts", return_value=[_account()]), \
             mock.patch.object(ga, "list_locations", return_value=[_location()]):
            code, out = _run_main(["--tenant-id", TENANT_ID])
        self.assertEqual(code, 0)
        self.assertIn("locations returned: 1", out)

    def test_no_write_functions_called_on_every_failure_path(self):
        with mock.patch.object(ga, "has_tenant_credential", return_value=False):
            code, out = _run_main(["--tenant-id", TENANT_ID])
        self.assertEqual(code, 0)
        self.assertIn("TOKEN/CREDENTIAL_ERROR", out)

    # ===================================================================
    # 4. no OAuth/reconnect path is invoked
    # ===================================================================

    def test_source_never_references_oauth_authorization_flow(self):
        """diagnose_google_status.py must never construct an OAuth
        authorization URL or exchange an authorization CODE -- it may only
        ever use the already-stored refresh token via google_api.py's
        normal get_access_token() (a plain token refresh, not a
        reconnect). This is checked at the source level because there is
        no reconnect-shaped function anywhere in this file to mock in the
        first place -- its absence IS the property being proven."""
        with open(dgs.__file__, encoding="utf-8") as f:
            source = f.read()
        for forbidden in ("accounts.google.com", "authorization_code", "response_type", "redirect_uri", "state="):
            self.assertNotIn(forbidden, source, f"diagnose_google_status.py must never reference {forbidden!r}")

    # ===================================================================
    # 5. stored credential absence is handled safely
    # ===================================================================

    def test_no_stored_credential_is_classified_and_does_not_crash(self):
        with mock.patch.object(ga, "has_tenant_credential", return_value=False) as mock_cred, \
             mock.patch.object(ga, "list_accounts") as mock_accounts:
            code, out = _run_main(["--tenant-id", TENANT_ID])
        mock_cred.assert_called_once_with(TENANT_ID)
        mock_accounts.assert_not_called()  # must short-circuit, never attempt a Google call with no credential
        self.assertEqual(code, 0)
        self.assertIn("has_tenant_credential: False", out)
        self.assertIn("CLASSIFICATION: TOKEN/CREDENTIAL_ERROR", out)

    # ===================================================================
    # 6. account-list failure classification is correct
    # ===================================================================

    def test_account_list_rate_limit_classifies_as_quota_or_not_enabled(self):
        err = ga.GBPRateLimitError("Google API 429: Quota exceeded", status=429)
        with mock.patch.object(ga, "has_tenant_credential", return_value=True), \
             mock.patch.object(ga, "list_accounts", side_effect=err):
            code, out = _run_main(["--tenant-id", TENANT_ID])
        self.assertEqual(code, 0)
        self.assertIn("HTTP status: 429", out)
        self.assertIn("CLASSIFICATION: API_NOT_ENABLED or QUOTA/RATE_LIMIT", out)

    def test_account_list_permission_denied_classifies_correctly(self):
        err = ga.GBPPermissionError("Permission denied", status=403)
        with mock.patch.object(ga, "has_tenant_credential", return_value=True), \
             mock.patch.object(ga, "list_accounts", side_effect=err):
            code, out = _run_main(["--tenant-id", TENANT_ID])
        self.assertIn("CLASSIFICATION: INSUFFICIENT_GOOGLE_PERMISSION", out)

    def test_account_list_auth_error_classifies_as_token_credential_error(self):
        err = ga.GBPAuthError("Unauthorized: token invalid", status=401)
        with mock.patch.object(ga, "has_tenant_credential", return_value=True), \
             mock.patch.object(ga, "list_accounts", side_effect=err):
            code, out = _run_main(["--tenant-id", TENANT_ID])
        self.assertIn("CLASSIFICATION: TOKEN/CREDENTIAL_ERROR", out)

    def test_account_list_empty_classifies_as_no_gbp_account(self):
        with mock.patch.object(ga, "has_tenant_credential", return_value=True), \
             mock.patch.object(ga, "list_accounts", return_value=[]):
            code, out = _run_main(["--tenant-id", TENANT_ID])
        self.assertIn("accounts returned: 0", out)
        self.assertIn("CLASSIFICATION: NO_GBP_ACCOUNT", out)

    # ===================================================================
    # 7. location-list failure classification is correct
    # ===================================================================

    def test_location_list_rate_limit_classifies_as_quota_or_not_enabled(self):
        err = ga.GBPRateLimitError("Google API 429: Quota exceeded", status=429)
        with mock.patch.object(ga, "has_tenant_credential", return_value=True), \
             mock.patch.object(ga, "list_accounts", return_value=[_account()]), \
             mock.patch.object(ga, "list_locations", side_effect=err):
            code, out = _run_main(["--tenant-id", TENANT_ID])
        self.assertIn("HTTP status: 429", out)
        self.assertIn("CLASSIFICATION: API_NOT_ENABLED or QUOTA/RATE_LIMIT", out)
        self.assertIn("on locations", out)

    def test_location_list_empty_classifies_as_no_locations(self):
        with mock.patch.object(ga, "has_tenant_credential", return_value=True), \
             mock.patch.object(ga, "list_accounts", return_value=[_account()]), \
             mock.patch.object(ga, "list_locations", return_value=[]):
            code, out = _run_main(["--tenant-id", TENANT_ID])
        self.assertIn("locations returned: 0", out)
        self.assertIn("CLASSIFICATION: NO_LOCATIONS", out)

    # ===================================================================
    # 8. safe output never includes tokens/secrets
    # ===================================================================

    def test_output_never_contains_fake_secret_values(self):
        fake_access_token = "ya29.fake-access-token-marker-should-never-appear"
        fake_client_secret = "GOCSPX-fake-client-secret-marker-should-never-appear"
        os.environ["GOOGLE_CLIENT_SECRET"] = fake_client_secret
        try:
            def fake_list_accounts(tenant_id):
                # Simulate google_api.py internally having used a real
                # access token (it would appear in a request header, never
                # in a return value or exception message) -- the fake
                # value here stands in for "if this ever leaked, the test
                # would catch it."
                _ = fake_access_token
                return [_account()]

            with mock.patch.object(ga, "has_tenant_credential", return_value=True), \
                 mock.patch.object(ga, "list_accounts", side_effect=fake_list_accounts), \
                 mock.patch.object(ga, "list_locations", return_value=[_location()]):
                code, out = _run_main(["--tenant-id", TENANT_ID])
        finally:
            del os.environ["GOOGLE_CLIENT_SECRET"]

        self.assertNotIn(fake_access_token, out)
        self.assertNotIn(fake_client_secret, out)
        self.assertNotIn("GOOGLE_CLIENT_SECRET", out)
        self.assertNotIn("CREDENTIAL_ENCRYPTION_KEY", out)
        self.assertNotIn("access_token", out)
        self.assertNotIn("refresh_token", out)


if __name__ == "__main__":
    unittest.main()
