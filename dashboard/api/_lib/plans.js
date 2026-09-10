// Multi-Tenant Phase 4Q -- plain commercial/pricing metadata. Deliberately
// NOT a Redis store (nothing here changes at runtime yet) and deliberately
// NEVER imported by permissions.js, auth.js, or any tenant authorization
// function -- a tenant's `plan` is descriptive/billing metadata only (see
// tenantConfigStore.js's `commercial` field), never consulted to decide
// what a role/permission may do. This is the isolation the design report
// required: commercial metadata and security/authorization are two
// completely separate object graphs that happen to both mention "plan."
export const PLANS = Object.freeze({
  core: {
    id: 'core', name: 'Core', priceCents: 14900, billingPeriod: 'month',
    stripePriceId: null, contactSales: false,
  },
  growth: {
    id: 'growth', name: 'Growth', priceCents: 34900, billingPeriod: 'month',
    stripePriceId: null, contactSales: false,
  },
  enterprise: {
    id: 'enterprise', name: 'Enterprise', priceCents: null, billingPeriod: null,
    stripePriceId: null, contactSales: true,
  },
})

export function isValidPlanId(planId) {
  return typeof planId === 'string' && Object.prototype.hasOwnProperty.call(PLANS, planId)
}
