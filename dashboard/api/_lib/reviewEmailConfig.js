// Server-side-only configuration for the restaurant bad-review email
// workflow's CC/Reply-To behavior (recovery-audit milestone). Deliberately
// separate from ACCOUNT_DIRECTORY_JSON -- who gets CC'd on an outbound
// restaurant email is a distinct policy decision from who can log in, and
// must not silently change if an account's login email is ever edited for
// unrelated reasons. Never read from, or influenced by, client input --
// dashboard/api/actions/[action].js calls these, the browser never does.

// Matches TO_ADDR across every existing Python alert script (notify.py,
// nightly_digest.py, critical_alert_check.py, weekly_report.py,
// health_check.py) -- the same marketing inbox restaurant replies should
// land in by default when REVIEW_REPLY_TO_EMAIL isn't set.
const DEFAULT_REPLY_TO = 'advertising@l3amigos.com'

// Deliberately NOT defaulted, unlike DEFAULT_REPLY_TO/DEFAULT_FROM_NAME
// below -- management visibility (Martin/Ruffy) on every restaurant
// escalation is a business requirement, not a nicety with a safe fallback.
// dashboard/api/actions/[action].js's send/preview actions must refuse to
// proceed (503) when getEscalationCcEmails() resolves to an empty list,
// rather than silently sending with no CC.
const DEFAULT_FROM_NAME = 'LTA Review Dashboard'

// Same shape as dashboard/api/_lib/accounts.js's account-email validation.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// An individual malformed entry within an otherwise-valid list is dropped
// (with a clear server-side log line), not a reason to fail the whole list
// -- but the caller (dashboard/api/actions/[action].js) still treats a
// resulting EMPTY list (env var unset, or every entry malformed) as
// "escalation recipients are not configured" and refuses to send at all --
// see the header comment above.
function parseEmailList(raw) {
  if (!raw) return []
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(email => {
      const ok = EMAIL_RE.test(email)
      if (!ok) console.error(`[reviewEmailConfig] ignoring malformed REVIEW_ESCALATION_CC_EMAILS entry: ${email}`)
      return ok
    })
}

export function getEscalationCcEmails() {
  return parseEmailList(process.env.REVIEW_ESCALATION_CC_EMAILS)
}

export function getReplyToEmail() {
  const configured = (process.env.REVIEW_REPLY_TO_EMAIL || '').trim()
  if (configured && !EMAIL_RE.test(configured)) {
    console.error('[reviewEmailConfig] REVIEW_REPLY_TO_EMAIL is set but malformed -- falling back to the default marketing inbox')
    return DEFAULT_REPLY_TO
  }
  return configured || DEFAULT_REPLY_TO
}

// The outgoing email's display name (e.g. "Los Tres Amigos Marketing Team"
// <gmail-address>) -- purely cosmetic, always has a safe default, and
// never blocks sending. Strips quotes/CR/LF defensively before use in an
// email header, even though this value only ever comes from a trusted
// Vercel env var, never client input.
export function getFromName() {
  const configured = (process.env.REVIEW_FROM_NAME || '').replace(/["\r\n]/g, '').trim()
  return configured || DEFAULT_FROM_NAME
}
