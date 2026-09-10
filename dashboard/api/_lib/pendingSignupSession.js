// Multi-Tenant Phase 4Q -- a SEPARATE, narrow-purpose signed token for the
// window between "email verified" and "real tenant + real session exist."
// session.js's signSession()/verifySession() are used by EVERY
// authenticated request in this app and HARD-REQUIRE a non-empty tenantId
// (by design -- see that file's own header). A verified registrant has no
// tenant yet, so this deliberately does NOT reuse or modify session.js at
// all -- it is a second, independent signing scheme, its own cookie name
// (lta_pending_signup, never SESSION_COOKIE/lta_session), and it is NEVER
// accepted by requireAuth()/evaluateSession() or anything else that gates
// real tenant data. Its only two consumers are the /get-started family of
// endpoints (session/[action].js) and nothing else.
//
// Reuses the same `jose` dependency session.js already uses (no new
// package), but a distinct signing key derivation (a fixed, distinct HKDF
// info string) so a token signed by one scheme can never verify under the
// other even if SESSION_SIGNING_SECRET were ever reused verbatim as this
// module's own secret.

import { SignJWT, jwtVerify } from 'jose'

const ALG = 'HS256'
const COOKIE_NAME = 'lta_pending_signup'
const TTL_SECONDS = 60 * 60 // 1 hour -- refreshed on every /get-started-family page load

function getSecret() {
  const secret = process.env.SESSION_SIGNING_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SIGNING_SECRET is not set (or is shorter than 32 characters).')
  }
  // Distinct from session.js's own key derivation -- see header comment.
  return new TextEncoder().encode(`pending-signup:${secret}`)
}

export const PENDING_SIGNUP_COOKIE = COOKIE_NAME
export const PENDING_SIGNUP_TTL_SECONDS = TTL_SECONDS

// claims: { userId, email }. Never carries a tenantId, role, or anything
// that could be mistaken for a real, tenant-scoped authorization claim.
export async function signPendingSignupToken({ userId, email }) {
  if (typeof userId !== 'string' || !userId) throw new Error('signPendingSignupToken: userId is required')
  if (typeof email !== 'string' || !email) throw new Error('signPendingSignupToken: email is required')
  const secret = getSecret()
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ userId, email })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + TTL_SECONDS)
    .sign(secret)
}

// Returns { userId, email } or null -- never throws, matching
// verifySession()'s own "no valid token" contract.
export async function verifyPendingSignupToken(token) {
  if (!token || typeof token !== 'string') return null
  try {
    const secret = getSecret()
    const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] })
    if (typeof payload.userId !== 'string' || typeof payload.email !== 'string') return null
    return { userId: payload.userId, email: payload.email }
  } catch {
    return null
  }
}
