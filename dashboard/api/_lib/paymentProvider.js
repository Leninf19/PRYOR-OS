// Multi-Tenant Phase 4Q.1 -- payment provider interface, STUBBED. No
// Stripe (or any other processor) integration exists yet for this exact
// self-service flow (Phase 4Q.2, a separately reviewed follow-up, wires a
// real implementation behind this same interface). This module never
// fabricates a successful payment under any circumstance -- both exported
// functions always throw PaymentNotConfiguredError today. Callers
// (session/[action].js's selectPlan()) must catch this specifically and
// return a clear, honest "checkout isn't available yet" response rather
// than ever creating a tenant without genuine payment/eligibility.
export class PaymentNotConfiguredError extends Error {}

// eslint-disable-next-line no-unused-vars
export async function createCheckoutSession(plan, email) {
  throw new PaymentNotConfiguredError('Plan checkout is not yet available.')
}

// eslint-disable-next-line no-unused-vars
export async function verifyPayment(sessionId) {
  throw new PaymentNotConfiguredError('Plan checkout is not yet available.')
}
