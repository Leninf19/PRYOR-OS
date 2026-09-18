// Google Sign-In (PRYOR login identity) -- OAuth mechanics for the LOGIN
// client only. Deliberately a SEPARATE module from googleAuth.js (Google
// Business Profile's own token-refresh helper) and from the inline fetch
// calls in google/[action].js's callback() -- those use GOOGLE_CLIENT_ID/
// GOOGLE_CLIENT_SECRET (the GBP OAuth client, scoped to
// business.manage) and must never be reachable from this file, structurally
// as well as by convention: this file reads ONLY
// GOOGLE_AUTH_CLIENT_ID/GOOGLE_AUTH_CLIENT_SECRET, two names that do not
// appear anywhere else in the codebase.
//
// Scope requested is identity-only: openid email profile. Never
// business.manage, never anything GBP-shaped -- see session/[action].js's
// googleLoginStart() header for why the two systems must never be
// conflated.
//
// ID token verification uses Google's own published JWKS
// (https://www.googleapis.com/oauth2/v3/certs) via `jose`'s
// createRemoteJWKSet() -- never a hand-rolled base64 decode of the token
// body, which would skip signature verification entirely. Issuer and
// audience are both checked; a token whose `aud` does not match THIS
// login client's own ID is rejected outright (protects against a token
// minted for some other Google OAuth client anywhere -- including the GBP
// client in this same Google Cloud project -- ever being accepted here).

import { createRemoteJWKSet, jwtVerify } from 'jose'

// Test seam, same convention as blobStore.js's _setBlobClientForTests()/
// credentialStore.js's Redis-client seams -- lets tests substitute
// exchangeGoogleAuthCode()/verifyGoogleIdToken() with fakes rather than
// hitting Google's real token endpoint and JWKS over the network. Never
// used outside tests/*.js.
let testOverrides = null
export function _setGoogleAuthClientForTests(overrides) { testOverrides = overrides }
export function _resetGoogleAuthClientForTests() { testOverrides = null }

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const SCOPE = 'openid email profile'
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

let jwks = null
function getJwks() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(JWKS_URL))
  return jwks
}

export class GoogleLoginNotConfiguredError extends Error {}

export function requireGoogleAuthClientId() {
  const clientId = process.env.GOOGLE_AUTH_CLIENT_ID
  if (!clientId) throw new GoogleLoginNotConfiguredError('GOOGLE_AUTH_CLIENT_ID is not configured')
  return clientId
}

function requireGoogleAuthClientSecret() {
  const clientSecret = process.env.GOOGLE_AUTH_CLIENT_SECRET
  if (!clientSecret) throw new GoogleLoginNotConfiguredError('GOOGLE_AUTH_CLIENT_SECRET is not configured')
  return clientSecret
}

// `state` is always the caller's own bare random nonce (see
// googleLoginState.js's header for why the real, sensitive flow context
// never travels here) -- never anything else. `access_type` is
// deliberately omitted (defaults to 'online': no refresh token is ever
// requested or usable, since this flow never stores a Google token past
// the single callback request -- see Part 3/9's explicit requirement).
// No `prompt` parameter -- unlike GBP's reconnect flow, a returning PRYOR
// user should be able to complete this silently if Google already has an
// active session for them; there is no "must force account chooser" need
// here (a user who wants a different Google identity uses their OWN
// browser/Google account-switcher, exactly like any other "Sign in with
// Google" integration).
export function buildGoogleAuthorizeUrl({ state, redirectUri }) {
  if (typeof state !== 'string' || !state) throw new TypeError('buildGoogleAuthorizeUrl: state is required')
  if (typeof redirectUri !== 'string' || !redirectUri) throw new TypeError('buildGoogleAuthorizeUrl: redirectUri is required')
  const clientId = requireGoogleAuthClientId()
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    state,
  })
  return `${AUTHORIZE_URL}?${params}`
}

// Exchanges an authorization code for tokens. Returns the raw token
// response ({ id_token, access_token, ... }) -- the CALLER never persists
// access_token/id_token anywhere (Part 3/9); only verifyGoogleIdToken()'s
// verified CLAIMS are ever used past this single request.
export async function exchangeGoogleAuthCode({ code, redirectUri }) {
  if (testOverrides) return testOverrides.exchangeGoogleAuthCode({ code, redirectUri })
  if (typeof code !== 'string' || !code) throw new TypeError('exchangeGoogleAuthCode: code is required')
  const clientId = requireGoogleAuthClientId()
  const clientSecret = requireGoogleAuthClientSecret()
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) {
    throw new Error(`Google token exchange failed: ${body.error || res.status}`)
  }
  if (typeof body.id_token !== 'string' || !body.id_token) {
    throw new Error('Google token exchange did not return an id_token')
  }
  return body
}

// Verifies signature, issuer, audience, and expiry -- returns the verified
// payload { sub, email, email_verified, name } (only these fields are ever
// read by callers). Throws on any failure; the caller (session/[action].js)
// treats every failure mode identically (a generic, friendly OAuth error --
// never the underlying jose/network error surfaced to the browser).
export async function verifyGoogleIdToken(idToken) {
  if (testOverrides) return testOverrides.verifyGoogleIdToken(idToken)
  if (typeof idToken !== 'string' || !idToken) throw new TypeError('verifyGoogleIdToken: idToken is required')
  const clientId = requireGoogleAuthClientId()
  const { payload } = await jwtVerify(idToken, getJwks(), {
    issuer: ISSUERS,
    audience: clientId,
  })
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('Google id_token missing sub claim')
  }
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    email_verified: payload.email_verified === true,
    name: typeof payload.name === 'string' ? payload.name : null,
  }
}
