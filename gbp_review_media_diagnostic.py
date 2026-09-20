"""
gbp_review_media_diagnostic.py -- DIAGNOSTIC INFRASTRUCTURE ONLY (Review
Media Feature, Scale & No-Backfill Audit). A strictly read-only, one-time
diagnostic that answers "what does reviewMediaItems actually look like on a
real Google review" WITHOUT implementing the review-media feature, without
touching the reviews schema, without activating media capture for any
tenant, and without ever downloading an image or video byte.

Read-only guarantees, mirroring gbp_reply_reconciliation_diagnostic.py's
established pattern exactly (reused, not reinvented):
  - Google side: calls ONLY google_api.get_review(tenant_id, gbp_review_name)
    -- a single GET, exactly once. Never calls list_reviews(), never calls
    any provider's fetch_reviews(), never calls provider_sync.sync_all(),
    never calls reply_to_review()/updateReply/deleteReply.
  - No Redis read/write of any kind -- this module imports nothing from
    tenant_config_store.py, credential-write paths, or any store module.
    google_api.py's own credential lookup (a READ, to obtain an access
    token) is the only Redis touch anywhere in this run, identical to every
    other read-only diagnostic in this repo.
  - No database read or write -- this module never imports db.py, never
    opens reviews.db.
  - No export generation, no AI draft, no sync of any kind.
  - Never makes an HTTP request to a thumbnailUrl or videoUrl -- those
    strings are only ever passed to urllib.parse.urlparse() (a pure string
    parse, no network I/O) to extract a hostname/scheme for sanitized
    reporting. No image/video byte is ever downloaded.
  - Output is sanitized by construction: the per-item report dicts below
    never carry a raw URL or raw label text as a value -- only booleans,
    hostnames, schemes, and integer lengths. Full URLs/labels/tokens are
    structurally absent from every returned dict, not merely un-printed.

--hypothetical-activation-time is a DIAGNOSTIC-ONLY comparison. It is never
written to tenant_config or anywhere else -- see check_eligibility()'s own
docstring. Running this script does not activate media capture for any
tenant, ever.

Usage:
    py gbp_review_media_diagnostic.py --tenant-id t_los-tres-amigos \\
        --gbp-review-name "accounts/.../locations/.../reviews/..." \\
        --hypothetical-activation-time 2026-09-20T18:00:00Z
"""
import argparse
import sys
from datetime import datetime, timezone
from urllib.parse import urlparse

import google_api as ga
import tenant_keys

MAX_URL_LENGTH = 2048
MAX_LABEL_LENGTH = 200


class InvalidHypotheticalTimestampError(ValueError):
    """Raised for a malformed --hypothetical-activation-time. Never treated
    as 'no restriction' -- a caller that can't parse the timestamp must fail
    closed, exactly like the real activation gate's own missing/invalid
    handling (see the Scale & No-Backfill audit's Audit 4, items 5-6)."""


def abbreviate_resource_name(gbp_review_name: str | None) -> str:
    """Same convention as gbp_reply_reconciliation_diagnostic.py's own
    abbreviate() -- last ~24 characters only, never the full account/
    location numeric path."""
    if not gbp_review_name:
        return "(none)"
    return "..." + gbp_review_name[-24:]


def _parse_iso_utc(value: str) -> datetime:
    """Strict ISO/RFC3339 parse. Google's createTime/updateTime and the
    --hypothetical-activation-time input both use a trailing 'Z' -- Python's
    datetime.fromisoformat() only accepts '+00:00', so 'Z' is normalized
    first. Raises ValueError on anything else (never silently coerced)."""
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    dt = datetime.fromisoformat(normalized)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _url_field_report(url) -> dict:
    """Sanitized report for a single URL-shaped field (thumbnailUrl or
    videoUrl). Returns ONLY booleans/strings-that-are-hostnames-or-schemes/
    integers -- the raw URL string itself is read locally by urlparse() and
    then discarded; it is never placed into the returned dict, so it cannot
    leak into any print statement or JSON serialization of this report by
    construction, not merely by caller discipline.

    'safe' requires: a string value, HTTPS scheme, a non-empty hostname, and
    a length within MAX_URL_LENGTH -- the same three checks the proposed
    real sanitizer (Scale & No-Backfill audit, Audit 7) would apply before
    ever storing a media URL."""
    if url is None:
        return {"present": False, "safe": True, "scheme": None, "hostname": None, "length": None}
    if not isinstance(url, str) or not url:
        return {"present": True, "safe": False, "scheme": None, "hostname": None, "length": None}
    parsed = urlparse(url)  # pure string parse -- no network I/O, ever
    length = len(url)
    safe = parsed.scheme == "https" and bool(parsed.netloc) and length <= MAX_URL_LENGTH
    return {
        "present": True,
        "safe": safe,
        "scheme": parsed.scheme or None,
        "hostname": parsed.netloc or None,
        "length": length,
    }


def classify_media_item(item, index: int) -> dict:
    """Sanitized, per-item report. Never returns a raw URL or raw label
    text -- only presence booleans, hostname/scheme strings, and integer
    lengths. A malformed item (not a dict, or a dict with neither
    thumbnailUrl nor videoUrl nor mediaFormat) is reported as such and
    always fails the sanitizer, never guessed into a shape it doesn't have."""
    if not isinstance(item, dict):
        return {
            "index": index, "malformed": True, "inferred_type": None,
            "thumbnail": _url_field_report(None), "label_present": False, "label_length": None,
            "video": _url_field_report(None), "sanitizer_pass": False,
        }

    thumbnail_url = item.get("thumbnailUrl")
    video_url = item.get("videoUrl")
    label = item.get("thumbnailLabel")
    media_format = item.get("mediaFormat")

    if not isinstance(thumbnail_url, str):
        thumbnail_url = thumbnail_url if thumbnail_url is None else None
    if not isinstance(video_url, str):
        video_url = video_url if video_url is None else None

    if isinstance(media_format, str) and media_format:
        inferred_type = "video" if media_format.upper() == "VIDEO" else "photo"
    elif video_url:
        inferred_type = "video"
    elif thumbnail_url:
        inferred_type = "photo"
    else:
        inferred_type = None

    thumbnail_report = _url_field_report(thumbnail_url)
    video_report = _url_field_report(video_url)
    label_present = isinstance(label, str) and bool(label)
    label_length = len(label) if label_present else None

    has_any_media_url = thumbnail_report["present"] or video_report["present"]
    malformed = not has_any_media_url and inferred_type is None
    sanitizer_pass = (
        has_any_media_url
        and thumbnail_report["safe"]
        and video_report["safe"]
        and not malformed
    )

    return {
        "index": index,
        "malformed": malformed,
        "inferred_type": inferred_type,
        "thumbnail": thumbnail_report,
        "label_present": label_present,
        "label_length": label_length,
        "video": video_report,
        "sanitizer_pass": sanitizer_pass,
    }


def check_eligibility(create_time: str | None, hypothetical_activation_time: str | None) -> dict:
    """DIAGNOSTIC-ONLY comparison -- never writes tenant_config, never
    activates media capture for any tenant. Uses the FULL create_time
    string Google returned (with time-of-day), never a date-only-truncated
    value -- the real activation gate's own inclusive `>=` rule (Scale &
    No-Backfill audit, Audit 4 item 8) is only correct when compared at
    full timestamp precision; comparing by date alone would treat two
    reviews created on the same calendar date as simultaneous even when one
    preceded and the other followed the exact activation instant.

    Returns a dict with 'comparable': False (never guessed as eligible or
    ineligible) whenever either input is missing or unparsable."""
    if not hypothetical_activation_time:
        return {
            "comparable": False, "reason": "no --hypothetical-activation-time supplied",
            "create_time": create_time, "hypothetical_activation_time": None, "qualifies": None,
        }
    if not create_time:
        return {
            "comparable": False, "reason": "review has no createTime",
            "create_time": None, "hypothetical_activation_time": hypothetical_activation_time, "qualifies": None,
        }
    try:
        create_dt = _parse_iso_utc(create_time)
    except ValueError as e:
        return {
            "comparable": False, "reason": f"review createTime is not a valid ISO timestamp: {e}",
            "create_time": create_time, "hypothetical_activation_time": hypothetical_activation_time, "qualifies": None,
        }
    try:
        activation_dt = _parse_iso_utc(hypothetical_activation_time)
    except ValueError as e:
        raise InvalidHypotheticalTimestampError(
            f"--hypothetical-activation-time {hypothetical_activation_time!r} is not a valid ISO/RFC3339 "
            f"timestamp: {e}"
        ) from e

    qualifies = create_dt >= activation_dt
    return {
        "comparable": True, "reason": None,
        "create_time": create_time, "hypothetical_activation_time": hypothetical_activation_time,
        "qualifies": qualifies,
    }


def _safe_error(e: Exception) -> str:
    """Same convention as initial_sync.py's _safe_error(): class name +
    message only, truncated. google_api.py's own typed exceptions never
    embed a credential/token in their message (see that file's header)."""
    return f"{type(e).__name__}: {e}"[:500]


def build_report(tenant_id: str, gbp_review_name: str, hypothetical_activation_time: str | None = None) -> dict:
    """Runs the ONE authorized call (google_api.get_review) and assembles
    the complete sanitized report. Never calls list_reviews, fetch_reviews,
    sync_all, reply_to_review, or any write-capable function. Never touches
    reviews.db or tenant_config."""
    try:
        api_review = ga.get_review(tenant_id, gbp_review_name)  # the ONE authorized call
    except Exception as e:
        return {
            "review_found": False,
            "error": _safe_error(e),
            "requested_resource_tail": abbreviate_resource_name(gbp_review_name),
        }

    returned_name = api_review.get("name")
    identity_match = returned_name == gbp_review_name

    raw_items = api_review.get("reviewMediaItems")
    media_items_present = isinstance(raw_items, list) and len(raw_items) > 0
    items = [classify_media_item(item, i) for i, item in enumerate(raw_items or [])]

    create_time = api_review.get("createTime")
    eligibility = check_eligibility(create_time, hypothetical_activation_time)

    return {
        "review_found": True,
        "requested_resource_tail": abbreviate_resource_name(gbp_review_name),
        "returned_resource_tail": abbreviate_resource_name(returned_name),
        "identity_match": identity_match,
        "create_time": create_time,
        "update_time": api_review.get("updateTime"),
        "media_items_present": media_items_present,
        "media_item_count": len(items),
        "items": items,
        "all_items_pass_sanitizer": all(i["sanitizer_pass"] for i in items) if items else True,
        "eligibility": eligibility,
    }


def _print_report(report: dict) -> None:
    print("=== gbp_review_media_diagnostic.py -- READ-ONLY, single GET, zero writes ===")
    print(f"Requested review (tail): {report.get('requested_resource_tail')}")

    if not report.get("review_found"):
        print(f"Review returned: False")
        print(f"Error: {report.get('error')}")
        print("\n=== END -- nothing was written, downloaded, synced, or activated ===")
        return

    print(f"Review returned: True")
    print(f"Returned review (tail): {report['returned_resource_tail']}")
    print(f"Identity match (requested == returned resource name): {report['identity_match']}")
    print(f"createTime: {report['create_time']}")
    print(f"updateTime: {report['update_time']}")
    print(f"reviewMediaItems present: {report['media_items_present']}")
    print(f"Media item count: {report['media_item_count']}")
    print()

    for item in report["items"]:
        t = item["thumbnail"]
        v = item["video"]
        print(
            f"  item[{item['index']}] malformed={item['malformed']} type={item['inferred_type']} "
            f"thumbnailUrl_present={t['present']} thumbnail_hostname={t['hostname']} "
            f"thumbnail_scheme={t['scheme']} thumbnail_url_length={t['length']} "
            f"thumbnailLabel_present={item['label_present']} thumbnailLabel_length={item['label_length']} "
            f"videoUrl_present={v['present']} video_hostname={v['hostname']} "
            f"video_scheme={v['scheme']} video_url_length={v['length']} "
            f"sanitizer_pass={item['sanitizer_pass']}"
        )
    print()
    print(f"All items pass proposed sanitizer: {report['all_items_pass_sanitizer']}")
    print()

    elig = report["eligibility"]
    print("--- Eligibility comparison (DIAGNOSTIC ONLY -- writes nothing, activates nothing) ---")
    print(f"Review createTime (full, not date-truncated): {elig['create_time']}")
    print(f"Hypothetical activation time (comparison only): {elig['hypothetical_activation_time']}")
    if elig["comparable"]:
        print(f"createTime >= hypothetical activation time: {elig['qualifies']}")
    else:
        print(f"Not comparable: {elig['reason']}")
    print(
        "NOTE: this comparison does not activate media capture for any tenant and never writes "
        "tenant_config. It exists solely to show what the real activation gate WOULD decide."
    )
    print("\n=== END -- nothing was written, downloaded, synced, or activated ===")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant whose credential to use. REQUIRED -- no default.")
    parser.add_argument("--gbp-review-name", required=True,
                         help="Exact Google review resource name (accounts/*/locations/*/reviews/*). "
                              "REQUIRED -- no default review is ever assumed.")
    parser.add_argument("--hypothetical-activation-time", required=False, default=None,
                         help="ISO/RFC3339 UTC timestamp used ONLY for a diagnostic eligibility "
                              "comparison. Never written anywhere; does not activate media capture.")
    args = parser.parse_args()

    # An empty string (e.g. an unset workflow_dispatch input, which GitHub
    # Actions passes through as '' rather than omitting the flag) is treated
    # identically to the flag never being supplied at all -- never parsed as
    # a timestamp, never treated as "any time qualifies."
    if args.hypothetical_activation_time == "":
        args.hypothetical_activation_time = None

    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::gbp_review_media_diagnostic.py: invalid --tenant-id {args.tenant_id!r}")
        return 1
    if not args.gbp_review_name or "/reviews/" not in args.gbp_review_name:
        print(f"::error::gbp_review_media_diagnostic.py: invalid --gbp-review-name {args.gbp_review_name!r}")
        return 1

    if args.hypothetical_activation_time is not None:
        try:
            _parse_iso_utc(args.hypothetical_activation_time)
        except ValueError as e:
            print(f"::error::gbp_review_media_diagnostic.py: invalid --hypothetical-activation-time "
                  f"{args.hypothetical_activation_time!r}: {e}")
            return 1

    if not ga.is_configured():
        print("::error::GBP credentials are not configured in this environment. Aborting -- no "
              "local-only fallback is used for this diagnostic.")
        return 1

    report = build_report(args.tenant_id, args.gbp_review_name, args.hypothetical_activation_time)
    _print_report(report)
    return 0 if report.get("review_found") else 1


if __name__ == "__main__":
    raise SystemExit(main())
