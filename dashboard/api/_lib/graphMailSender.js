// Microsoft Graph email delivery -- the OAuth2 client-credentials
// counterpart to emailSender.js's SMTP transport, selected via
// MAIL_PROVIDER=graph (see emailSender.js). Authenticates server-side only
// (client_id/client_secret, never exposed to browser code), gets a token
// scoped to https://graph.microsoft.com/.default, and sends through
// POST /v1.0/users/{MAIL_FROM_ADDRESS}/sendMail -- not raw MIME, not the
// full Graph SDK (a plain fetch call is enough for one endpoint plus one
// token exchange, matching the fetch-based pattern already used for
// Google's OAuth2 token exchange in dashboard/api/google/[action].js).
//
// The Exchange-side mailbox restriction (this app's Entra app registration
// may only send as advertising@l3amigos.com, enforced via Exchange RBAC for
// Applications) is a tenant-side control this module has no part in and
// must not try to route around -- MAIL_FROM_ADDRESS is simply the mailbox
// this code asks Graph to send through; if the tenant ever rejects that
// mailbox, sendGraphMail() surfaces the resulting Graph error rather than
// retrying against a different address.

const TOKEN_ENDPOINT_BASE = 'https://login.microsoftonline.com'
const GRAPH_SEND_MAIL_BASE = 'https://graph.microsoft.com/v1.0/users'
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default'
// Refresh a little before actual expiry so a send that starts right at the
// boundary doesn't race a token Microsoft is about to consider expired.
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000

let cachedToken = null // { accessToken, expiresAt }
// Test-only seam -- same role as emailSender.js's _setTransportForTests,
// but for fetch rather than a nodemailer transporter. Falls back to the
// ambient global fetch, the same override point the Google OAuth tests
// already use (see tests/test_google_oauth_auto_recovery.js).
let testFetch = null

export function _setFetchForTests(fn) { testFetch = fn }
export function _resetGraphMailForTests() { cachedToken = null; testFetch = null }

function getFetch() {
  return testFetch || globalThis.fetch
}

// Distinct from emailSender.js's EmailSenderUnavailableError -- that class
// means "not configured at all" (mapped to a 503, nothing attempted). This
// one means "a Graph request was actually attempted and Microsoft rejected
// it" -- status/code are captured for callers that want to log/branch on
// them, but the message is always pre-sanitized (see sanitizeGraphMessage
// below), never containing a token or the client secret.
export class GraphMailError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message)
    this.name = 'GraphMailError'
    this.status = status
    this.code = code
  }
}

export function hasGraphConfig() {
  return Boolean(
    process.env.MICROSOFT_TENANT_ID
    && process.env.MICROSOFT_CLIENT_ID
    && process.env.MICROSOFT_CLIENT_SECRET
    && process.env.MAIL_FROM_ADDRESS,
  )
}

// Defensive redaction of the one secret value this module ever handles.
// Microsoft's own error payloads don't normally echo the client secret
// back, but this strips it if it ever appeared, the same "belt and
// suspenders" spirit as emailSender.js's own credential-safety tests.
function sanitizeGraphMessage(message) {
  if (!message) return null
  let out = String(message)
  const secret = process.env.MICROSOFT_CLIENT_SECRET
  if (secret) out = out.split(secret).join('[redacted]')
  return out
}

async function fetchAccessToken() {
  const tenantId = process.env.MICROSOFT_TENANT_ID
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    scope: GRAPH_SCOPE,
    grant_type: 'client_credentials',
  })

  let res
  try {
    res = await getFetch()(`${TOKEN_ENDPOINT_BASE}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
  } catch {
    throw new GraphMailError('Microsoft Graph authentication failed: network error contacting the Microsoft identity platform.', { code: 'network_error' })
  }

  let payload = null
  try { payload = await res.json() } catch { payload = null }

  if (!res.ok || !payload?.access_token) {
    const code = payload?.error || `http_${res.status}`
    const description = sanitizeGraphMessage(payload?.error_description) || 'the Microsoft identity platform rejected the client-credentials request.'
    throw new GraphMailError(`Microsoft Graph authentication failed (${code}): ${description}`, { status: res.status, code })
  }

  const expiresInSeconds = Number(payload.expires_in) || 3600
  cachedToken = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + (expiresInSeconds * 1000) - TOKEN_EXPIRY_SAFETY_MARGIN_MS,
  }
  return cachedToken.accessToken
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.accessToken
  return fetchAccessToken()
}

// Accepts a single address string or an array of them (current callers use
// both shapes -- e.g. `to: contact.email` vs `cc: contact.ccEmails`) and
// returns Graph's emailAddress-object array shape, or undefined for an
// absent/empty value so optional recipient fields are omitted entirely
// rather than sent as `[]` (same convention as emailSender.js's SMTP path).
function toRecipientList(value) {
  if (!value) return undefined
  const list = Array.isArray(value) ? value : [value]
  const addresses = list.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean)
  if (!addresses.length) return undefined
  return addresses.map(address => ({ emailAddress: { address } }))
}

function getFromName() {
  return (process.env.MAIL_FROM_NAME || '').replace(/["\r\n]/g, '').trim()
}

// Sends via Microsoft Graph. Mirrors emailSender.js's sendReviewEmail
// contract: throws GraphMailError on any failed request (auth or send) --
// the caller (emailSender.js) is responsible for deciding "not configured"
// vs "attempted and failed", same division of labor as the SMTP path.
export async function sendGraphMail({ to, cc, replyTo, subject, html }) {
  const toRecipients = toRecipientList(to)
  if (!toRecipients) {
    throw new GraphMailError('sendGraphMail requires at least one "to" recipient.', { code: 'invalid_recipient' })
  }

  const message = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients,
  }
  const ccRecipients = toRecipientList(cc)
  if (ccRecipients) message.ccRecipients = ccRecipients
  const replyToRecipients = toRecipientList(replyTo)
  if (replyToRecipients) message.replyTo = replyToRecipients
  const fromName = getFromName()
  if (fromName) message.from = { emailAddress: { name: fromName, address: process.env.MAIL_FROM_ADDRESS } }

  const accessToken = await getAccessToken()
  const mailbox = encodeURIComponent(process.env.MAIL_FROM_ADDRESS)

  let res
  try {
    res = await getFetch()(`${GRAPH_SEND_MAIL_BASE}/${mailbox}/sendMail`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    })
  } catch {
    throw new GraphMailError('Microsoft Graph sendMail request failed: network error contacting Microsoft Graph.', { code: 'network_error' })
  }

  // Graph's sendMail returns 202 Accepted with an empty body on success --
  // there is no messageId to hand back (unlike SMTP's nodemailer info).
  if (res.status === 202) {
    return { messageId: null, response: 'Accepted' }
  }

  let payload = null
  try { payload = await res.json() } catch { payload = null }
  const code = payload?.error?.code || `http_${res.status}`
  const description = sanitizeGraphMessage(payload?.error?.message) || 'Microsoft Graph rejected the sendMail request.'
  throw new GraphMailError(`Microsoft Graph sendMail failed (${code}): ${description}`, { status: res.status, code })
}
