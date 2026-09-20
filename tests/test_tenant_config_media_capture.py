"""
Isolated tests for tenant_config_store.py's mediaCapture support -- Review
Media Feature (Scale & No-Backfill Audit, Phase 2/10). Covers
resolve_media_capture_started_at() (the read sync orchestration uses) and
activate_media_capture() (the write helper NEVER called anywhere in this
implementation -- see test_review_media_feature.py's own
test_31_activation_helper_never_called_by_deploy_onboarding_or_sync for the
source-scan proof of that).

No live Redis is used -- urllib.request.urlopen is monkeypatched with an
in-memory fake hash store, mirroring test_tenant_config_cross_language_consistency.py's
own pattern.

Run directly: py tests/test_tenant_config_media_capture.py
"""
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import tenant_config_store as tcs

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


class _FakeRedisHash:
    """An in-memory stand-in for the ONE tenant_config:v1 Redis hash --
    enough to exercise get/HSET/the CAS EVAL script exactly like real
    Upstash would, without any network access."""
    def __init__(self):
        self.store: dict[str, str] = {}

    def urlopen(self, req, timeout=None):
        body = json.loads(req.data) if req.data else None
        resp = MagicMock()
        resp.__enter__.return_value = resp
        resp.__exit__.return_value = False
        if req.data is None:
            # GET-style path command: .../hget/{key}/{field}
            field = req.full_url.rsplit("/", 1)[-1]
            import urllib.parse
            field = urllib.parse.unquote(field)
            resp.read.return_value = json.dumps({"result": self.store.get(field)}).encode()
            return resp
        if body[0] == "HSET":
            _cmd, _key, field, value = body
            self.store[field] = value
            resp.read.return_value = json.dumps({"result": "OK"}).encode()
            return resp
        if body[0] == "EVAL":
            _cmd, _script, _numkeys, _key, field, expected_version, new_value = body
            current_raw = self.store.get(field)
            current_version = 0
            if current_raw:
                current_version = json.loads(current_raw).get("configVersion", 0)
            if str(current_version) != str(expected_version):
                resp.read.return_value = json.dumps({"result": current_raw or False}).encode()
                return resp
            self.store[field] = new_value
            resp.read.return_value = json.dumps({"result": True}).encode()
            return resp
        raise AssertionError(f"unexpected fake Redis command: {body}")


def _with_fake_redis(fn):
    env_backup = dict(os.environ)
    os.environ["UPSTASH_REDIS_REST_URL"] = "https://fake-upstash.example.com"
    os.environ["UPSTASH_REDIS_REST_TOKEN"] = "fake-token"
    fake = _FakeRedisHash()
    try:
        with patch("urllib.request.urlopen", side_effect=fake.urlopen):
            fn(fake)
    finally:
        os.environ.clear()
        os.environ.update(env_backup)


TENANT = "t_synthetic-media-capture-tenant"


def test_resolve_returns_none_for_unknown_tenant():
    def body(fake):
        assert tcs.resolve_media_capture_started_at(TENANT) is None
    _with_fake_redis(body)


def test_resolve_returns_none_when_inactive():
    def body(fake):
        tcs.upsert_tenant_config(TENANT, {})  # default record -- mediaCapture inactive
        assert tcs.resolve_media_capture_started_at(TENANT) is None
    _with_fake_redis(body)


def test_resolve_returns_none_when_malformed_started_at():
    def body(fake):
        tcs.upsert_tenant_config(TENANT, {"mediaCapture": {"status": "active", "startedAt": "not-a-timestamp"}})
        assert tcs.resolve_media_capture_started_at(TENANT) is None
    _with_fake_redis(body)


def test_resolve_returns_the_valid_started_at_when_active():
    def body(fake):
        tcs.upsert_tenant_config(TENANT, {"mediaCapture": {"status": "active", "startedAt": "2026-09-01T00:00:00Z"}})
        assert tcs.resolve_media_capture_started_at(TENANT) == "2026-09-01T00:00:00Z"
    _with_fake_redis(body)


def test_invalid_media_capture_status_rejected_on_write():
    def body(fake):
        try:
            tcs.upsert_tenant_config(TENANT, {"mediaCapture": {"status": "somehow-active", "startedAt": None}})
            raised = False
        except ValueError:
            raised = True
        assert raised
    _with_fake_redis(body)


def test_activate_raises_for_unknown_tenant():
    def body(fake):
        try:
            tcs.activate_media_capture(TENANT, expected_version=0)
            raised = False
        except ValueError:
            raised = True
        assert raised
    _with_fake_redis(body)


def test_activate_writes_server_computed_timestamp():
    def body(fake):
        record = tcs.upsert_tenant_config(TENANT, {})
        activated = tcs.activate_media_capture(TENANT, expected_version=record["configVersion"])
        assert activated["mediaCapture"]["status"] == "active"
        assert activated["mediaCapture"]["startedAt"] is not None
        # No timestamp parameter exists on activate_media_capture() at all --
        # the value can only have come from the server's own clock.
        assert "T" in activated["mediaCapture"]["startedAt"]
    _with_fake_redis(body)


def test_activate_is_idempotent_never_moves_started_at():
    def body(fake):
        record = tcs.upsert_tenant_config(TENANT, {})
        first = tcs.activate_media_capture(TENANT, expected_version=record["configVersion"])
        first_started_at = first["mediaCapture"]["startedAt"]

        second = tcs.activate_media_capture(TENANT, expected_version=first["configVersion"])
        assert second["mediaCapture"]["startedAt"] == first_started_at, (
            "calling activate_media_capture() again must never move an already-set startedAt"
        )
    _with_fake_redis(body)


def test_activate_cannot_be_backdated_no_timestamp_parameter_exists():
    import inspect
    sig = inspect.signature(tcs.activate_media_capture)
    assert "timestamp" not in sig.parameters
    assert "started_at" not in sig.parameters
    assert set(sig.parameters) == {"tenant_id", "expected_version"}


def test_activate_never_called_anywhere_in_this_implementation():
    # Redundant with test_review_media_feature.py's own source-scan test,
    # kept here too since this file is this feature's isolated coverage
    # for the activation helper specifically.
    repo_root = Path(__file__).resolve().parent.parent
    for filename in ["gbp_sync.py", "sync_reviews.py", "initial_sync.py", "provider_sync.py", "provision_tenant.py"]:
        path = repo_root / filename
        if path.exists():
            assert "activate_media_capture" not in path.read_text(encoding="utf-8")


def test_default_record_ships_inactive():
    def body(fake):
        record = tcs.upsert_tenant_config(TENANT, {})
        assert record["mediaCapture"] == {"status": "inactive", "startedAt": None}
    _with_fake_redis(body)


def main() -> int:
    tests = [
        ("resolve returns None for an unknown tenant", test_resolve_returns_none_for_unknown_tenant),
        ("resolve returns None when inactive", test_resolve_returns_none_when_inactive),
        ("resolve returns None when startedAt is malformed", test_resolve_returns_none_when_malformed_started_at),
        ("resolve returns the valid startedAt when active", test_resolve_returns_the_valid_started_at_when_active),
        ("an invalid mediaCapture.status is rejected on write", test_invalid_media_capture_status_rejected_on_write),
        ("activate_media_capture raises for an unknown tenant", test_activate_raises_for_unknown_tenant),
        ("activate_media_capture writes a server-computed timestamp", test_activate_writes_server_computed_timestamp),
        ("activate_media_capture is idempotent -- never moves startedAt", test_activate_is_idempotent_never_moves_started_at),
        ("activate_media_capture cannot be backdated -- no timestamp parameter exists", test_activate_cannot_be_backdated_no_timestamp_parameter_exists),
        ("activate_media_capture is never called anywhere in this implementation", test_activate_never_called_anywhere_in_this_implementation),
        ("the default tenant_config record ships with mediaCapture inactive", test_default_record_ships_inactive),
    ]
    for name, fn in tests:
        run(name, fn)
    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
