// Review Response Playbook v2, PART 6/7-10/17/18/24 -- normal-severity
// 1-star/negative complaint categories. This is DELIBERATELY separate from
// reviewRiskClassifier.js: that module is the safety-critical, high-recall
// classifier that gates the "urgent review -- confirm before publishing"
// human-approval requirement (see google/[action].js's publish() enforcement)
// and MUST NOT be touched by this feature (PART 5 -- "preserve the existing
// urgent-review safety gate"). Every category here is an ordinary
// operational complaint (slow service, a wrong order, a cold plate) that has
// no business ever blocking publish or triggering "needs manager review" --
// it exists purely to make the generated reply specific and appropriately
// worded for what the guest actually complained about, per PART 6's own
// instruction: "reuse the existing serious-risk classifier where appropriate
// rather than creating a second COMPETING classifier." These categories
// don't compete with it -- they cover ground it was never designed to cover
// (7 of PART 6's 25 named categories -- food_poisoning_or_illness,
// allergic_reaction, foreign_object, sanitation_or_pest_claim,
// discrimination_or_harassment, threat_or_confrontation, legal_threat -- plus
// undercooked_or_raw_food, which maps onto unsafe_food -- are intentionally
// NOT duplicated here; callers needing those already call
// classifyReviewRisk()/CATEGORY_GUIDANCE from reviewRiskClassifier.js).
//
// Same word-boundary keyword-matching convention as reviewRiskClassifier.js,
// deliberately low-stakes here: false positives just add a slightly more
// specific guidance sentence to the prompt, and false negatives just fall
// back to the generic negative-review guidance already in rewriteEngine.js.
export const COMPLAINT_CATEGORIES = Object.freeze({
  slow_service: [
    'slow service', 'took forever', 'waited forever', 'waited an hour', 'waited over an hour',
    'long wait', 'nobody came', 'no one came', 'ignored us', 'took so long', 'took too long',
  ],
  rude_staff: [
    'rude', 'rude staff', 'rude server', 'rude waiter', 'rude waitress', 'attitude',
    'dismissive', 'unfriendly', 'condescending', 'yelled at', 'snapped at', 'disrespectful',
  ],
  wrong_order: [
    'wrong order', 'wrong dish', 'wrong item', 'brought the wrong order', 'not what I ordered',
    'mixed up our order',
  ],
  missing_items: [
    'missing item', 'forgot my', 'forgot the', 'didn\'t include', 'left out of my order',
    'was missing from', 'never got my',
  ],
  cold_food: ['cold food', 'food was cold', 'came out cold', 'lukewarm', 'arrived cold'],
  poor_food_quality: ['poor quality', 'low quality', 'not fresh', 'tasted stale', 'stale', 'bad quality'],
  bland_food: ['bland', 'flavorless', 'no flavor', 'tasteless', 'under-seasoned', 'needed more seasoning'],
  overcooked_food: ['overcooked', 'over cooked', 'dried out', 'burnt', 'burned', 'too dry'],
  small_portions: ['small portion', 'tiny portion', 'portion size', 'not enough food', 'skimpy'],
  high_prices_or_value: [
    'overpriced', 'too expensive', 'not worth the price', 'not worth it', 'pricey for',
    'expensive for what', "wasn't worth",
  ],
  long_takeout_wait: [
    'takeout took forever', 'pickup took forever', 'took forever for pickup',
    'order wasn\'t ready', 'pickup wasn\'t ready',
  ],
  reservation_or_seating_issue: [
    'reservation', 'reserved a table', 'seated us', 'wouldn\'t seat us', 'lost our reservation',
    'no table ready', 'made us wait for a table',
  ],
  cleanliness: [
    'dirty table', 'sticky table', 'dirty floor', 'dirty bathroom', 'dirty restroom',
    'not clean', 'looked dirty', 'grimy', 'sticky floor',
  ],
  billing_or_double_charge: [
    'double charged', 'charged twice', 'overcharged', 'wrong total', 'billing error',
    'charged the wrong', 'bill was wrong', 'incorrect charge',
  ],
  delivery_problem: [
    'delivery was late', 'late delivery', 'delivery driver', 'arrived cold via delivery',
    'never arrived', 'delivery order', 'doordash', 'uber eats', 'grubhub',
  ],
  disputed_review: [
    'never went there', 'never even went there', 'never ate there', 'wrong location',
    'not even the right restaurant', 'this isn\'t us', 'must be thinking of', 'never been here',
  ],
})

// Same escaping convention as reviewRiskClassifier.js's buildWordBoundaryRegex:
// every entry above is a literal phrase, never a regex fragment, so it must
// be escaped before being spliced into the alternation.
function buildWordBoundaryRegex(keywords) {
  const escaped = keywords.map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp('\\b(' + escaped.join('|') + ')\\b', 'i')
}

const COMPLAINT_PATTERNS = Object.fromEntries(
  Object.entries(COMPLAINT_CATEGORIES).map(([category, patterns]) => [category, buildWordBoundaryRegex(patterns)])
)

// Returns the list of matched normal-severity complaint categories (never
// includes any reviewRiskClassifier.js high-risk category). Empty text or no
// match returns []; callers should treat [] as PART 6's
// general_one_star_no_details/no-specific-category case and fall back to
// generic negative-review guidance.
export function classifyComplaintCategories(reviewText) {
  if (!reviewText || typeof reviewText !== 'string' || !reviewText.trim()) return []
  return Object.entries(COMPLAINT_PATTERNS)
    .filter(([, re]) => re.test(reviewText))
    .map(([category]) => category)
}

// Category-specific policy guidance (PARTS 7-10, 17, 18, 24). Same
// discipline as reviewRiskClassifier.js's CATEGORY_GUIDANCE: policy, not a
// hardcoded template -- the model still writes naturally within these
// constraints. Every entry follows PART 7's baseline rule (acknowledge the
// actual issue; never argue, over-apologize, blame an employee or the guest,
// invent facts, or promise compensation/refunds/an investigation that
// hasn't happened) plus its own category-specific nuance.
export const COMPLAINT_CATEGORY_GUIDANCE = Object.freeze({
  slow_service: 'The complaint is about slow service or a long wait. Acknowledge the wait specifically without over-apologizing, arguing, or promising a refund or compensation.',
  rude_staff: 'The complaint is about a staff member\'s behavior. Protect both the guest and the employee until the facts are known -- do not write that the employee "would never do that," but also do not automatically agree the staff member\'s behavior was unacceptable or accuse them by name. Acknowledge the guest\'s experience and note that this is something management wants to look into.',
  wrong_order: 'The complaint is about receiving the wrong order or dish. Acknowledge the mistake plainly without blaming a specific employee or the guest.',
  missing_items: 'The complaint is about missing item(s) from an order. Acknowledge it plainly without blaming a specific employee or promising a refund.',
  cold_food: 'The complaint is about food arriving cold. Acknowledge the specific issue without debating it or claiming it doesn\'t usually happen.',
  poor_food_quality: 'The complaint is about food quality. Acknowledge without debating personal taste or claiming "most guests love this dish" -- that reads as argumentative.',
  bland_food: 'The complaint is that the food was bland or under-seasoned. Acknowledge without debating personal taste.',
  overcooked_food: 'The complaint is that the food was overcooked or dried out. Acknowledge the specific issue without debating it.',
  small_portions: 'The complaint is about portion size. Acknowledge briefly without debating it or explaining ingredient costs.',
  high_prices_or_value: 'The complaint is about price or value. Do not argue about pricing, justify the price, or explain ingredient/food costs -- acknowledge briefly and keep it concise.',
  long_takeout_wait: 'The complaint is about a long takeout or pickup wait. Acknowledge the specific issue without over-apologizing or promising compensation.',
  reservation_or_seating_issue: 'The complaint is about a reservation or seating issue. Acknowledge it plainly without blaming a specific host or the guest.',
  cleanliness: 'The complaint is about cleanliness. The restaurant may note that it maintains cleanliness standards while still acknowledging the guest\'s experience and willingness to look into it -- do not claim the restaurant is "always clean" in a way that dismisses the complaint as false.',
  billing_or_double_charge: 'The complaint is about a billing or charge issue. Do not discuss specific card or payment details publicly, and do not admit an incorrect charge before it has been verified -- invite the guest to reach out so the charge can be looked into.',
  delivery_problem: 'The complaint is about a delivery issue. Acknowledge the specific problem without blaming the delivery driver, platform, or the guest, and without promising a refund.',
  disputed_review: 'This review may not match the restaurant\'s own records (e.g. the guest may be describing a different location or visit). Do not call the reviewer a liar, dishonest, or fraudulent, and do not publicly accuse them of posting a fake review -- acknowledge the discrepancy calmly and invite them to reach out with visit details so it can be looked into. Only state that the visit doesn\'t match the restaurant\'s records if that mismatch is already confirmed, not merely suspected.',
})
