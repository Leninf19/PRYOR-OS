// Phase B.10 -- Stripe SDK + Billing Store Foundation. This is the ONE
// server-only seam a future B.11+ billing endpoint/webhook handler ever
// constructs a real Stripe client through. No Stripe network call happens
// anywhere in this file, or anywhere else in this codebase, as of B.10 --
// this module exists purely so that seam is reviewed, lazily-initialized,
// and fully test-injectable BEFORE any real Checkout/Subscription/webhook
// code is written.
//
// Lazy initialization mirrors the exact pattern already established by
// accessCodeStore.js's getClient()/tenantConfigStore.js's getClient(): the
// real client is constructed on first actual use, never at module import
// time, so importing this file (or anything that imports it) never itself
// requires STRIPE_SECRET_KEY to be set and never performs any network
// activity merely by being imported. `_setStripeClientForTests()` gives
// tests full injection control, identically to every other _lib store's
// `_setRedisClientForTests()`.
//
// SERVER-ONLY: this file must never be imported by anything under
// dashboard/src/** (the Vite client bundle). Vite only bundles what a
// client entry point actually imports, so there is no build-time wall
// preventing that mistake -- tests/test_stripe_client.js source-scans
// dashboard/src for any import of this file as the structural guard, the
// same discipline every other server-only _lib/*.js module in this
// codebase already relies on (none of them are imported from dashboard/src
// today either).
//
// STRIPE_SECRET_KEY is read directly from process.env and is NEVER logged,
// returned, or embedded in any error message below -- every error here
// describes the *absence* of configuration, never the value itself.

import Stripe from 'stripe'

let stripeClient = null
let testClientFactory = null

export function _setStripeClientForTests(factory) { testClientFactory = factory }
export function _resetStripeClientForTests() { testClientFactory = null; stripeClient = null }

// Thrown by getStripeClient() when STRIPE_SECRET_KEY is not set. A clear,
// typed, catchable error -- never a generic Stripe SDK construction
// exception -- so a future caller (e.g. a checkout-initiation endpoint) can
// distinguish "billing isn't configured yet" from a genuine Stripe API
// failure and fail closed with an honest message, exactly like
// accessCodeStore.js's AccessCodeStoreUnavailableError does for its own
// store.
export class StripeNotConfiguredError extends Error {}

function hasStripeConfig() {
  return Boolean(process.env.STRIPE_SECRET_KEY)
}

// Phase B.11 -- the B.10 prerequisite is now resolved: this is the FIRST
// phase to make real Stripe API calls, so `apiVersion` is explicitly
// pinned rather than left to the SDK's own default.
//
// PINNED VERSION: '2026-08-26.dahlia'
//
// WHY THIS EXACT VALUE: it is not a guess -- it is read directly from the
// installed `stripe@22.6.2` package's own generated source
// (node_modules/stripe/cjs/apiVersion.js exports `ApiVersion =
// '2026-08-26.dahlia'`), i.e. the exact Stripe API version this specific
// SDK release's request/response type definitions and runtime behavior
// were generated against. Pinning it explicitly here (rather than omitting
// `apiVersion` and letting the SDK silently fall back to this same value
// today) removes any FUTURE dependency on that implicit default -- a
// Stripe ACCOUNT's own dashboard-configured default API version can change
// independently of this codebase and would otherwise silently alter
// request/response shapes underneath an unpinned integration. Pinning it
// here means this codebase's behavior is governed only by ITS OWN
// reviewed, committed choice, never by an account setting or a future SDK
// upgrade that changes its bundled default without this file being
// reviewed and updated in lockstep.
const PINNED_STRIPE_API_VERSION = '2026-08-26.dahlia'

// Returns the shared Stripe client, constructing it on first call. Throws
// StripeNotConfiguredError (never a raw SDK error) if STRIPE_SECRET_KEY is
// absent.
export function getStripeClient() {
  if (testClientFactory) return testClientFactory()
  if (!hasStripeConfig()) {
    throw new StripeNotConfiguredError(
      'Stripe is not configured (STRIPE_SECRET_KEY is not set) -- billing operations are unavailable.'
    )
  }
  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: PINNED_STRIPE_API_VERSION })
  }
  return stripeClient
}
