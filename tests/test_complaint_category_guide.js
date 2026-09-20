// Review Response Playbook v2, PART 6/27 -- regression tests for the new
// normal-severity complaint-category classifier
// (dashboard/api/_lib/complaintCategoryGuide.js). Deliberately separate
// from tests/test_review_risk_classifier.js, which covers the existing
// high-risk/urgent-review-gate classifier that this feature must not touch.
//
// Run directly: node tests/test_complaint_category_guide.js

import { classifyComplaintCategories, COMPLAINT_CATEGORY_GUIDANCE, COMPLAINT_CATEGORIES } from '../dashboard/api/_lib/complaintCategoryGuide.js'
import { classifyReviewRisk } from '../dashboard/api/_lib/reviewRiskClassifier.js'

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

const tests = [
  ['slow service is detected', () => {
    const cats = classifyComplaintCategories('We waited forever for a table and the food took forever too.')
    assert(cats.includes('slow_service'), JSON.stringify(cats))
  }],
  ['rude staff is detected', () => {
    const cats = classifyComplaintCategories('Our server was incredibly rude and dismissive the whole time.')
    assert(cats.includes('rude_staff'), JSON.stringify(cats))
  }],
  ['wrong order is detected', () => {
    const cats = classifyComplaintCategories('They brought the wrong order and it wasn\'t what I ordered at all.')
    assert(cats.includes('wrong_order'), JSON.stringify(cats))
  }],
  ['cold food is detected', () => {
    const cats = classifyComplaintCategories('The food was cold when it arrived.')
    assert(cats.includes('cold_food'), JSON.stringify(cats))
  }],
  ['price/value complaint is detected', () => {
    const cats = classifyComplaintCategories('Way too expensive and honestly not worth it for the portion size.')
    assert(cats.includes('high_prices_or_value'), JSON.stringify(cats))
    assert(cats.includes('small_portions'), JSON.stringify(cats))
  }],
  ['cleanliness complaint is detected', () => {
    const cats = classifyComplaintCategories('The table was dirty and the bathroom was not clean at all.')
    assert(cats.includes('cleanliness'), JSON.stringify(cats))
  }],
  ['billing/double-charge complaint is detected', () => {
    const cats = classifyComplaintCategories('I was charged twice for the same order, total billing error.')
    assert(cats.includes('billing_or_double_charge'), JSON.stringify(cats))
  }],
  ['disputed review language is detected', () => {
    const cats = classifyComplaintCategories('I never even went there, this must be the wrong location.')
    assert(cats.includes('disputed_review'), JSON.stringify(cats))
  }],
  ['a plain positive review matches nothing', () => {
    const cats = classifyComplaintCategories('Great food, great service, we loved it and will be back soon!')
    assert(cats.length === 0, JSON.stringify(cats))
  }],
  ['empty/missing text returns no categories', () => {
    assert(classifyComplaintCategories('').length === 0)
    assert(classifyComplaintCategories(null).length === 0)
    assert(classifyComplaintCategories(undefined).length === 0)
  }],
  ['every category has matching guidance text', () => {
    for (const category of Object.keys(COMPLAINT_CATEGORIES)) {
      assert(typeof COMPLAINT_CATEGORY_GUIDANCE[category] === 'string' && COMPLAINT_CATEGORY_GUIDANCE[category].length > 0,
        `missing guidance for category: ${category}`)
    }
  }],
  ['none of these categories ever overlap with the high-risk classifier\'s categories (PART 6: additive, not competing)', () => {
    const highRiskNames = new Set(['food_poisoning', 'allergic_reaction', 'injury', 'foreign_object', 'unsafe_food', 'sanitation', 'threat_violence', 'discrimination_harassment', 'legal_threat', 'fraud_payment'])
    for (const category of Object.keys(COMPLAINT_CATEGORIES)) {
      assert(!highRiskNames.has(category), `complaint category "${category}" collides with a high-risk classifier category name`)
    }
  }],
  ['a genuine high-risk review is never miscategorized as only a normal complaint (both classifiers may fire independently)', () => {
    const text = 'I got food poisoning and ended up in the hospital, this was terrifying.'
    const { isHighRisk } = classifyReviewRisk(text)
    assert(isHighRisk, 'the high-risk classifier must still catch this independently of the new complaint classifier')
  }],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
