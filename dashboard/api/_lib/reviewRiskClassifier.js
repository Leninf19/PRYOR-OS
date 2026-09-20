// Review Response Quality -- the ONE canonical, categorized risk classifier
// for review text. Replaces the previous flat `isSeriousIssue()` boolean
// (a single undifferentiated SERIOUS_KEYWORDS list) with an explicit set of
// named categories, so both the AI prompt and the publish-time safety gate
// can reason about WHAT kind of serious concern a review raises, not just
// "is this serious or not."
//
// This is a keyword/word-boundary classifier, not an ML model -- exactly
// like its predecessor. It is deliberately HIGH-RECALL: any match in any
// category marks the review high-risk, favoring "flag it for a human" over
// "silently let something dangerous slip through" (see PART 13 of this
// feature's own spec -- "fail toward human review" on uncertainty). A
// restaurant owner reviewing one extra false-positive draft is a much
// smaller cost than an AI-drafted reply publishing over an allergic-
// reaction or foreign-object complaint unreviewed.
//
// dashboard/src/utils/replyState.js keeps its OWN, separate copy of an
// equivalent categorized list for frontend UI display (badges, the
// "needs management review" banner) -- this mirrors the SAME deliberate
// duplication convention this codebase already used for
// ai_engine.py/rewriteEngine.js (see this file's own prior header comment,
// preserved in git history): a browser-bundled file cannot import
// server-only `_lib` modules, and this project's established pattern for
// that boundary is a clearly cross-referenced, kept-in-sync duplicate,
// never a cross-boundary import. THIS file is the server-authoritative
// copy: dashboard/api/google/[action].js's publish() enforcement (the
// actual security/safety boundary -- see that file's own comment) uses
// THIS module directly, never the frontend copy.

// Every keyword is matched with \b...\b word boundaries (case-insensitive)
// -- a naive substring match fires on innocent words containing a keyword
// ('sue' inside "no ISSUEs at all", 'ill' inside "grilled perfectly").
export const RISK_CATEGORIES = Object.freeze({
  food_poisoning: [
    'sick', 'ill', 'illness', 'vomit', 'vomiting', 'threw up', 'food poisoning',
    'diarrhea', 'nausea', 'nauseous', 'stomach ache', 'upset stomach', 'cramping',
  ],
  allergic_reaction: [
    'allergic', 'allergy', 'allergies', 'anaphylaxis', 'anaphylactic', 'epipen',
    'epi-pen', 'throat closing', 'throat swelling', 'swelling', 'hives',
    'difficulty breathing', 'trouble breathing', "can't breathe", 'cant breathe',
    'passed out', 'unconscious', 'lost consciousness',
  ],
  injury: [
    'injury', 'injured', 'cut myself', 'burned', 'burn', 'choke', 'choked',
    'choking', 'broken tooth', 'chipped tooth', 'fell', 'fall', 'accident',
    'bleeding', 'stitches', 'hospital', 'hospitalized', 'doctor', 'er visit',
    'emergency room',
  ],
  foreign_object: [
    'glass', 'metal', 'plastic', 'staple', 'wire', 'bug', 'insect', 'cockroach',
    'roach', 'fly in my', 'hair in my food', 'foreign object', 'band-aid', 'bandaid',
  ],
  unsafe_food: [
    'raw chicken', 'undercooked', 'undercooked chicken', 'spoiled', 'rotten',
    'expired', 'mold', 'moldy', 'rancid', 'smelled off', 'tasted off',
  ],
  sanitation: [
    'rat', 'rats', 'mouse', 'mice', 'rodent', 'rodents', 'pest', 'pests',
    'health department', 'health code', 'health violation', 'dirty kitchen',
    'unsanitary', 'filthy', 'shut down',
  ],
  threat_violence: [
    'threatened', 'threatening', 'assault', 'assaulted', 'violent', 'violence',
    'weapon', 'gun', 'knife pulled',
  ],
  discrimination_harassment: [
    'discrimination', 'discriminated', 'racist', 'racism', 'harassment',
    'harassed', 'hostile', 'homophobic', 'sexist',
  ],
  legal_threat: [
    'lawsuit', 'lawyer', 'attorney', 'sue', 'sued', 'legal action', 'police',
    'subpoena', 'file a complaint',
  ],
  fraud_payment: [
    'stole', 'stolen', 'theft', 'fraud', 'fraudulent', 'overcharged', 'scam', 'scammed',
  ],
})

// Subset of allergic_reaction/injury language that indicates an ACTIVE,
// potentially ongoing medical emergency (Part 10) rather than a past
// incident being reported after the fact -- used only to steer the AI's
// "seek immediate care" language, never to change the category set itself.
const ACTIVE_EMERGENCY_KEYWORDS = [
  'anaphylaxis', 'anaphylactic', 'difficulty breathing', 'trouble breathing',
  "can't breathe", 'cant breathe', 'passed out', 'unconscious', 'lost consciousness',
]

function buildWordBoundaryRegex(keywords) {
  const escaped = keywords.map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp('\\b(' + escaped.join('|') + ')\\b', 'i')
}

const CATEGORY_PATTERNS = Object.fromEntries(
  Object.entries(RISK_CATEGORIES).map(([category, keywords]) => [category, buildWordBoundaryRegex(keywords)])
)
const ACTIVE_EMERGENCY_RE = buildWordBoundaryRegex(ACTIVE_EMERGENCY_KEYWORDS)

// Returns { isHighRisk, categories, isActiveEmergency }. Never throws;
// empty/missing text is always low risk (nothing to match against).
export function classifyReviewRisk(reviewText) {
  if (!reviewText || typeof reviewText !== 'string' || !reviewText.trim()) {
    return { isHighRisk: false, categories: [], isActiveEmergency: false }
  }
  const categories = Object.entries(CATEGORY_PATTERNS)
    .filter(([, re]) => re.test(reviewText))
    .map(([category]) => category)
  return {
    isHighRisk: categories.length > 0,
    categories,
    isActiveEmergency: ACTIVE_EMERGENCY_RE.test(reviewText),
  }
}

// Backward-compatible boolean form -- kept so existing callers migrate
// without a second required change. New code should prefer
// classifyReviewRisk() directly for the category list.
export function isSeriousIssue(reviewText) {
  return classifyReviewRisk(reviewText).isHighRisk
}

// The 3-tier classification PART 7 of this feature's spec describes
// (LOW RISK / NORMAL NEGATIVE / HIGH RISK-URGENT), layered on top of the
// category classifier. Only `high_risk` has any enforcement consequence
// (see google/[action].js's publish() gate) -- the other two tiers exist
// for prompt/UI guidance only.
export function classifyReviewTier({ reviewText, stars }) {
  const { isHighRisk, categories, isActiveEmergency } = classifyReviewRisk(reviewText)
  if (isHighRisk) return { tier: 'high_risk', categories, isActiveEmergency }
  const numStars = Number(stars) || 3
  const hasText = typeof reviewText === 'string' && reviewText.trim().length > 0
  if (!hasText) {
    return { tier: numStars <= 2 ? 'normal_negative' : 'low_risk', categories: [], isActiveEmergency: false }
  }
  return { tier: numStars <= 2 ? 'normal_negative' : 'low_risk', categories: [], isActiveEmergency: false }
}

// Human-readable labels for the UI badges PART 8 asks for
// (Urgent / Health & Safety / Needs Manager Review). Category -> label is
// intentionally coarse (several categories share "Health & Safety") --
// this is a display concern, not the enforcement boundary.
export const CATEGORY_UI_LABELS = Object.freeze({
  food_poisoning: 'Health & Safety',
  allergic_reaction: 'Health & Safety',
  injury: 'Health & Safety',
  foreign_object: 'Health & Safety',
  unsafe_food: 'Health & Safety',
  sanitation: 'Health & Safety',
  threat_violence: 'Needs Manager Review',
  discrimination_harassment: 'Needs Manager Review',
  legal_threat: 'Needs Manager Review',
  fraud_payment: 'Needs Manager Review',
})

// Category-specific policy guidance injected into the AI prompt when that
// category is detected (PARTs 9-12). Deliberately POLICY, not a single
// hardcoded response template -- the model still writes naturally within
// these constraints (PART 9's own explicit instruction: "Do NOT hardcode
// this exact response as the only template. Generate naturally from
// policy.").
// Review Response Playbook v2, PART 26: for every category below, the goal
// is the SAME balance -- (1) acknowledge the guest's reported experience,
// (2) express appropriate concern, (3) state applicable restaurant
// standards/procedures when useful, (4) never admit unverified causation,
// (5) never attack or accuse the reviewer, (6) invite private follow-up,
// (7) rely on the existing publish-time human-approval gate (this module's
// isHighRisk) rather than trying to be "safe enough" to auto-publish.
// "Defend the restaurant's professionalism and operating standards without
// becoming defensive toward the guest."
export const CATEGORY_GUIDANCE = Object.freeze({
  food_poisoning: 'This review alleges the guest became ill after eating here (PART 11 -- high risk). Express genuine concern using neutral chronology only -- say things like "you became ill after your visit" or "you reported becoming ill following your visit," never "our food made you sick," "we gave you food poisoning," "we caused your illness," or "we\'re sorry we poisoned you." The restaurant may calmly state its standards, e.g. "our restaurant follows established food-safety procedures and applicable health requirements" or "our team follows established food-handling and sanitation procedures, and we take reports of illness seriously" -- but do not claim a perfect health inspection record, a specific inspection score, health department approval, a certification, or "this has never happened before" unless that fact is explicitly verified for this location. Do not diagnose the illness or argue about timing. Invite them to reach out directly with visit details. Do not admit fault.',
  allergic_reaction: 'This review describes a possible allergic reaction (PART 15 -- high risk). Express genuine concern for the guest\'s wellbeing without diagnosing, admitting causation, or asking for sensitive medical details publicly. Do not include emergency-care language unless separately instructed to -- that language is reserved for reactions described as currently active or severe, never for a reaction already resolved or in the past. Invite direct follow-up. Do not admit fault.',
  injury: 'This review describes a physical injury. Express genuine concern for the guest\'s wellbeing, invite them to reach out directly with details, and do not admit fault or dispute their account.',
  foreign_object: 'This review alleges a foreign object was found in food (glass, plastic, metal, hair, a bug, or similar -- PART 14, high risk/manager review). Acknowledge the seriousness and ask the guest to reach out directly with visit details. Do not state as fact that contamination occurred, and do not say anything like "that could not have come from our kitchen" -- treat it as a reported concern, not a confirmed or denied fact.',
  unsafe_food: 'This review alleges undercooked, raw, spoiled, or otherwise unsafe food (PART 13 -- treat raw/undercooked food as high-risk food safety, same as food poisoning). Take it seriously using neutral, non-defensive language. Do not confirm the item was actually undercooked or raw unless that has already been established, do not call the guest dishonest, and do not minimize the concern. Do not admit fault; invite direct follow-up with visit details.',
  sanitation: 'This review raises a sanitation, pest, or health-code concern (PART 16). The restaurant may appropriately state that it maintains its own cleanliness/sanitation standards while still acknowledging the complaint and offering to look into it -- do not say anything like "our restaurant is always clean, so this review is false." Avoid over-broad claims such as "we follow all Health Department regulations" -- prefer "established food-safety procedures and applicable health requirements" instead. Invite direct follow-up.',
  threat_violence: 'This review describes a threat or confrontation (PART 19 -- sensitive, requires human review). Keep the response neutral, serious, and non-inflammatory. Do not escalate, argue, make legal conclusions, or make accusations back.',
  discrimination_harassment: 'This review alleges discrimination or harassment (PART 19 -- sensitive, requires human review). Keep the response calm, neutral, and non-defensive. Do not make legal conclusions, admit discrimination occurred, automatically deny it, or attack the reviewer -- invite direct follow-up so it can be looked into properly.',
  legal_threat: 'This review references legal action, a lawyer, or police involvement. Keep the response neutral and non-inflammatory. Do not make any legal conclusions or admissions.',
  fraud_payment: 'This review alleges theft or a billing/payment problem (PART 18). Do not discuss card or payment details publicly, and do not admit an incorrect charge before it has been verified -- invite direct follow-up with details so it can be reviewed.',
})
