// Phase B.13 -- Stripe Customer Portal session creation. The ONE place a
// real Portal Session is ever created (billingPortalPolicy.js, B.10,
// wrote the reviewed allow/disallow list this file now actually enforces
// -- see that file's own header for why plan/price changes are excluded).
//
// AUTHORITY: every value Stripe needs (Customer, Subscription's mere
// existence, Portal Configuration id, return_url) is derived exclusively
// from this tenant's OWN already-durable billing:v1 record and server
// configuration -- createBillingPortalSession()'s only argument is
// `tenantId`, itself always the caller's own authenticated, server-resolved
// tenant id (never accepted from a request body). There is structurally no
// parameter here for a browser to supply a customerId, subscriptionId,
// configurationId, or return URL.
//
// FAIL CLOSED, ALWAYS: no billing customer yet, no subscription yet, no
// pinned configuration env var, a misconfigured Portal Configuration (its
// live Stripe-side feature flags don't match the exact reviewed B.13
// policy), or no application base URL -- every one of these refuses to
// create a Session rather than falling back to an unreviewed default. The
// dashboard-configuration-drift case (someone edits the Stripe Dashboard's
// Portal Configuration to re-enable plan switching) is exactly what the
// live validation in validatePortalConfiguration() below exists to catch
// -- silently trusting "whatever the account's default Configuration is
// today" would let that drift bypass B.14's own not-yet-built plan-change
// policy with zero code-level guard.
import { getStripeClient } from './stripeClient.js'
import { getBillingRecord } from './billingStore.js'

export class BillingPortalNotReadyError extends Error {}
export class BillingPortalConfigurationInvalidError extends Error {}
export class BillingPortalUrlNotConfiguredError extends Error {}

function dashboardBaseUrl() {
  const base = process.env.DASHBOARD_BASE_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  if (!base) return null
  return base.replace(/\/$/, '')
}

// Live server-side validation of the PINNED Portal Configuration's actual
// Stripe-side feature flags, checked fresh on every Portal Session
// request (never cached/assumed) -- this is what makes the guarantee
// "Core<->Growth changes are impossible via the Portal" hold even if
// someone edits the Configuration in the Stripe Dashboard after this code
// was reviewed. Every check below matches this phase's exact, locked
// policy; ANY mismatch fails closed with a single generic error (never
// partial/best-effort enforcement).
//
// login_page.enabled MUST be exactly `false` -- PRYOR's approved
// architecture requires every Portal entry to originate from an
// authenticated PRYOR Owner session -> server-resolved tenant -> a Portal
// Session this code itself creates. Stripe's own `login_page` feature is a
// SEPARATE, shareable, hosted entry point (a public URL a customer can
// bookmark/share, authenticated by Stripe's own email-based login instead
// of PRYOR's session) -- if enabled, it bypasses PRYOR's owner-only
// authorization entirely. `undefined`/missing/any non-`false` value fails
// closed -- this is deliberately NOT a `!== true` check (which would
// silently accept `undefined`); it requires the field to be explicitly,
// affirmatively disabled.
//
// features.customer_update.enabled MUST be exactly `false` -- B.13's
// approved Portal capabilities are payment-method update, invoice
// history, and cancel/reactivate at period end ONLY. Stripe's own
// `customer_update` feature is a SEPARATE, broader capability (editing the
// Customer's email/name/address/phone/shipping/tax IDs) that was never
// reviewed or approved for B.13 -- disabled here exactly like
// `subscription_update`, never silently inherited from whatever the
// Configuration's own default happens to be.
//
// `active` (when the Configuration object exposes it -- real Stripe API
// responses always do, but this stays a defensive, non-required check
// per this phase's own explicit "optional" framing) must be exactly
// `true` -- an inactive/disabled pinned Configuration must fail closed
// before ever attempting Session creation, rather than let Stripe itself
// reject the call with a less specific error. Deliberately NOT checking
// `is_default` -- pinning the configuration id explicitly is the whole
// point; this Configuration does not need to be the account's default.
function configurationMatchesRequiredPolicy(configuration) {
  const features = configuration?.features ?? {}
  const subscriptionUpdate = features.subscription_update ?? {}
  const subscriptionCancel = features.subscription_cancel ?? {}
  const paymentMethodUpdate = features.payment_method_update ?? {}
  const invoiceHistory = features.invoice_history ?? {}
  const customerUpdate = features.customer_update ?? {}
  const loginPage = configuration?.login_page ?? {}

  if (configuration != null && Object.prototype.hasOwnProperty.call(configuration, 'active') && configuration.active !== true) {
    return false
  }

  return (
    subscriptionUpdate.enabled === false &&
    subscriptionCancel.enabled === true &&
    subscriptionCancel.mode === 'at_period_end' &&
    paymentMethodUpdate.enabled === true &&
    invoiceHistory.enabled === true &&
    customerUpdate.enabled === false &&
    loginPage.enabled === false
  )
}

async function retrieveAndValidatePinnedConfiguration(stripe, configurationId) {
  let configuration
  try {
    configuration = await stripe.billingPortal.configurations.retrieve(configurationId)
  } catch (err) {
    throw new BillingPortalConfigurationInvalidError(`could not retrieve Stripe Billing Portal configuration ${JSON.stringify(configurationId)}: ${err.message}`)
  }
  if (!configurationMatchesRequiredPolicy(configuration)) {
    throw new BillingPortalConfigurationInvalidError(
      `Stripe Billing Portal configuration ${JSON.stringify(configurationId)} does not match the required B.13 policy ` +
      `(subscription_update.enabled must be false; subscription_cancel.enabled must be true with mode 'at_period_end'; ` +
      `payment_method_update.enabled and invoice_history.enabled must both be true; customer_update.enabled must be false; ` +
      `login_page.enabled must be false; active, if present, must be true) -- refusing to create a Portal Session`
    )
  }
  return configuration
}

// Creates a Stripe Billing Portal Session for this tenant's OWN existing
// Customer/Subscription, using the pinned, live-validated Configuration.
// Fails closed at every precondition -- see this file's own header.
export async function createBillingPortalSession(tenantId) {
  const configurationId = process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID
  if (typeof configurationId !== 'string' || !configurationId) {
    throw new BillingPortalConfigurationInvalidError('STRIPE_BILLING_PORTAL_CONFIGURATION_ID is not configured')
  }

  const record = await getBillingRecord(tenantId)
  if (!record?.stripeCustomerId) {
    throw new BillingPortalNotReadyError(`tenant ${JSON.stringify(tenantId)} has no Stripe Customer yet -- cannot open a Billing Portal session`)
  }
  if (!record?.stripeSubscriptionId) {
    throw new BillingPortalNotReadyError(`tenant ${JSON.stringify(tenantId)} has no Stripe Subscription yet -- cannot open a Billing Portal session`)
  }

  const base = dashboardBaseUrl()
  if (!base) {
    throw new BillingPortalUrlNotConfiguredError('DASHBOARD_BASE_URL is not configured -- cannot build a safe Portal return_url.')
  }

  const stripe = getStripeClient()
  await retrieveAndValidatePinnedConfiguration(stripe, configurationId)

  const session = await stripe.billingPortal.sessions.create({
    customer: record.stripeCustomerId,
    configuration: configurationId,
    return_url: `${base}/settings/billing`,
  })
  return session
}
