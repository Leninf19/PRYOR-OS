// Regression tests for dashboard/api/_lib/reviewEmailTemplate.js -- the
// server-side HTML+plain-text email template for the restaurant bad-review
// email workflow.
//
// Run directly: node tests/test_review_email_template.js

import { buildDefaultSubject, buildReviewEmail } from '../dashboard/api/_lib/reviewEmailTemplate.js'

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

const BASE_REVIEW = {
  locationName: 'Los Tres Amigos Canton',
  city: 'Canton',
  starRating: 1,
  reviewerName: 'Jane Doe',
  reviewDate: '2026-07-01',
  reviewText: 'The food took forever and the server was rude.',
  reviewUrl: 'https://maps.google.com/?cid=12345',
}

function testDefaultSubjectFormat() {
  const subject = buildDefaultSubject({ locationName: 'Los Tres Amigos Canton', starRating: 1 })
  assert(subject === 'Response Requested — Los Tres Amigos Canton — 1-Star Customer Review', `unexpected subject: ${subject}`)
}

function testHtmlContainsAllRequiredFields() {
  const { html } = buildReviewEmail({ review: BASE_REVIEW, internalReferenceUrl: 'https://dashboard.example.com/explorer?reviewId=abc', internalNote: null, replyToEmail: 'advertising@l3amigos.com' })
  assert(html.includes('Los Tres Amigos Canton'), 'location name must be present')
  assert(html.includes('Canton'), 'city must be present')
  assert(html.includes('1/5'), 'star rating must be present')
  assert(html.includes('Jane Doe'), 'reviewer name must be present')
  assert(html.includes('2026-07-01'), 'review date must be present')
  assert(html.includes('Google'), 'review source/platform must be present')
  assert(html.includes('The food took forever and the server was rude.'), 'complete review text must be present')
  assert(html.includes('https://maps.google.com/?cid=12345'), 'direct review link must be present')
  assert(html.includes('https://dashboard.example.com/explorer?reviewId=abc'), 'internal review reference must be present')
  assert(html.includes('What happened?'), 'question 1 must be present')
  assert(html.includes('Do you recognize this situation?'), 'question 2 must be present')
  assert(html.includes('What corrective action has been taken?'), 'question 3 must be present')
  assert(html.includes('What response do you recommend sending to the customer?'), 'question 4 must be present')
  assert(html.includes('reply') || html.includes('Reply'), 'reply instructions must be present')
}

function testPlainTextFallbackContainsAllRequiredFields() {
  const { text } = buildReviewEmail({ review: BASE_REVIEW, internalReferenceUrl: 'https://dashboard.example.com/explorer?reviewId=abc', internalNote: null, replyToEmail: 'advertising@l3amigos.com' })
  assert(!text.includes('<'), 'plain-text version must contain no HTML markup')
  assert(text.includes('Los Tres Amigos Canton'))
  assert(text.includes('Jane Doe'))
  assert(text.includes('2026-07-01'))
  assert(text.includes('Google'))
  assert(text.includes('The food took forever and the server was rude.'))
  assert(text.includes('https://maps.google.com/?cid=12345'))
  assert(text.includes('https://dashboard.example.com/explorer?reviewId=abc'))
  assert(text.includes('What happened?'))
  assert(text.includes('What response do you recommend sending to the customer?'))
}

function testHtmlEscapesReviewerNameAndReviewText() {
  const malicious = {
    ...BASE_REVIEW,
    reviewerName: '<script>alert(1)</script>',
    reviewText: 'Terrible <b>service</b> & rude "staff"',
  }
  const { html } = buildReviewEmail({ review: malicious, internalReferenceUrl: null, internalNote: null, replyToEmail: null })
  assert(!html.includes('<script>alert(1)</script>'), 'reviewer name must be escaped, never injected as raw HTML')
  assert(html.includes('&lt;script&gt;'), 'the escaped form of the reviewer name must be present')
  assert(!html.includes('Terrible <b>service</b>'), 'review text must be escaped, never injected as raw HTML')
  assert(html.includes('&amp;') && html.includes('&quot;'), 'ampersand and quotes in review text must be escaped')
}

function testHtmlEscapesInternalNote() {
  const { html } = buildReviewEmail({
    review: BASE_REVIEW, internalReferenceUrl: null,
    internalNote: '<img src=x onerror=alert(1)>', replyToEmail: null,
  })
  assert(!html.includes('<img src=x onerror=alert(1)>'), 'an internal note must be escaped before insertion into HTML')
}

function testMissingOptionalFieldsDoNotCrash() {
  const minimal = {
    locationName: 'Test Location', city: null, starRating: 2,
    reviewerName: null, reviewDate: null, reviewText: null, reviewUrl: null,
  }
  const { html, text } = buildReviewEmail({ review: minimal, internalReferenceUrl: null, internalNote: null, replyToEmail: null })
  assert(html.includes('Anonymous'), 'a missing reviewer name must render as Anonymous, not crash')
  assert(html.includes('(no text provided)'), 'missing review text must render a placeholder, not crash')
  assert(!html.includes('undefined') && !html.includes('null'), 'no raw undefined/null must ever leak into the HTML body')
  assert(!text.includes('undefined') && !text.includes('null'), 'no raw undefined/null must ever leak into the plain-text body')
}

function testStarRatingRendersCorrectFilledCount() {
  const { html } = buildReviewEmail({ review: { ...BASE_REVIEW, starRating: 3 }, internalReferenceUrl: null, internalNote: null, replyToEmail: null })
  assert(html.includes('★★★☆☆'), `expected exactly 3 filled stars for a 3-star review, got no match in html`)
}

function testNoInternalNoteOmitsTheSection() {
  const { html, text } = buildReviewEmail({ review: BASE_REVIEW, internalReferenceUrl: null, internalNote: null, replyToEmail: null })
  assert(!html.includes('Internal note from marketing'), 'no internal note section should render when none is provided')
  assert(!text.includes('Internal note from marketing'))
}

const tests = [
  ['default subject format matches "Response Requested — [Location] — [Rating]-Star Customer Review"', testDefaultSubjectFormat],
  ['HTML contains every required field', testHtmlContainsAllRequiredFields],
  ['plain-text fallback contains every required field and no HTML', testPlainTextFallbackContainsAllRequiredFields],
  ['reviewer name and review text are escaped in HTML', testHtmlEscapesReviewerNameAndReviewText],
  ['an internal note is escaped in HTML', testHtmlEscapesInternalNote],
  ['missing optional fields do not crash and never leak undefined/null', testMissingOptionalFieldsDoNotCrash],
  ['star rating renders the correct filled/empty star count', testStarRatingRendersCorrectFilledCount],
  ['no internal note omits that section entirely', testNoInternalNoteOmitsTheSection],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
