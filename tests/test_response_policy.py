"""
Regression tests for ai_engine.py's response classification and the Phase 3
hard safety guard (Recovery Milestone 4: Review Reply Inbox + AI Response
Quality).

Reproduces the production bug found 2026-08-22: a 5-star Casa Tequila Prime
review with only minor, explicitly-non-complaint feedback ("these are small
adjustments... it does not take away from the food quality... we will
return") got a response inviting the guest to "contact us at
advertising@l3amigos.com so we can make this right" -- inappropriate
service-recovery language for an overwhelmingly positive review.

Root cause: _SERIOUS_KEYWORDS was matched as a naive substring
(`kw in lower`), which fires on innocent words containing a keyword --
'sue' matches inside "no ISSUEs at all", 'ill' matches inside "tacos were
griILLed". Fixed to \b-word-boundary matching. This file tests that fix
plus the deterministic policy guard that exists as a backstop independent
of the classifier or the LLM's own output.

Run directly: py tests/test_response_policy.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import ai_engine

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


# The actual regression case (paraphrased faithfully from the real review):
# 5 stars, overwhelmingly positive, two pieces of minor constructive
# feedback, explicit reassurance that it doesn't affect the food quality,
# explicit intent to return.
CASA_TEQUILA_PRIME_REVIEW = {
    "star_rating": 5,
    "reviewer_name": "Alex",
    "review_text": (
        "We had a great experience! Loved the vibe and decor, and the drinks were "
        "awesome. Food quality was excellent -- the Ribeye Tacos, Carne Asada Tacos, "
        "and Tequila Lime Chicken were all fantastic. Two small notes: the spice level "
        "wasn't obvious on the menu description, and the pickled onions weren't listed "
        "on the Ribeye Taco description. These are small adjustments and it does not "
        "take away from the food quality at all -- service, food, and vibes were good. "
        "We will definitely be back!"
    ),
}


def test_casa_tequila_prime_classifies_positive_with_feedback():
    result = ai_engine.classify_response_type(CASA_TEQUILA_PRIME_REVIEW)
    assert result == "positive_with_feedback", f"expected positive_with_feedback, got {result}"


def test_casa_tequila_prime_never_serious_escalation():
    result = ai_engine.classify_response_type(CASA_TEQUILA_PRIME_REVIEW)
    assert result != "serious_escalation", "an overwhelmingly positive review must never classify as serious"


# --- Root cause: substring vs. word-boundary matching -------------------------

def test_no_issues_does_not_trigger_sue_keyword():
    """The exact substring-match bug: 'sue' inside "no ISSUEs"."""
    text = "Everything was great, no issues at all, we'll be back!"
    assert not ai_engine._is_serious_escalation(text, 5), \
        "'issues' must never match the 'sue' keyword via substring"


def test_grilled_does_not_trigger_ill_keyword():
    """The exact substring-match bug: 'ill' inside "griILLed"."""
    text = "The steak was grilled to perfection, best meal we've had in a while."
    assert not ai_engine._is_serious_escalation(text, 5), \
        "'grilled' must never match the 'ill' keyword via substring"


def test_whole_word_serious_keyword_still_matches():
    """Word-boundary matching must not lose real detections."""
    text = "I got violently ill after eating here, had to go to the hospital."
    assert ai_engine._is_serious_escalation(text, 1), \
        "a genuine whole-word 'ill'/'hospital' mention must still be detected"


# --- Classification matrix (Phase 15) ------------------------------------------

def test_5star_positive_no_escalation():
    review = {"star_rating": 5, "review_text": "Amazing food and service, we loved it, will be back soon!"}
    assert ai_engine.classify_response_type(review) == "positive"


def test_4star_positive_small_complaint_not_recovery():
    review = {"star_rating": 4, "review_text": "Great meal overall, only complaint is the wait was a bit long, but worth it."}
    result = ai_engine.classify_response_type(review)
    assert result in ("positive_with_feedback", "positive"), result
    assert result != "serious_escalation"


def test_3star_mixed_is_balanced():
    review = {"star_rating": 3, "review_text": "Food was good but service was slow and the place felt a little dirty."}
    assert ai_engine.classify_response_type(review) == "mixed"


def test_1to2star_meaningful_complaint_classifies_negative():
    review = {"star_rating": 2, "review_text": "Order was wrong twice and the manager was dismissive about it."}
    assert ai_engine.classify_response_type(review) == "negative"


def test_5star_serious_unresolved_incident_classifies_serious_escalation():
    review = {"star_rating": 5, "review_text": "Loved the food but sadly I got food poisoning and ended up in the hospital that night."}
    assert ai_engine.classify_response_type(review) == "serious_escalation"


def test_1star_without_serious_keywords_is_plain_negative_not_escalation():
    """A low rating alone (no serious content) must not force escalation --
    matches Phase 2's explicit requirement that classification consider
    severity, not just star rating."""
    review = {"star_rating": 1, "review_text": "Service was slow and my order was wrong."}
    assert ai_engine.classify_response_type(review) == "negative"


def test_ai_sentiment_and_priority_signals_used_when_present():
    """A high-star review the existing classifier already flagged as
    negative/high-priority must not be treated as a plain positive --
    reuses classify_reviews_batch's existing output rather than a new
    scoring framework."""
    review = {"star_rating": 4, "review_text": "It was fine.", "ai_sentiment": "negative", "ai_priority": "high"}
    assert ai_engine.classify_response_type(review) == "mixed"


# --- Phase 3 hard safety guard --------------------------------------------------

def test_guard_strips_forbidden_cta_from_non_serious_response():
    draft = ("Thank you so much for the kind words! Please contact us at "
             "advertising@l3amigos.com so we can make this right. We hope to see you again soon.")
    cleaned = ai_engine.enforce_response_policy(draft, "positive_with_feedback")
    assert "advertising@l3amigos.com" not in cleaned
    assert "make this right" not in cleaned.lower()
    assert "contact us" not in cleaned.lower()
    assert "Thank you" in cleaned and "hope to see you again" in cleaned, \
        "the guard must only remove the offending sentence, not the whole response"


def test_guard_strips_bare_email_even_without_known_phrase():
    draft = "Thanks for visiting! Reach us anytime at manager@example.com. See you soon!"
    cleaned = ai_engine.enforce_response_policy(draft, "positive")
    assert "manager@example.com" not in cleaned


def test_guard_strips_phone_number():
    draft = "We appreciate the feedback. Call us at (555) 123-4567 if you'd like to chat. Thanks again!"
    cleaned = ai_engine.enforce_response_policy(draft, "negative")
    assert "555" not in cleaned and "123-4567" not in cleaned


def test_guard_leaves_serious_escalation_untouched():
    draft = "We are very sorry to hear this. Please contact us at advertising@l3amigos.com so we can make this right."
    cleaned = ai_engine.enforce_response_policy(draft, "serious_escalation")
    assert cleaned == draft, "serious_escalation is the one class allowed to keep the contact CTA"


def test_guard_never_returns_empty_string():
    draft = "Please contact us at advertising@l3amigos.com so we can make this right."
    cleaned = ai_engine.enforce_response_policy(draft, "positive")
    assert cleaned, "the guard must never leave the manager with an empty draft"


def test_generated_draft_for_casa_tequila_prime_never_contains_forbidden_cta():
    """End-to-end: even if generate_response_draft's own prompt-level
    guidance failed and the model returned forbidden language anyway, the
    deterministic guard applied inside generate_response_draft must still
    catch it. Simulated by calling enforce_response_policy the same way
    generate_response_draft does, against a worst-case model output."""
    worst_case_model_output = (
        "Thanks so much for the detailed feedback! Please contact us at "
        "advertising@l3amigos.com so we can make this right. — The Casa Tequila Prime Team"
    )
    response_type = ai_engine.classify_response_type(CASA_TEQUILA_PRIME_REVIEW)
    cleaned = ai_engine.enforce_response_policy(worst_case_model_output, response_type)
    assert "advertising@l3amigos.com" not in cleaned
    assert "make this right" not in cleaned.lower()


def main():
    tests = [
        ("Casa Tequila Prime regression review classifies positive_with_feedback", test_casa_tequila_prime_classifies_positive_with_feedback),
        ("Casa Tequila Prime regression review is never serious_escalation", test_casa_tequila_prime_never_serious_escalation),
        ("'no issues' does not trigger the 'sue' keyword (root cause)", test_no_issues_does_not_trigger_sue_keyword),
        ("'grilled' does not trigger the 'ill' keyword (root cause)", test_grilled_does_not_trigger_ill_keyword),
        ("a genuine whole-word serious keyword still matches", test_whole_word_serious_keyword_still_matches),
        ("5-star positive -> no escalation", test_5star_positive_no_escalation),
        ("4-star positive + small complaint -> no recovery CTA class", test_4star_positive_small_complaint_not_recovery),
        ("3-star mixed -> balanced classification", test_3star_mixed_is_balanced),
        ("1-2 star meaningful complaint -> negative", test_1to2star_meaningful_complaint_classifies_negative),
        ("5-star serious unresolved incident -> serious_escalation", test_5star_serious_unresolved_incident_classifies_serious_escalation),
        ("1-star without serious content stays plain negative, not escalation", test_1star_without_serious_keywords_is_plain_negative_not_escalation),
        ("existing ai_sentiment/ai_priority signals are reused for classification", test_ai_sentiment_and_priority_signals_used_when_present),
        ("guard strips forbidden CTA from a non-serious response", test_guard_strips_forbidden_cta_from_non_serious_response),
        ("guard strips a bare email even without a known phrase", test_guard_strips_bare_email_even_without_known_phrase),
        ("guard strips a phone number", test_guard_strips_phone_number),
        ("guard leaves serious_escalation responses untouched", test_guard_leaves_serious_escalation_untouched),
        ("guard never returns an empty string", test_guard_never_returns_empty_string),
        ("end-to-end: worst-case model output is still sanitized for the regression case", test_generated_draft_for_casa_tequila_prime_never_contains_forbidden_cta),
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
