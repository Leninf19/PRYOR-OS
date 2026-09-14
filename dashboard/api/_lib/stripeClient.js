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
// accessCodeStore.js's AccessCodeStoreUnavailableError /
// paymentProvider.js's PaymentNotConfiguredError already do for their own
// stores.
export class StripeNotConfiguredError extends Error {}

function hasStripeConfig() {
  return Boolean(process.env.STRIPE_SECRET_KEY)
}

// Returns the shared Stripe client, constructing it on first call. Throws
// StripeNotConfiguredError (never a raw SDK error) if STRIPE_SECRET_KEY is
// absent. No `apiVersion` is pinned here deliberately -- this file has
// never made a real Stripe API call, so there is no way to verify a chosen
// pinned version string against actual Stripe behavior yet; omitting it
// lets the SDK use its own built-in default (pinned to the installed
// `stripe` package version, 22.6.2).
//
// *** B.11 PREREQUISITE (non-blocking for B.10, MUST be resolved before
// B.11's first real API call) *** -- production billing behavior must
// never silently depend on the Stripe ACCOUNT's own moving/default API
// version (Stripe accounts can have their dashboard-configured default API
// version changed independently of this codebase, which would silently
// change request/response shapes underneath an unpinned integration).
// Before the first real `getStripeClient().<anything>` call is added
// anywhere in this codebase, that change MUST explicitly pass a reviewed
// `apiVersion` string here (e.g. `new Stripe(secretKey, { apiVersion:
// '2024-06-20' })`), chosen and tested against the actual installed SDK
// version at that time -- never left to float on whatever the account's
// dashboard default happens to be.
export function getStripeClient() {
  if (testClientFactory) return testClientFactory()
  if (!hasStripeConfig()) {
    throw new StripeNotConfiguredError(
      'Stripe is not configured (STRIPE_SECRET_KEY is not set) -- billing operations are unavailable.'
    )
  }
  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY)
  }
  return stripeClient
}
