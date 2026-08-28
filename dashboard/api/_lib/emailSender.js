// Direct, Vercel-side email delivery for the restaurant bad-review email
// workflow (recovery-audit milestone, Phase 3). Provider-neutral SMTP
// configuration -- read from generic SMTP_* env vars, not tied to any one
// mailbox provider. The sending mailbox is a Microsoft 365/Outlook account
// (advertising@l3amigos.com), authenticated via SMTP AUTH over STARTTLS
// (smtp.office365.com:587) -- see "Microsoft 365 SMTP AUTH" below for the
// tenant-side prerequisite this depends on. Nothing here assumes Microsoft
// 365 specifically beyond the env var *values* configured for it; a
// different provider (any mailbox or transactional service with SMTP
// support) only requires different SMTP_* values, no code change.
//
// ARCHITECTURE DECISION -- direct server-side delivery, not a GitHub
// Actions workflow_dispatch:
//
//   The two options considered were (A) send synchronously from this
//   authenticated Vercel function, or (B) dispatch update-reviews.yml-style
//   GitHub Actions workflow that reuses the existing Python smtplib path
//   (which authenticates to an entirely separate mailbox used only by the
//   internal alert scripts -- notify.py/nightly_digest.py/etc. -- unrelated
//   to this feature's Microsoft 365 sending mailbox and its own SMTP_*
//   configuration). Option B is
//   asynchronous by construction -- the endpoint would have to return
//   before the email is actually sent, which means either marking the
//   Action Center record "sent" the moment the workflow is QUEUED (exactly
//   the false-positive this milestone's own brief forbids: "do not mark an
//   email as sent merely because a workflow was queued"), or building a
//   second callback/polling mechanism for the workflow to report real
//   completion back -- new infrastructure with no clear security model for
//   an unauthenticated-by-default callback.
//
//   Option A returns a truthful, immediate result: the record is written
//   as 'sent' only after nodemailer's sendMail() actually succeeds against
//   the configured SMTP server, and as 'failed' (with a sanitized error) if
//   it doesn't -- no queued/unknown state ever reaches the Action Center
//   record. This is the smallest-operational-risk choice per Phase 3's own
//   instruction to prefer direct delivery when async can't safely report
//   final status.
//
//   Tradeoff accepted: SMTP_HOST/SMTP_USER/SMTP_PASSWORD (and optionally
//   SMTP_PORT/SMTP_SECURE/SMTP_FROM_NAME) must be added as Vercel project
//   env vars before this feature can send in production -- see README
//   "Restaurant Bad-Review Email Workflow" for the exact variable names.
//
// Microsoft 365 SMTP AUTH: this mailbox's tenant may have Authenticated
// SMTP disabled by default (a Microsoft 365 security default, independent
// of the mailbox password being correct). If sends fail authentication
// consistently, verify in the Microsoft 365 Admin Center: Users -> Active
// users -> advertising@l3amigos.com -> Mail -> "Manage email apps" ->
// confirm "Authenticated SMTP" is enabled for this specific mailbox. If the
// tenant blocks password-based SMTP AUTH organization-wide and that policy
// cannot or should not be relaxed, this module's password-based approach
// is not viable -- Microsoft OAuth2 (Nodemailer's XOAUTH2) or the Microsoft
// Graph sendMail API would be the correct next step, not repeatedly
// retrying credentials.

import nodemailer from 'nodemailer'
import { hasGraphConfig, sendGraphMail } from './graphMailSender.js'

const DEFAULT_FROM_NAME = 'LTA Review Dashboard'
const DEFAULT_PORT = 587

// Provider switch (Microsoft Graph migration) -- MAIL_PROVIDER=graph opts
// in explicitly; anything else (unset, 'smtp', a typo) keeps the existing
// SMTP behavior so deployment stays non-breaking until this is flipped on
// purpose in Vercel. There is deliberately no automatic fallback from graph
// to smtp on a Graph failure -- once graph is explicitly selected, a Graph
// failure must be visible, not silently masked by a second delivery
// attempt through a different provider.
export function getMailProvider() {
  return (process.env.MAIL_PROVIDER || '').trim().toLowerCase() === 'graph' ? 'graph' : 'smtp'
}

let transporter = null
// Test-only seam -- lets tests simulate a real transporter's sendMail()
// success/failure without a real mailbox or network call, same pattern as
// actionStore.js's _setRedisClientForTests.
let testTransportFactory = null

export function _setTransportForTests(factory) { testTransportFactory = factory }
export function _resetTransportForTests() { transporter = null; testTransportFactory = null }

// Configuration missing entirely -- distinct from a real send failure (see
// sendReviewEmail below). Mapped to a 503 by the caller, and never touches
// the Action Center record (nothing was attempted).
export class EmailSenderUnavailableError extends Error {}

// SMTP_PORT is nominally required config (documented alongside
// HOST/USER/PASSWORD), but is never independently a reason to 503 --
// getTransporter() below always resolves it via Number(SMTP_PORT) ||
// DEFAULT_PORT (587), so an unset port is never "not configured", it's
// "using the correct default for STARTTLS". SMTP_SECURE is genuinely
// optional (defaults to STARTTLS/false). HOST/USER/PASSWORD have no such
// safe default -- their absence really does mean "this environment can't
// send email at all yet".
// Exported (Phase 8, Milestone 8.9) so Settings -> Email can report whether
// SMTP is configured without duplicating this env-var check or probing a
// real connection on every page load -- a live login attempt only ever
// happens when a real send is actually requested (a real review email, or
// an explicit Send Test Email click), never as a passive status read.
export function hasSmtpConfig() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD)
}

// The outgoing email's display name (e.g. "Lenin | Los Tres Amigos
// Marketing" <SMTP_USER>) -- purely cosmetic, always has a safe default,
// never blocks sending. Strips quotes/CR/LF defensively before use in an
// email header, even though this value only ever comes from a trusted
// Vercel env var, never client input.
function getFromName() {
  const configured = (process.env.SMTP_FROM_NAME || '').replace(/["\r\n]/g, '').trim()
  return configured || DEFAULT_FROM_NAME
}

// Pure -- builds the exact config object passed to nodemailer.createTransport(),
// without constructing a real transporter. Exported so tests can verify
// port parsing / STARTTLS-vs-implicit-TLS selection / host wiring directly,
// without needing to intercept nodemailer itself.
//
//   secure: true means implicit TLS from connection start (port 465, most
//   providers other than Microsoft 365/many enterprise mailboxes).
//   secure: false + requireTLS: true means STARTTLS on a plaintext-first
//   connection (port 587, Microsoft 365's smtp.office365.com) -- refusing
//   to send at all if the server doesn't upgrade to TLS, rather than
//   silently falling back to an unencrypted session. requireTLS is tied to
//   the inverse of `secure` so a hypothetical future implicit-TLS provider
//   (SMTP_SECURE=true) doesn't redundantly/incorrectly demand a STARTTLS
//   upgrade on a connection that's already fully encrypted.
export function buildTransportConfig() {
  const secure = process.env.SMTP_SECURE === 'true'
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || DEFAULT_PORT,
    secure,
    requireTLS: !secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    // Never weaken certificate validation -- no tls.rejectUnauthorized
    // override here, intentionally.
  }
}

function getTransporter() {
  if (testTransportFactory) return testTransportFactory()
  if (!hasSmtpConfig()) return null
  if (!transporter) {
    transporter = nodemailer.createTransport(buildTransportConfig())
  }
  return transporter
}

// Sends the review email. Throws EmailSenderUnavailableError if the
// subsystem isn't configured at all (caller should 503, no record written).
// Throws a PLAIN Error if sendMail() itself fails (bad recipient, SMTP
// auth/network error, etc.) -- the caller is expected to catch this
// separately, sanitize it, and record a truthful 'failed' emailStatus,
// rather than this module deciding that for every caller. This module
// itself never logs the raw error or any credential.
export async function sendReviewEmail({ to, cc, replyTo, subject, html, text }) {
  if (getMailProvider() === 'graph') {
    if (!hasGraphConfig()) throw new EmailSenderUnavailableError('Email service configuration error: Microsoft Graph is not configured (MICROSOFT_TENANT_ID/MICROSOFT_CLIENT_ID/MICROSOFT_CLIENT_SECRET/MAIL_FROM_ADDRESS missing).')
    return sendGraphMail({ to, cc, replyTo, subject, html, text })
  }

  const t = getTransporter()
  if (!t) throw new EmailSenderUnavailableError('Email service configuration error: SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASSWORD missing).')

  const info = await t.sendMail({
    from: `"${getFromName()}" <${process.env.SMTP_USER}>`,
    to,
    cc: cc && cc.length ? cc : undefined,
    replyTo,
    subject,
    html,
    text,
  })
  // `response` is nodemailer's raw SMTP server response line (e.g.
  // "250 2.0.0 OK ..."), additive -- existing callers destructuring only
  // { messageId } are unaffected. Surfaced by Settings -> Restaurant
  // Contacts' "Send Test Email" action (Milestone 8.9).
  return { messageId: info.messageId, response: info.response ?? null }
}
