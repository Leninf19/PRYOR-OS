// Google Sign-In (PRYOR login identity) -- state/context signing for the
// browser-redirect authorization-code flow. Deliberately SEPARATE from
// google/_lib/oauthState.js (the Google Business Profile connect flow's own
// state signer): that module requires an already-authenticated
// tenantId/userId (GBP connect only ever runs for a signed-in Owner), while
// THIS flow must also work for a completely unauthenticated visitor
// (registering for the first time) -- the claim shapes are structurally
// different, so this is a new, purpose-namespaced token family rather than
// a generalization of the existing one.
//
// Reuses SESSION_SIGNING_SECRET (same as oauthState.js/session.js/
// pendingSignupSession.js) -- no new secret is introduced. Every claim set
// below carries its OWN `purpose` value so none of these token families can
// ever be substituted for one another even though they share a signing key.
//
// TWO token shapes live here, both HS256-signed via `jose`:
//
//   1. "flow" (purpose: 'pryor_login_flow') -- created by
//      googleLoginStart(), carried in a short-lived HttpOnly cookie
//      (never in the browser-visible OAuth `state` query param, which only
//      ever carries a bare random nonce for double-submit comparison).
//      Holds: { nonce, returnTo, inviteToken, linkUserId, linkTenantId }.
//      `inviteToken` is a bearer credential (whoever holds it can accept
//      that invite) -- it must NEVER travel through a URL that leaves this
//      server's own redirect chain to a third party (Google), which is
//      exactly why it lives here and not in the `state` param. `linkUserId`/
//      `linkTenantId` are populated ONLY from the caller's own already-
//      verified session at flow-start time (see googleLoginStart()) --
//      never client-suppliable.
//
//   2. "signup-pending" (purpose: 'pryor_google_signup_pending') -- created
//      by googleLoginCallback() the moment a BRAND NEW Google identity is
//      verified but PRYOR still needs one more field (company/restaurant
//      name) Google's identity scope never provides. Holds the ALREADY-
//      VERIFIED identity ({ providerSubject, providerEmail, name }) in a
//      signed, HttpOnly cookie for the single extra step
//      (google-signup-complete) -- this is not yet a registration attempt
//      (nothing is written to Redis until that step runs), so it does not
//      belong in pendingRegistrationStore.js.

import { SignJWT, jwtVerify } from 'jose'

const ALG = 'HS256'
const FLOW_PURPOSE = 'pryor_login_flow'
const SIGNUP_PENDING_PURPOSE = 'pryor_google_signup_pending'

export const GOOGLE_LOGIN_STATE_COOKIE = 'lta_google_login_state'
export const GOOGLE_LOGIN_STATE_TTL_SECONDS = 600 // 10 minutes -- matches oauthState.js's own GBP-connect TTL
export const GOOGLE_SIGNUP_PENDING_COOKIE = 'lta_google_signup_pending'
export const GOOGLE_SIGNUP_PENDING_TTL_SECONDS = 30 * 60 // 30 minutes -- enough time to type a company name, not so long a stolen cookie stays useful

function getSecret() {
  const secret = process.env.SESSION_SIGNING_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SIGNING_SECRET is not set (or is shorter than 32 characters).')
  }
  return new TextEncoder().encode(secret)
}

export async function signGoogleLoginState(claims, { expiresInSeconds = GOOGLE_LOGIN_STATE_TTL_SECONDS } = {}) {
  if (typeof claims.nonce !== 'string' || !claims.nonce) {
    throw new Error('signGoogleLoginState: nonce is required')
  }
  const secret = getSecret()
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    purpose: FLOW_PURPOSE,
    nonce: claims.nonce,
    returnTo: typeof claims.returnTo === 'string' ? claims.returnTo : '/',
    inviteToken: typeof claims.inviteToken === 'string' ? claims.inviteToken : null,
    linkUserId: typeof claims.linkUserId === 'string' ? claims.linkUserId : null,
    linkTenantId: typeof claims.linkTenantId === 'string' ? claims.linkTenantId : null,
  })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(secret)
}

// Returns { nonce, returnTo, inviteToken, linkUserId, linkTenantId } or
// null on any failure (missing/expired/malformed/wrong purpose) -- never
// throws, mirrors verifySession()/verifyOAuthState()'s contract exactly.
export async function verifyGoogleLoginState(token) {
  if (!token || typeof token !== 'string') return null
  try {
    const secret = getSecret()
    const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] })
    if (payload.purpose !== FLOW_PURPOSE || typeof payload.nonce !== 'string' || !payload.nonce) return null
    return {
      nonce: payload.nonce,
      returnTo: typeof payload.returnTo === 'string' ? payload.returnTo : '/',
      inviteToken: typeof payload.inviteToken === 'string' ? payload.inviteToken : null,
      linkUserId: typeof payload.linkUserId === 'string' ? payload.linkUserId : null,
      linkTenantId: typeof payload.linkTenantId === 'string' ? payload.linkTenantId : null,
    }
  } catch {
    return null
  }
}

export async function signGoogleSignupPending(claims, { expiresInSeconds = GOOGLE_SIGNUP_PENDING_TTL_SECONDS } = {}) {
  if (typeof claims.providerSubject !== 'string' || !claims.providerSubject) {
    throw new Error('signGoogleSignupPending: providerSubject is required')
  }
  if (typeof claims.providerEmail !== 'string' || !claims.providerEmail) {
    throw new Error('signGoogleSignupPending: providerEmail is required')
  }
  const secret = getSecret()
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    purpose: SIGNUP_PENDING_PURPOSE,
    providerSubject: claims.providerSubject,
    providerEmail: claims.providerEmail,
    name: typeof claims.name === 'string' ? claims.name : null,
  })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(secret)
}

export async function verifyGoogleSignupPending(token) {
  if (!token || typeof token !== 'string') return null
  try {
    const secret = getSecret()
    const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] })
    if (
      payload.purpose !== SIGNUP_PENDING_PURPOSE ||
      typeof payload.providerSubject !== 'string' || !payload.providerSubject ||
      typeof payload.providerEmail !== 'string' || !payload.providerEmail
    ) return null
    return {
      providerSubject: payload.providerSubject,
      providerEmail: payload.providerEmail,
      name: typeof payload.name === 'string' ? payload.name : null,
    }
  } catch {
    return null
  }
}
