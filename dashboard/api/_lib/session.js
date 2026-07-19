// Session token signing/verification -- Edge AND Node runtime compatible.
// Uses `jose` (Web Crypto based) instead of hand-rolled HMAC so signing and
// verification are both handled by an audited library, not custom crypto.
//
// This module MUST stay free of anything that doesn't run at the Edge:
// no `fs`, no `bcryptjs`, no Node-only `crypto`, no Redis client. It is
// imported by both dashboard/middleware.js (Edge runtime) and every Node
// API handler via _lib/auth.js -- keeping it Edge-safe is what lets the
// same verification logic run in both places without duplication.
//
// Claims are intentionally minimal: userId, email, role, locationIds,
// issuedAt/expiresAt (handled by jose as iat/exp), and sessionVersion (lets
// _lib/auth.js invalidate every outstanding token for an account the moment
// its role/password/disabled state changes, by bumping the account's
// sessionVersion in the account directory -- a token signed against the old
// version is rejected even though its signature is still valid).

import { SignJWT, jwtVerify } from 'jose'

const ALG = 'HS256'

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

// claims: { userId, email, role, locationIds, sessionVersion }
export async function signSession(claims, { expiresInSeconds = 12 * 60 * 60 } = {}) {
  const secret = getSecret()
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    userId: claims.userId,
    email: claims.email,
    role: claims.role,
    locationIds: claims.locationIds,
    sessionVersion: claims.sessionVersion,
  })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(secret)
}

// Returns the verified claims, or null if the token is missing, malformed,
// expired, or incorrectly signed. Never throws -- callers always get a
// clear "no valid session" signal instead of having to catch.
export async function verifySession(token) {
  if (!token || typeof token !== 'string') return null
  try {
    const secret = getSecret()
    const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] })
    if (
      typeof payload.userId !== 'string' ||
      typeof payload.email !== 'string' ||
      typeof payload.role !== 'string' ||
      typeof payload.sessionVersion !== 'number'
    ) {
      return null
    }
    return {
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
      locationIds: payload.locationIds ?? '*',
      sessionVersion: payload.sessionVersion,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    }
  } catch {
    return null
  }
}

export const SESSION_COOKIE = 'lta_session'
