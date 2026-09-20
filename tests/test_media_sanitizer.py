"""
Regression tests for media_sanitizer.py -- Review Media Feature (Scale &
No-Backfill Audit, Phase 3/10). Every test is pure, in-memory, and makes no
network call of any kind -- media_sanitizer.py itself never imports
urllib.request/requests at all.

Run directly: py tests/test_media_sanitizer.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import media_sanitizer as ms

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def test_none_input_returns_empty_list():
    assert ms.sanitize_review_media_items(None) == []


def test_non_list_input_returns_empty_list():
    assert ms.sanitize_review_media_items({"not": "a list"}) == []
    assert ms.sanitize_review_media_items("a string") == []


def test_one_photo():
    out = ms.sanitize_review_media_items([{"thumbnailUrl": "https://lh3.googleusercontent.com/p1", "thumbnailLabel": "Tacos"}])
    assert len(out) == 1
    assert out[0]["type"] == "photo"
    assert out[0]["thumbnailUrl"] == "https://lh3.googleusercontent.com/p1"
    assert out[0]["thumbnailLabel"] == "Tacos"
    assert out[0]["videoUrl"] is None
    assert out[0]["sortOrder"] == 0
    assert set(out[0].keys()) == {"type", "thumbnailUrl", "thumbnailLabel", "videoUrl", "sortOrder"}


def test_five_photos():
    items = [{"thumbnailUrl": f"https://lh3.googleusercontent.com/p{i}"} for i in range(5)]
    out = ms.sanitize_review_media_items(items)
    assert len(out) == 5
    assert [o["sortOrder"] for o in out] == [0, 1, 2, 3, 4]
    assert all(o["type"] == "photo" for o in out)


def test_video_item():
    out = ms.sanitize_review_media_items([{
        "thumbnailUrl": "https://lh3.googleusercontent.com/vthumb", "videoUrl": "https://lh3.googleusercontent.com/v1",
    }])
    assert len(out) == 1
    assert out[0]["type"] == "video"
    assert out[0]["videoUrl"] == "https://lh3.googleusercontent.com/v1"


def test_mixed_media():
    out = ms.sanitize_review_media_items([
        {"thumbnailUrl": "https://lh3.googleusercontent.com/p1"},
        {"thumbnailUrl": "https://lh3.googleusercontent.com/vthumb", "videoUrl": "https://lh3.googleusercontent.com/v1"},
    ])
    assert [o["type"] for o in out] == ["photo", "video"]


def test_duplicate_items_removed_deterministically():
    out = ms.sanitize_review_media_items([
        {"thumbnailUrl": "https://lh3.googleusercontent.com/dup"},
        {"thumbnailUrl": "https://lh3.googleusercontent.com/dup"},
        {"thumbnailUrl": "https://lh3.googleusercontent.com/unique"},
    ])
    assert len(out) == 2
    assert out[0]["thumbnailUrl"] == "https://lh3.googleusercontent.com/dup"
    assert out[0]["sortOrder"] == 0
    assert out[1]["thumbnailUrl"] == "https://lh3.googleusercontent.com/unique"
    assert out[1]["sortOrder"] == 1


def test_more_than_20_items_capped():
    items = [{"thumbnailUrl": f"https://lh3.googleusercontent.com/p{i}"} for i in range(30)]
    out = ms.sanitize_review_media_items(items)
    assert len(out) == 20
    assert out[-1]["thumbnailUrl"] == "https://lh3.googleusercontent.com/p19"


def test_url_over_max_length_rejected():
    huge = "https://lh3.googleusercontent.com/" + ("a" * 3000)
    assert len(huge) > ms.MAX_URL_LENGTH
    out = ms.sanitize_review_media_items([{"thumbnailUrl": huge}])
    assert out == []


def test_javascript_scheme_rejected():
    out = ms.sanitize_review_media_items([{"thumbnailUrl": "javascript:alert(1)"}])
    assert out == []


def test_data_scheme_rejected():
    out = ms.sanitize_review_media_items([{"thumbnailUrl": "data:image/png;base64,AAAA"}])
    assert out == []


def test_file_scheme_rejected():
    out = ms.sanitize_review_media_items([{"thumbnailUrl": "file:///etc/passwd"}])
    assert out == []


def test_http_scheme_rejected():
    out = ms.sanitize_review_media_items([{"thumbnailUrl": "http://lh3.googleusercontent.com/insecure"}])
    assert out == []


def test_malformed_url_rejected():
    out = ms.sanitize_review_media_items([{"thumbnailUrl": "not a url at all"}])
    assert out == []


def test_credential_bearing_url_rejected():
    out = ms.sanitize_review_media_items([{"thumbnailUrl": "https://user:password@lh3.googleusercontent.com/p1"}])
    assert out == []


def test_label_over_max_length_truncated_not_rejected():
    long_label = "x" * 500
    out = ms.sanitize_review_media_items([{"thumbnailUrl": "https://lh3.googleusercontent.com/p1", "thumbnailLabel": long_label}])
    assert len(out) == 1
    assert len(out[0]["thumbnailLabel"]) == ms.MAX_LABEL_LENGTH


def test_serialized_result_bounded_to_8kb():
    # Every item individually well within caps, but enough of them that the
    # TOTAL serialized array would exceed 8KB -- must be trimmed from the
    # end, never individually truncated.
    items = [{"thumbnailUrl": f"https://lh3.googleusercontent.com/{'p' * 400}{i}"} for i in range(20)]
    out = ms.sanitize_review_media_items(items)
    serialized = json.dumps(out, separators=(",", ":")).encode("utf-8")
    assert len(serialized) <= ms.MAX_SERIALIZED_BYTES
    assert len(out) < 20  # some trailing items were dropped to fit
    # remaining items are still a clean, dense, deterministic prefix
    assert [o["sortOrder"] for o in out] == list(range(len(out)))


def test_item_without_usable_thumbnail_dropped():
    out = ms.sanitize_review_media_items([{"videoUrl": "https://lh3.googleusercontent.com/v1"}])
    assert out == []  # no thumbnailUrl at all -- dropped even though a valid videoUrl exists


def test_video_type_only_with_valid_https_video_url():
    # videoUrl present but unsafe (http) -- must NOT be classified as video,
    # and the unsafe videoUrl must not leak into the output either.
    out = ms.sanitize_review_media_items([{
        "thumbnailUrl": "https://lh3.googleusercontent.com/thumb", "videoUrl": "http://lh3.googleusercontent.com/v1",
    }])
    assert len(out) == 1
    assert out[0]["type"] == "photo"
    assert out[0]["videoUrl"] is None


def test_unknown_fields_ignored():
    out = ms.sanitize_review_media_items([{
        "thumbnailUrl": "https://lh3.googleusercontent.com/p1",
        "mediaFormat": "PHOTO", "someFutureGoogleField": {"nested": True}, "name": "media-resource-123",
    }])
    assert set(out[0].keys()) == {"type", "thumbnailUrl", "thumbnailLabel", "videoUrl", "sortOrder"}


def test_unknown_media_shape_fails_safely():
    out = ms.sanitize_review_media_items(["not-a-dict", 42, None, {}])
    assert out == []


def test_never_downloads_or_probes_a_url():
    import urllib.request

    def poison(*a, **k):
        raise AssertionError("media_sanitizer.py must never make an HTTP request")

    original = urllib.request.urlopen
    urllib.request.urlopen = poison
    try:
        ms.sanitize_review_media_items([
            {"thumbnailUrl": "https://lh3.googleusercontent.com/p1", "videoUrl": "https://lh3.googleusercontent.com/v1"},
        ])
    finally:
        urllib.request.urlopen = original


def test_never_generates_base64():
    out = ms.sanitize_review_media_items([{"thumbnailUrl": "https://lh3.googleusercontent.com/p1", "thumbnailLabel": "Tacos"}])
    serialized = json.dumps(out)
    assert "base64" not in serialized.lower()
    assert "data:" not in serialized.lower()


def test_deterministic_order_preserved():
    items = [{"thumbnailUrl": f"https://lh3.googleusercontent.com/{c}"} for c in "cab"]
    out = ms.sanitize_review_media_items(items)
    assert [o["thumbnailUrl"] for o in out] == [
        "https://lh3.googleusercontent.com/c", "https://lh3.googleusercontent.com/a", "https://lh3.googleusercontent.com/b",
    ]


def main() -> int:
    tests = [
        ("None input returns []", test_none_input_returns_empty_list),
        ("non-list input returns []", test_non_list_input_returns_empty_list),
        ("one photo", test_one_photo),
        ("five photos", test_five_photos),
        ("video item", test_video_item),
        ("mixed media", test_mixed_media),
        ("duplicate items removed deterministically", test_duplicate_items_removed_deterministically),
        ("more than 20 items capped at 20", test_more_than_20_items_capped),
        ("URL over 2048 chars rejected, not truncated", test_url_over_max_length_rejected),
        ("javascript: scheme rejected", test_javascript_scheme_rejected),
        ("data: scheme rejected", test_data_scheme_rejected),
        ("file: scheme rejected", test_file_scheme_rejected),
        ("http: scheme rejected", test_http_scheme_rejected),
        ("malformed URL rejected", test_malformed_url_rejected),
        ("credential-bearing URL rejected", test_credential_bearing_url_rejected),
        ("label over 200 chars truncated, not rejected", test_label_over_max_length_truncated_not_rejected),
        ("serialized result bounded to 8KB", test_serialized_result_bounded_to_8kb),
        ("item without usable thumbnail dropped", test_item_without_usable_thumbnail_dropped),
        ("video type only with a valid https videoUrl", test_video_type_only_with_valid_https_video_url),
        ("unknown fields ignored", test_unknown_fields_ignored),
        ("unknown media shapes fail safely", test_unknown_media_shape_fails_safely),
        ("never downloads or probes a URL", test_never_downloads_or_probes_a_url),
        ("never generates base64", test_never_generates_base64),
        ("deterministic order preserved", test_deterministic_order_preserved),
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
