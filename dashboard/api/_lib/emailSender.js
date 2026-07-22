// Direct, Vercel-side email delivery for the restaurant bad-review email
// workflow (recovery-audit milestone, Phase 3).
//
// ARCHITECTURE DECISION -- direct server-side delivery (nodemailer + Gmail
// SMTP), not a GitHub Actions workflow_dispatch:
//
//   The two options considered were (A) send synchronously from this
//   authenticated Vercel function, or (B) dispatch update-reviews.yml-style
//   GitHub Actions workflow that reuses the existing Python smtplib/Gmail
//   path. Option B is asynchronous by construction -- the endpoint would
//   have to return before the email is actually sent, which means either
//   marking the Action Center record "sent" the moment the workflow is
//   QUEUED (exactly the false-positive this milestone's own brief forbids:
//   "do not mark an email as sent merely because a workflow was queued"),
//   or building a second callback/polling mechanism for the workflow to
//   report real completion back -- new infrastructure with no clear
//   security model for an unauthenticated-by-default callback.
//
//   Option A returns a truthful, immediate result: the record is written
//   as 'sent' only after nodemailer's sendMail() actually succeeds against
//   Gmail's SMTP server, and as 'failed' (with the real error) if it
//   doesn't -- no queued/unknown state ever reaches the Action Center
//   record. This is the smallest-operational-risk choice per Phase 3's own
//   instruction to prefer direct delivery when async can't safely report
//   final status.
//
//   Tradeoff accepted: GMAIL_USER/GMAIL_APP_PASSWORD, today GitHub Actions
//   secrets only (confirmed absent from Vercel's env vars in the recovery
//   audit), must ALSO be added as Vercel project env vars before this
//   feature can send in production -- see README "Restaurant Bad-Review
//   Email Workflow" for the exact variable names required.

import nodemailer from 'nodemailer'

let transporter = null
// Test-only seam -- lets tests simulate a real transporter's sendMail()
// success/failure without a real Gmail account or network call, same
// pattern as actionStore.js's _setRedisClientForTests.
let testTransportFactory = null

export function _setTransportForTests(factory) { testTransportFactory = factory }
export function _resetTransportForTests() { testTransportFactory = null; transporter = null }

// Configuration missing entirely -- distinct from a real send failure (see
// sendReviewEmail below). Mapped to a 503 by the caller, and never touches
// the Action Center record (nothing was attempted).
export class EmailSenderUnavailableError extends Error {}

function hasGmailConfig() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
}

function getTransporter() {
  if (testTransportFactory) return testTransportFactory()
  if (!hasGmailConfig()) return null
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    })
  }
  return transporter
}

// Sends the review email. Throws EmailSenderUnavailableError if the
// subsystem isn't configured at all (caller should 503, no record written).
// Throws a PLAIN Error if sendMail() itself fails (bad recipient, SMTP
// auth/network error, etc.) -- the caller is expected to catch this
// separately and record a truthful 'failed' emailStatus with the message,
// rather than this module deciding that for every caller.
export async function sendReviewEmail({ to, cc, replyTo, subject, html, text }) {
  const t = getTransporter()
  if (!t) throw new EmailSenderUnavailableError('email sending is not configured (GMAIL_USER/GMAIL_APP_PASSWORD missing)')

  const info = await t.sendMail({
    from: `"LTA Review Dashboard" <${process.env.GMAIL_USER}>`,
    to,
    cc: cc && cc.length ? cc : undefined,
    replyTo,
    subject,
    html,
    text,
  })
  return { messageId: info.messageId }
}
