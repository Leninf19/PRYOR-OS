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

// Same shape as dashboard/api/_lib/accounts.js's account-email validation.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// A malformed entry is dropped (with a clear server-side log line), not a
// reason to fail the whole CC list closed -- CC is a best-effort
// risk-reduction measure, not the security boundary this feature depends
// on (recipient resolution is), so one bad entry in the env var must not
// block marketing from reaching the restaurant at all.
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
