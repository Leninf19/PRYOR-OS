// Server-side email template for the restaurant bad-review email workflow
// (recovery-audit milestone, Phase 4). Builds both an HTML and a
// plain-text version from the same input -- every customer-provided field
// (reviewer name, review text) is escaped before insertion into the HTML
// body; the plain-text version needs no escaping since it's never
// interpreted as markup.
//
// This pipeline is Google-only today (see README "Data pipeline") -- the
// review platform/source is always "Google", not a field derived from
// review content.

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function buildDefaultSubject({ locationName, starRating }) {
  return `Response Requested — ${locationName} — ${starRating}-Star Customer Review`
}

// `review`: { locationName, city, starRating, reviewerName, reviewDate,
//             reviewText, reviewUrl }. `internalReferenceUrl`: an absolute
// link back to the dashboard (built by the caller from DASHBOARD_BASE_URL
// -- see actions/[action].js), or null if no base URL is configured.
// `internalNote`: optional marketing-authored note, also escaped.
export function buildReviewEmail({ review, internalReferenceUrl, internalNote, replyToEmail }) {
  const {
    locationName, city, starRating, reviewerName, reviewDate, reviewText, reviewUrl,
  } = review

  const stars = '★'.repeat(Math.max(0, Math.min(5, starRating))) + '☆'.repeat(5 - Math.max(0, Math.min(5, starRating)))

  const questionsHtml = [
    'What happened?',
    'Do you recognize this situation?',
    'What corrective action has been taken?',
    'What response do you recommend sending to the customer?',
  ]
  const questionsText = questionsHtml

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; max-width: 640px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 4px;">Response Requested — Customer Review</h2>
  <p style="margin: 0 0 20px; color: #555;">A customer left a review that needs your team's attention.</p>

  <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
    <tr><td style="padding: 4px 0; color: #555; width: 140px;">Location</td><td style="padding: 4px 0;"><strong>${escapeHtml(locationName)}</strong>${city ? ` (${escapeHtml(city)})` : ''}</td></tr>
    <tr><td style="padding: 4px 0; color: #555;">Rating</td><td style="padding: 4px 0;">${stars} (${escapeHtml(starRating)}/5)</td></tr>
    <tr><td style="padding: 4px 0; color: #555;">Reviewer</td><td style="padding: 4px 0;">${escapeHtml(reviewerName || 'Anonymous')}</td></tr>
    <tr><td style="padding: 4px 0; color: #555;">Date</td><td style="padding: 4px 0;">${escapeHtml(reviewDate || 'Unknown')}</td></tr>
    <tr><td style="padding: 4px 0; color: #555;">Source</td><td style="padding: 4px 0;">Google</td></tr>
    ${reviewUrl ? `<tr><td style="padding: 4px 0; color: #555;">Review link</td><td style="padding: 4px 0;"><a href="${escapeHtml(reviewUrl)}">View on Google</a></td></tr>` : ''}
    ${internalReferenceUrl ? `<tr><td style="padding: 4px 0; color: #555;">Internal reference</td><td style="padding: 4px 0;"><a href="${escapeHtml(internalReferenceUrl)}">Open in dashboard</a></td></tr>` : ''}
  </table>

  <div style="background: #f7f7f7; border-left: 4px solid #c62828; padding: 12px 16px; margin-bottom: 20px;">
    <p style="margin: 0; white-space: pre-wrap;">${escapeHtml(reviewText || '(no text provided)')}</p>
  </div>

  ${internalNote ? `<div style="background: #fff8e1; border-left: 4px solid #f9a825; padding: 12px 16px; margin-bottom: 20px;">
    <p style="margin: 0 0 4px; font-weight: bold; font-size: 12px; text-transform: uppercase; color: #8a6d00;">Internal note from marketing</p>
    <p style="margin: 0; white-space: pre-wrap;">${escapeHtml(internalNote)}</p>
  </div>` : ''}

  <p style="margin: 0 0 8px;">Please reply to this email with:</p>
  <ol style="margin: 0 0 20px; padding-left: 20px;">
    ${questionsHtml.map(q => `<li style="margin-bottom: 4px;">${escapeHtml(q)}</li>`).join('\n    ')}
  </ol>

  <p style="margin: 0 0 4px; color: #555; font-size: 13px;">
    You can reply directly to this email${replyToEmail ? ` (${escapeHtml(replyToEmail)})` : ''} -- no dashboard access is required.
  </p>
</body></html>`

  const text = [
    'Response Requested — Customer Review',
    '',
    `Location: ${locationName}${city ? ` (${city})` : ''}`,
    `Rating: ${stars} (${starRating}/5)`,
    `Reviewer: ${reviewerName || 'Anonymous'}`,
    `Date: ${reviewDate || 'Unknown'}`,
    'Source: Google',
    reviewUrl ? `Review link: ${reviewUrl}` : null,
    internalReferenceUrl ? `Internal reference: ${internalReferenceUrl}` : null,
    '',
    'Review:',
    reviewText || '(no text provided)',
    '',
    internalNote ? `Internal note from marketing:\n${internalNote}\n` : null,
    'Please reply to this email with:',
    ...questionsText.map((q, i) => `  ${i + 1}. ${q}`),
    '',
    `You can reply directly to this email${replyToEmail ? ` (${replyToEmail})` : ''} -- no dashboard access is required.`,
  ].filter(line => line !== null).join('\n')

  return { html, text }
}
