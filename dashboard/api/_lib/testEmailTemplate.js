// Server-side email template for Settings -> Restaurant Contacts' "Send
// Test Email" action (Phase 8, Milestone 8.9). Mirrors
// reviewEmailTemplate.js's escaping discipline (every value that could in
// principle come from user-entered contact/account data is escaped before
// HTML insertion) but is deliberately review-agnostic -- no review
// content, no star rating, no "Response Requested" framing. This is a
// connectivity/configuration test, not a real customer-facing message.

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function buildTestEmailSubject({ locationName }) {
  return `Test Email — ${locationName} — Pryor OS`
}

// `locationName`: the location this test is scoped to. `sentByName`: the
// authenticated account that triggered the send (never client-supplied --
// the caller passes account.displayName/email, already server-verified).
export function buildTestEmail({ locationName, sentByName, sentAt }) {
  const safeLocation = escapeHtml(locationName)
  const safeSentBy = escapeHtml(sentByName)
  const safeSentAt = escapeHtml(sentAt)

  const html = `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.6">
    <h2 style="margin-top:0">Test Email</h2>
    <p>This is a test email from the Pryor OS Restaurant Contacts settings page, confirming email delivery is configured correctly for <strong>${safeLocation}</strong>.</p>
    <p style="color:#78716c;font-size:13px">Sent by ${safeSentBy} at ${safeSentAt}. No action is needed — this message can be ignored or deleted.</p>
  </body></html>`

  const text = `Test Email

This is a test email from the Pryor OS Restaurant Contacts settings page, confirming email delivery is configured correctly for ${locationName}.

Sent by ${sentByName} at ${sentAt}. No action is needed -- this message can be ignored or deleted.`

  return { html, text }
}
