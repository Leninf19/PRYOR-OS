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
export const CATEGORY_GUIDANCE = Object.freeze({
  food_poisoning: 'This review alleges the guest became ill after eating here. Take the concern seriously and express genuine concern for the guest. Do not diagnose the illness, do not confirm or deny that the restaurant caused it, and do not argue about timing or incubation periods. Invite them to reach out directly with the date and details of their visit so management can look into it. If it sounds like they may currently be experiencing severe or worsening symptoms, gently note that they should seek appropriate medical care. Do not admit fault.',
  allergic_reaction: 'This review describes a possible allergic reaction or a medical emergency. Express genuine concern for the guest\'s wellbeing. Do not offer medical advice or attempt a diagnosis -- if the situation sounds acute (breathing difficulty, anaphylaxis, loss of consciousness), the only appropriate guidance is that the guest should seek immediate emergency medical care. Invite direct follow-up. Do not admit fault.',
  injury: 'This review describes a physical injury. Express genuine concern for the guest\'s wellbeing, invite them to reach out directly with details, and do not admit fault or dispute their account.',
  foreign_object: 'This review alleges a foreign object was found in food. Acknowledge the seriousness and ask the guest to reach out directly with visit details so it can be looked into. Do not state as fact that contamination occurred unless the business has already confirmed it -- treat it as a reported concern, not a confirmed fact.',
  unsafe_food: 'This review alleges unsafe, spoiled, or undercooked food. Take it seriously without confirming the allegation as fact, and invite direct follow-up with visit details.',
  sanitation: 'This review raises a sanitation or health-code concern. Acknowledge it seriously without confirming the allegation as fact, and invite direct follow-up.',
  threat_violence: 'This review describes threats or violence. Keep the response calm, neutral, and non-inflammatory. Do not escalate, argue, or make accusations back.',
  discrimination_harassment: 'This review alleges discrimination or harassment. Keep the response calm, neutral, and non-defensive. Do not deny or argue the allegation -- invite direct follow-up so it can be looked into properly.',
  legal_threat: 'This review references legal action, a lawyer, or police involvement. Keep the response neutral and non-inflammatory. Do not make any legal conclusions or admissions.',
  fraud_payment: 'This review alleges theft or a billing/payment problem. Do not confirm or deny the allegation -- invite direct follow-up with details so it can be reviewed.',
})
