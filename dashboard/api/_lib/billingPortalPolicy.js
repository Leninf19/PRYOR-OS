// Phase B.10 -- design-only. No Stripe Customer Portal session is created
// anywhere in this codebase yet (that is explicit B.10 scope: "do not
// create Portal Sessions yet, do not modify Stripe Dashboard config"). This
// module exists so the future Portal policy locked in the B.9 design
// report (Part V) is written down as reviewable, testable constants rather
// than only prose, before a real B.13 Portal Session call is ever built --
// a future implementation must configure Stripe's own Portal Configuration
// object to match this list, never leave the Portal's default (which can
// allow arbitrary product/price switching) unreviewed.

export const BILLING_PORTAL_ALLOWED_ACTIONS = Object.freeze([
  'update_payment_method',
  'view_invoice_history',
  'cancel_at_period_end',
])

// Plan/price changes are deliberately excluded: allowing the Portal to
// switch products/prices directly would bypass PRYOR's own downgrade-grace/
// over-limit policy (B.9 Part P), which can only be enforced server-side,
// before Stripe is ever called. Quantity changes and arbitrary promotion
// codes are excluded for the same "no client-driven billing authority"
// reason as everywhere else in this design.
export const BILLING_PORTAL_DISALLOWED_ACTIONS = Object.freeze([
  'change_plan',
  'change_price',
  'apply_promotion_code',
  'change_quantity',
  'cancel_immediately',
])

export function isBillingPortalActionAllowed(action) {
  return BILLING_PORTAL_ALLOWED_ACTIONS.includes(action)
}
