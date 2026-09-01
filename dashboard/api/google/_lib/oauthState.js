// OAuth state signing/verification for the Google Business Profile connect
// flow (Multi-Tenant Phase 4A). Replaces the previous bare random nonce
// (compared only against an httpOnly cookie) with a cryptographically
// signed, integrity-protected token that additionally BINDS the OAuth
// transaction to the tenant and user that initiated it -- so a callback
// can prove not just "this browser started this flow" (the cookie-based
// double-submit check in google/[action].js is still present, now
// comparing this signed value instead of a bare nonce) but "this flow was
// started BY this specific authenticated tenant/user, and has not been
// tampered with or replayed past its expiration."
//
// Deliberately reuses SESSION_SIGNING_SECRET (dashboard/api/_lib/
// session.js) rather than introducing a new secret -- Phase 4A is
// explicitly code-only and must not add or change environment variables.
// The `purpose` claim namespaces this token shape from a real session
// token so the two can never be confused with or substituted for each
// other even though they share a signing key: verifyOAuthState() rejects
// anything without purpose === 'gbp_oauth_connect', and verifySession()
// (session.js) has no knowledge of this claim at all.
//
// Never a plain base64-encoded JSON blob -- every claim is protected by
// an HMAC-SHA256 signature (HS256, via `jose`, the same library
// session.js already uses), so altering ANY field (the nonce, tenantId,
// or userId) invalidates the signature and verifyOAuthState() rejects the
// whole token outright, not just the tampered field.

import { SignJWT, jwtVerify } from 'jose'

const ALG = 'HS256'
const PURPOSE = 'gbp_oauth_connect'

function getSecret() {
  const secret = process.env.SESSION_SIGNING_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      'SESSION_SIGNING_SECRET is not set (or is shorter than 32 characters). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"'
    )
  }
  return new TextEncoder().encode(secret)
}

// claims: { nonce, tenantId, userId }. `nonce` is the cryptographically
// random CSRF value (still generated fresh per flow by the caller, exactly
// as before this phase); `tenantId` and `userId` are the SERVER-verified
// identity of the account initiating the flow -- callers must never pass
// anything derived from request input here (see google/[action].js's
// auth() handler, the only caller).
export async function signOAuthState(claims, { expiresInSeconds = 600 } = {}) {
  if (typeof claims.nonce !== 'string' || !claims.nonce) {
    throw new Error('signOAuthState: nonce is required and must be a non-empty string')
  }
  if (typeof claims.tenantId !== 'string' || !claims.tenantId) {
    throw new Error('signOAuthState: tenantId is required and must be a non-empty string')
  }
  if (typeof claims.userId !== 'string' || !claims.userId) {
    throw new Error('signOAuthState: userId is required and must be a non-empty string')
  }
  const secret = getSecret()
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    purpose: PURPOSE,
    nonce: claims.nonce,
    tenantId: claims.tenantId,
    userId: claims.userId,
  })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(secret)
}

// Returns the verified claims { nonce, tenantId, userId }, or null if the
// token is missing, malformed, expired, incorrectly signed, or not
// actually an OAuth-state token (wrong/missing `purpose`). Never throws --
// mirrors session.js's verifySession() contract exactly, so every caller
// can treat null as the single "reject this callback" signal regardless
// of which specific thing was wrong with the token.
export async function verifyOAuthState(token) {
  if (!token || typeof token !== 'string') return null
  try {
    const secret = getSecret()
    const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] })
    if (
      payload.purpose !== PURPOSE ||
      typeof payload.nonce !== 'string' || !payload.nonce ||
      typeof payload.tenantId !== 'string' || !payload.tenantId ||
      typeof payload.userId !== 'string' || !payload.userId
    ) {
      return null
    }
    return { nonce: payload.nonce, tenantId: payload.tenantId, userId: payload.userId }
  } catch {
    // Covers every jose failure mode uniformly: bad signature (tampering),
    // expired (jose's own `exp` enforcement -- "JWTExpired"), malformed
    // token, wrong algorithm, etc. -- all fail closed the same way.
    return null
  }
}
