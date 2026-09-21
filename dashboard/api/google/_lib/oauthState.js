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

// claims: { nonce, tenantId, userId, clientKey }. `nonce` is the
// cryptographically random CSRF value (still generated fresh per flow by
// the caller, exactly as before this phase); `tenantId` and `userId` are
// the SERVER-verified identity of the account initiating the flow --
// callers must never pass anything derived from request input here (see
// google/[action].js's auth() handler, the only caller).
//
// Dual-client migration (Phase 5): `clientKey` is which Google OAuth
// client ('legacy-lta' or 'pryor-2026') this flow was started with --
// resolved SERVER-SIDE by auth() from GOOGLE_GBP_AUTH_CLIENT_KEY (see
// googleOAuthClients.js's resolveAuthClientKeyFromFlag()), never from
// anything browser-supplied. Signing it into this same HMAC-protected
// token (rather than, say, a second cookie) means callback() can trust it
// with the exact same integrity guarantee as tenantId/userId already
// have: tampering with it invalidates the whole signature, and it is
// bound to the SAME transaction as the nonce/tenant/user checks, so a
// state minted for one client can never be replayed to select the other.
//
// `clientKey` is OPTIONAL here (unlike nonce/tenantId/userId) -- auth()
// (the only production caller) always supplies it, but leaving it
// optional at this shared-utility level lets a state be signed WITHOUT
// it, faithfully modeling exactly what pre-migration code produced. This
// is deliberate, not an oversight: verifyOAuthState()'s "absent ->
// 'legacy-lta'" default exists specifically to handle a state signed this
// way, and tests that construct such a state (in-flight-state
// compatibility coverage) rely on being able to omit it here.
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
  if (claims.clientKey !== undefined && (typeof claims.clientKey !== 'string' || !claims.clientKey)) {
    throw new Error('signOAuthState: clientKey, if provided, must be a non-empty string')
  }
  const secret = getSecret()
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    purpose: PURPOSE,
    nonce: claims.nonce,
    tenantId: claims.tenantId,
    userId: claims.userId,
  }
  if (claims.clientKey !== undefined) payload.clientKey = claims.clientKey
  return new SignJWT(payload)
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(secret)
}

// Returns the verified claims { nonce, tenantId, userId, clientKey }, or
// null if the token is missing, malformed, expired, incorrectly signed,
// or not actually an OAuth-state token (wrong/missing `purpose`). Never
// throws -- mirrors session.js's verifySession() contract exactly, so
// every caller can treat null as the single "reject this callback" signal
// regardless of which specific thing was wrong with the token.
//
// Dual-client migration (Phase 5), IN-FLIGHT STATE COMPATIBILITY: a state
// signed by pre-migration code has no `clientKey` claim at all (the
// concept didn't exist yet) -- `payload.clientKey` is normalized to
// 'legacy-lta' here, exactly like credentialStore.js's identical default
// for a pre-migration STORED record, and for the identical reason: a
// state minted before this deploy could only ever have been built with
// the legacy client_id in its authorize URL (auth() had no other client
// to use), so treating its absence as 'legacy-lta' is the only value
// that is ever correct for that case, not a guess. This is deliberately
// NOT validated against the recognized-values list here -- an ABSENT
// claim is normalized before any recognition check runs; an explicit but
// unrecognized value is caught downstream by
// resolveGoogleOAuthClientCredentials() when the caller actually tries to
// use it, which fails closed rather than silently here.
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
    return {
      nonce: payload.nonce,
      tenantId: payload.tenantId,
      userId: payload.userId,
      clientKey: typeof payload.clientKey === 'string' && payload.clientKey ? payload.clientKey : 'legacy-lta',
    }
  } catch {
    // Covers every jose failure mode uniformly: bad signature (tampering),
    // expired (jose's own `exp` enforcement -- "JWTExpired"), malformed
    // token, wrong algorithm, etc. -- all fail closed the same way.
    return null
  }
}
