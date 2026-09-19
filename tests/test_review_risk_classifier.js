// Regression tests for dashboard/api/_lib/reviewRiskClassifier.js -- the
// canonical, categorized server-side risk classifier (Review Response
// Quality, PARTs 7-13). Covers every named category, the word-boundary
// false-positive guards inherited from the predecessor flat classifier,
// the active-emergency sub-flag, and the 3-tier classifyReviewTier()
// wrapper. Deliberately does NOT assert exact AI wording anywhere -- this
// file tests classification/policy structure only (PART 24's own
// instruction: "avoid brittle tests that assert a single exact AI
// sentence").
//
// Run directly: node tests/test_review_risk_classifier.js

import {
  classifyReviewRisk,
  isSeriousIssue,
  classifyReviewTier,
  RISK_CATEGORIES,
  CATEGORY_UI_LABELS,
  CATEGORY_GUIDANCE,
} from '../dashboard/api/_lib/reviewRiskClassifier.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
function run(name, fn) {
  try {
    fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  }
}

// --- No-text / empty input never flags high risk ----------------------------

function testEmptyTextIsNeverHighRisk() {
  for (const text of [null, undefined, '', '   ', '\n\t']) {
    const result = classifyReviewRisk(text)
    assert(result.isHighRisk === false, `expected low risk for ${JSON.stringify(text)}`)
    assert(result.categories.length === 0)
    assert(result.isActiveEmergency === false)
  }
}

// --- One representative phrase per category, taken directly from PARTs
// 9-12's own example categories --------------------------------------------

const CATEGORY_EXAMPLES = {
  food_poisoning: 'I got food poisoning and was vomiting all night after eating here.',
  allergic_reaction: 'I had an allergic reaction and my throat started swelling.',
  injury: 'I cut myself on a broken plate and needed stitches.',
  foreign_object: 'I found a piece of glass in my food.',
  unsafe_food: 'The chicken was undercooked and tasted off.',
  sanitation: 'I saw a rat in the kitchen, this place needs a health department visit.',
  threat_violence: 'The manager threatened me and it felt violent.',
  discrimination_harassment: 'The staff was racist and I felt harassed the whole time.',
  legal_threat: "I'm calling my lawyer and considering a lawsuit.",
  fraud_payment: 'They overcharged me and I think it was fraud.',
}

function testEveryCategoryHasAWorkingExample() {
  for (const category of Object.keys(RISK_CATEGORIES)) {
    const example = CATEGORY_EXAMPLES[category]
    assert(example, `no example text registered for category ${category}`)
    const result = classifyReviewRisk(example)
    assert(result.isHighRisk, `category ${category} example must classify as high risk: "${example}"`)
    assert(result.categories.includes(category), `expected category ${category} to be detected in "${example}", got ${JSON.stringify(result.categories)}`)
  }
}

function testEveryCategoryHasAUiLabelAndGuidance() {
  for (const category of Object.keys(RISK_CATEGORIES)) {
    assert(typeof CATEGORY_UI_LABELS[category] === 'string' && CATEGORY_UI_LABELS[category].length > 0,
      `category ${category} must have a UI label`)
    assert(typeof CATEGORY_GUIDANCE[category] === 'string' && CATEGORY_GUIDANCE[category].length > 0,
      `category ${category} must have prompt guidance`)
  }
}

// --- Word-boundary false-positive guards (inherited from the predecessor
// flat SERIOUS_KEYWORDS classifier -- see test_rewrite_policy.js's own
// versions of these exact two regressions) ----------------------------------

function testNoIssuesDoesNotTriggerLegalThreatSueKeyword() {
  assert(!isSeriousIssue("Everything was great, no issues at all, we'll be back!"),
    "'issues' must never match the 'sue' keyword via substring")
}

function testGrilledDoesNotTriggerFoodPoisoningIllKeyword() {
  assert(!isSeriousIssue("The steak was grilled to perfection, best meal we've had in a while."),
    "'grilled' must never match the 'ill' keyword via substring")
}

function testOverwhelminglyPositiveReviewNeverFlagged() {
  const text = 'We had a great experience! Loved the vibe and decor, and the drinks were awesome. ' +
    'Food quality was excellent. Service, food, and vibes were good. We will definitely be back!'
  const result = classifyReviewRisk(text)
  assert(result.isHighRisk === false, 'an overwhelmingly positive review must never be flagged high risk')
}

// --- Active emergency sub-flag -----------------------------------------------

function testActiveEmergencyFlaggedForAcuteBreathingLanguage() {
  const result = classifyReviewRisk('My daughter had an allergic reaction and was having difficulty breathing.')
  assert(result.isHighRisk === true)
  assert(result.isActiveEmergency === true, 'acute breathing-difficulty language must set isActiveEmergency')
}

function testActiveEmergencyNotFlaggedForPastIncidentWithoutAcuteLanguage() {
  const result = classifyReviewRisk('I had an allergic reaction last week after eating here, my skin got hives.')
  assert(result.isHighRisk === true, 'still high risk (allergic_reaction category)')
  assert(result.isActiveEmergency === false, 'a past, non-acute incident must not set isActiveEmergency')
}

// --- Multiple categories can be detected in one review ----------------------

function testMultipleCategoriesDetectedSimultaneously() {
  const result = classifyReviewRisk('I found glass in my food and then the manager threatened me.')
  assert(result.categories.includes('foreign_object'))
  assert(result.categories.includes('threat_violence'))
  assert(result.categories.length >= 2)
}

// --- Fail toward human review on uncertain/ambiguous text (PART 13):
// high recall means a single keyword match anywhere is enough -- there is
// no "confidence threshold" that could silently suppress a flag. ------------

function testSingleAmbiguousKeywordStillFlagsHighRisk() {
  const result = classifyReviewRisk('Honestly this whole visit made me feel sick.')
  assert(result.isHighRisk === true, 'a single genuine match must be enough to flag high risk -- never require corroboration before flagging')
}

// --- classifyReviewTier(): the 3-tier wrapper (PART 7) -----------------------

function testTierHighRiskWinsRegardlessOfStars() {
  const tier = classifyReviewTier({ reviewText: 'I found a bug in my food.', stars: 5 })
  assert(tier.tier === 'high_risk', 'a high-risk category must win even on a 5-star review')
  assert(tier.categories.includes('foreign_object'))
}

function testTierLowRiskForPositiveTextOrHighStarNoText() {
  const withText = classifyReviewTier({ reviewText: 'Great food and service!', stars: 5 })
  assert(withText.tier === 'low_risk')
  const noText = classifyReviewTier({ reviewText: '', stars: 5 })
  assert(noText.tier === 'low_risk')
}

function testTierNormalNegativeForLowStarNonSeriousText() {
  const tier = classifyReviewTier({ reviewText: 'The wait was too long and the food was cold.', stars: 1 })
  assert(tier.tier === 'normal_negative', `expected normal_negative, got ${tier.tier}`)
}

function testTierNormalNegativeForLowStarNoText() {
  const tier = classifyReviewTier({ reviewText: '', stars: 2 })
  assert(tier.tier === 'normal_negative', 'a low-star review with no text is still normal_negative, never low_risk')
}

const tests = [
  ['empty/null/whitespace-only text is never high risk', testEmptyTextIsNeverHighRisk],
  ['every risk category has at least one working example that flags high risk', testEveryCategoryHasAWorkingExample],
  ['every risk category has a UI label and prompt guidance', testEveryCategoryHasAUiLabelAndGuidance],
  ["'no issues' does not trigger the legal_threat 'sue' keyword (root cause)", testNoIssuesDoesNotTriggerLegalThreatSueKeyword],
  ["'grilled' does not trigger the food_poisoning 'ill' keyword (root cause)", testGrilledDoesNotTriggerFoodPoisoningIllKeyword],
  ['an overwhelmingly positive review is never flagged high risk', testOverwhelminglyPositiveReviewNeverFlagged],
  ['acute breathing-difficulty language sets isActiveEmergency', testActiveEmergencyFlaggedForAcuteBreathingLanguage],
  ['a past, non-acute allergic incident is high risk but not an active emergency', testActiveEmergencyNotFlaggedForPastIncidentWithoutAcuteLanguage],
  ['multiple categories can be detected in a single review', testMultipleCategoriesDetectedSimultaneously],
  ['a single genuine keyword match is enough to flag high risk (fail toward human review)', testSingleAmbiguousKeywordStillFlagsHighRisk],
  ['classifyReviewTier(): high_risk wins regardless of star rating', testTierHighRiskWinsRegardlessOfStars],
  ['classifyReviewTier(): low_risk for positive text or high-star no-text', testTierLowRiskForPositiveTextOrHighStarNoText],
  ['classifyReviewTier(): normal_negative for low-star non-serious text', testTierNormalNegativeForLowStarNonSeriousText],
  ['classifyReviewTier(): normal_negative for low-star no-text (never low_risk)', testTierNormalNegativeForLowStarNoText],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
