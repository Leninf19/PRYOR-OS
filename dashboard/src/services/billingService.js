/**
 * Persistence for the Billing settings page (Phase B.13.1) -- the only place
 * in the app that calls fetch() for it, same convention as
 * emailSystemService.js/contactsService.js. Both endpoints already exist and
 * are already owner-only/fail-closed server-side (session/[action].js) --
 * this file never invents a new one, never sends a tenantId/customerId/
 * subscriptionId (the server resolves everything from the session cookie
 * alone), and never transforms/derives anything from a raw Stripe
 * identifier, since the server response never contains one.
 */

import { SESSION_EXPIRED_EVENT } from '../lib/dataClient.js'

async function handleAuthFailure(res, action) {
  if (res.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    throw new Error(`Session expired ${action}`)
  }
}

// GET /api/session/billing-status -- owner-only, read-only safe projection
// of canonical commercial/billing state. Returns the response body as-is;
// the server itself is the sanitization boundary (never a raw tenant_config/
// billing record), so there is nothing further to strip here.
export async function getBillingStatus() {
  const res = await fetch('/api/session/billing-status')
  await handleAuthFailure(res, 'fetching billing status')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const err = new Error(body.message || `Failed to fetch billing status: ${res.status}`)
    err.code = body.error
    throw err
  }
  return res.json()
}

// POST /api/session/billing-portal-session -- owner-only. Deliberately sends
// an empty body: tenantId/customerId/subscriptionId are never accepted from
// the client by this endpoint (server-resolved from the session only), so
// there is nothing for this function to construct or pass.
export async function createBillingPortalSession() {
  const res = await fetch('/api/session/billing-portal-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  await handleAuthFailure(res, 'opening billing management')
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(body.message || `Failed to open billing management: ${res.status}`)
    err.code = body.error
    throw err
  }
  return body
}

// POST /api/session/redeem-complimentary-code  { code } -- owner-only. The
// ONLY value ever sent is the raw code string the owner typed in; plan,
// duration, and location/user limits are all server-resolved and returned
// in the response, never supplied by this function.
export async function redeemComplimentaryCode(code) {
  const res = await fetch('/api/session/redeem-complimentary-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  await handleAuthFailure(res, 'redeeming a complimentary access code')
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(body.message || `Failed to redeem code: ${res.status}`)
    err.code = body.error
    throw err
  }
  return body
}
