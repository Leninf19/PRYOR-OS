"""
Google Reply Moderation State -- Python mirror of dashboard/api/_lib/
replyModerationState.js. See that module's own header for the full
root-cause story and design rationale.

Resolution note (manually verified against the public listing after the
read-only Terry diagnostic): Casa Tequila Brighton / reviewer "Terry",
local review id 35738 did NOT fail and was never rejected -- PRYOR's PUT
succeeded, Google stored the exact comment, and it later became publicly
visible. The delay was ordinary Google moderation/propagation lag, not a
rejection. This is exactly why PRYOR must never claim "Confirmed" (or
"Approved"/"publicly visible") from an accepted request or a later comment
match alone -- REPLY_RECORDED below exists specifically to describe that
honest, in-between state without asserting a public-visibility guarantee
this app has no mechanism to verify.

Kept in sync by comment reference, not imported -- Python and JS cannot
share a module here. Same cross-language duplication convention this
codebase already uses for reviewRiskClassifier.js/ai_engine.py's risk
categories.

Design principle carried through every function below: an unknown, missing,
or future/unrecognized value is NEVER interpreted as approval or rejection --
it always falls back to the weakest, most honest state available. Never
raises; a malformed or unexpected Google payload never crashes a caller.
"""
import re

# The complete state model (mirrors ModerationState in the JS module).
SENT_TO_GOOGLE = "sent_to_google"
# A later Google API read (a reconciliation GET, or an ordinary full sync)
# independently confirmed the matching reply comment, but Google gave no
# explicit reviewReplyState -- merges what earlier drafts of this fix
# called VERIFICATION_DELAYED (bridge-tracked, comment confirmed, state
# unresolved) and EXTERNALLY_REPLIED (owner_response populated with no
# other provenance signal): both describe the exact same epistemic
# position ("Google has this reply on record; no stronger claim can be
# made"), and this app has no reliable way to tell them apart once a
# publish-bridge record has expired, so presenting them as one honest label
# is more accurate than pretending to distinguish them.
REPLY_RECORDED = "reply_recorded"
PENDING_APPROVAL = "pending_google_approval"
APPROVED = "approved_by_google"
REJECTED = "rejected_by_google"

KNOWN_MODERATION_STATES = {
    SENT_TO_GOOGLE, REPLY_RECORDED, PENDING_APPROVAL, APPROVED, REJECTED,
}

# Google's own documented reviewReplyState enum. Anything else (a future
# value, a typo, None, non-string) normalizes to None -- "unresolved",
# never guessed.
_KNOWN_REVIEW_REPLY_STATES = {"PENDING", "APPROVED", "REJECTED"}


def normalize_review_reply_state(raw):
    if not isinstance(raw, str):
        return None
    if raw == "REVIEW_REPLY_STATE_UNSPECIFIED":
        return None
    return raw if raw in _KNOWN_REVIEW_REPLY_STATES else None


# Same tolerant, shape-agnostic parsing as the JS module -- Google's exact
# PolicyViolation field name is not fully documented publicly as of this
# fix, so this accepts a bare string enum, a list of string enums, or an
# object carrying the codes under one of a few plausible field names,
# without ever crashing or fabricating a reason it wasn't given.
_POLICY_REASON_SUMMARIES = {
    "FAKE_ENGAGEMENT": "flagged as fake engagement",
    "ADVERTISING_AND_SOLICITATION": "flagged as advertising or solicitation",
    "MISINFORMATION": "flagged as misinformation",
    "HARASSMENT": "flagged for harassment",
    "OFF_TOPIC": "flagged as off-topic",
    "SPAM": "flagged as spam",
    "CONFLICT_OF_INTEREST": "flagged for a conflict of interest",
    "ILLEGAL": "flagged as illegal content",
    "EXPLICIT": "flagged as explicit content",
}


def normalize_policy_violation(raw):
    if raw is None:
        return None
    codes = []
    if isinstance(raw, str):
        codes = [raw]
    elif isinstance(raw, list):
        codes = [c for c in raw if isinstance(c, str)]
    elif isinstance(raw, dict):
        candidate = (
            raw.get("policyViolationReasons") or raw.get("reasons")
            or raw.get("reasonCodes") or raw.get("reason") or raw.get("policyViolationReason")
        )
        if isinstance(candidate, str):
            codes = [candidate]
        elif isinstance(candidate, list):
            codes = [c for c in candidate if isinstance(c, str)]
    codes = [c for c in codes if c]
    if not codes:
        return {"reasonCodes": [], "summary": "Rejected by Google for a policy reason it did not specify."}
    label = _POLICY_REASON_SUMMARIES.get(codes[0])
    summary = f"Rejected by Google -- {label}." if label else "Rejected by Google for an unrecognized policy reason."
    return {"reasonCodes": codes, "summary": summary}


def normalize_reply_text_for_comparison(text):
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def reply_text_matches(a, b):
    if not isinstance(a, str) or not isinstance(b, str):
        return None
    return normalize_reply_text_for_comparison(a) == normalize_reply_text_for_comparison(b)


def classify_moderation_outcome(review_reply_state):
    """Mirrors classifyModerationOutcome() -- returns None when unresolved;
    callers decide the correct fallback for their own context."""
    normalized = normalize_review_reply_state(review_reply_state)
    if normalized == "APPROVED":
        return APPROVED
    if normalized == "REJECTED":
        return REJECTED
    if normalized == "PENDING":
        return PENDING_APPROVAL
    return None


def resolve_bridge_moderation_state(record):
    """Mirrors resolveBridgeModerationState() -- a legacy record (no
    moderationState field) or one with an unrecognized value ALWAYS
    resolves to SENT_TO_GOOGLE, never an assumed approval."""
    if not record or not isinstance(record, dict):
        return None
    state = record.get("moderationState")
    if isinstance(state, str) and state in KNOWN_MODERATION_STATES:
        return state
    return SENT_TO_GOOGLE
