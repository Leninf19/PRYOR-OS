"""
Multi-Tenant Phase 4F.1 -- unit tests for tenant_blob_store.py's raw REST
client. Mocks urllib.request.urlopen directly (no real network call, no
real Vercel Blob store) and asserts the exact request shape (method, URL,
headers, body) this module sends, matching what was read directly out of
the installed @vercel/blob@2.8.0 SDK's own request-building code -- see that
module's header comment. Also verifies error-code-to-exception mapping and
that a missing BLOB_READ_WRITE_TOKEN fails closed without any network call.

Run directly: py tests/test_tenant_blob_store.py
"""
import json
import os
import sys
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import tenant_blob_store as tbs  # noqa: E402

FAKE_TOKEN = "vercel_blob_rw_teststoreid123_secretpart"


class FakeHTTPResponse:
    def __init__(self, body: bytes):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def fake_http_error(code, body: dict):
    return urllib.error.HTTPError(
        url="https://vercel.com/api/blob/", code=code, msg="error",
        hdrs=None, fp=None,
    ), json.dumps(body).encode("utf-8")


class TenantBlobStoreTestCase(unittest.TestCase):
    def setUp(self):
        self._env_patch = mock.patch.dict(os.environ, {"BLOB_READ_WRITE_TOKEN": FAKE_TOKEN})
        self._env_patch.start()

    def tearDown(self):
        self._env_patch.stop()

    def test_missing_token_fails_closed_without_any_network_call(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with mock.patch("urllib.request.urlopen") as mock_urlopen:
                with self.assertRaises(tbs.BlobStoreUnavailableError):
                    tbs.put_blob("tenant-data/x/reviews.db", b"data")
                mock_urlopen.assert_not_called()

    def test_store_id_parsed_from_token(self):
        self.assertEqual(tbs._store_id_from_token(FAKE_TOKEN), "teststoreid123")

    def test_put_blob_sends_correct_method_url_and_headers_for_fresh_upload(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["headers"] = {k.lower(): v for k, v in req.headers.items()}
            captured["data"] = req.data
            return FakeHTTPResponse(json.dumps({
                "url": "https://fake/tenant-data/x/reviews.db", "downloadUrl": "https://fake/x",
                "pathname": "tenant-data/x/reviews.db", "contentType": "application/octet-stream",
                "contentDisposition": "", "etag": "etag-abc",
            }).encode("utf-8"))

        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            result = tbs.put_blob("tenant-data/x/reviews.db", b"hello", allow_overwrite=False)

        self.assertEqual(captured["method"], "PUT")
        self.assertIn("https://vercel.com/api/blob/", captured["url"])
        self.assertIn("pathname=tenant-data", captured["url"])
        self.assertEqual(captured["headers"]["authorization"], f"Bearer {FAKE_TOKEN}")
        self.assertEqual(captured["headers"]["x-vercel-blob-store-id"], "teststoreid123")
        self.assertEqual(captured["headers"]["x-vercel-blob-access"], "private")
        self.assertEqual(captured["headers"]["x-allow-overwrite"], "0")
        self.assertNotIn("x-if-match", captured["headers"])
        self.assertEqual(captured["data"], b"hello")
        self.assertEqual(result["etag"], "etag-abc")

    def test_put_blob_sends_if_match_header_for_conditional_upload(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["headers"] = {k.lower(): v for k, v in req.headers.items()}
            return FakeHTTPResponse(json.dumps({"url": "u", "downloadUrl": "u", "pathname": "p", "contentType": "c", "contentDisposition": "", "etag": "new-etag"}).encode("utf-8"))

        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            tbs.put_blob("tenant-data/x/reviews.db", b"hello", if_match="old-etag")

        self.assertEqual(captured["headers"]["x-if-match"], "old-etag")
        self.assertEqual(captured["headers"]["x-allow-overwrite"], "1")

    def test_if_match_and_allow_overwrite_false_is_rejected_before_any_request(self):
        with mock.patch("urllib.request.urlopen") as mock_urlopen:
            with self.assertRaises(ValueError):
                tbs.put_blob("x", b"y", if_match="e", allow_overwrite=False)
            mock_urlopen.assert_not_called()

    def test_precondition_failed_maps_to_the_specific_exception(self):
        err, body = fake_http_error(412, {"error": {"code": "precondition_failed", "message": "ETag mismatch"}})
        err.fp = mock.Mock()
        err.read = lambda: body
        with mock.patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(tbs.BlobPreconditionFailedError):
                tbs.put_blob("tenant-data/x/reviews.db", b"data", if_match="stale")

    def test_other_http_errors_map_to_unavailable_not_precondition(self):
        err, body = fake_http_error(500, {"error": {"code": "internal_server_error", "message": "boom"}})
        err.read = lambda: body
        with mock.patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(tbs.BlobStoreUnavailableError):
                tbs.put_blob("tenant-data/x/reviews.db", b"data")

    def test_head_blob_returns_none_on_404_not_an_exception(self):
        err = urllib.error.HTTPError(url="u", code=404, msg="not found", hdrs=None, fp=None)
        with mock.patch("urllib.request.urlopen", side_effect=err):
            self.assertIsNone(tbs.head_blob("tenant-data/x/reviews.db"))

    def test_head_blob_sends_get_with_url_query_param(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            return FakeHTTPResponse(json.dumps({"etag": "e1", "pathname": "tenant-data/x/reviews.db", "size": 10}).encode("utf-8"))

        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            result = tbs.head_blob("tenant-data/x/reviews.db")

        self.assertEqual(captured["method"], "GET")
        self.assertIn("url=tenant-data", captured["url"])
        self.assertEqual(result["etag"], "e1")

    def test_get_blob_returns_none_on_404(self):
        err = urllib.error.HTTPError(url="u", code=404, msg="not found", hdrs=None, fp=None)
        with mock.patch("urllib.request.urlopen", side_effect=err):
            self.assertIsNone(tbs.get_blob("tenant-data/x/reviews.db"))

    def test_get_blob_uses_direct_object_host_with_bearer_auth_no_control_api(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["headers"] = {k.lower(): v for k, v in req.headers.items()}
            return FakeHTTPResponse(b"file-bytes")

        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            data = tbs.get_blob("tenant-data/x/reviews.db")

        self.assertEqual(data, b"file-bytes")
        self.assertIn("teststoreid123.private.blob.vercel-storage.com", captured["url"])
        self.assertEqual(captured["headers"]["authorization"], f"Bearer {FAKE_TOKEN}")


if __name__ == "__main__":
    unittest.main()
