// Phase B.11 -- the server-authoritative recurring-billing consent terms
// version. Never trust a client-supplied termsVersion -- the server always
// stamps this constant, regardless of anything the request body claims,
// so "which terms did this customer actually agree to" can never be
// spoofed or drift from what the server itself understands to be current.
//
// Bump this string (and update the copy shown on the Pricing page in
// lockstep) whenever the substance of the recurring-billing consent
// language materially changes -- it exists so a future audit/support
// question ("what did this customer actually agree to on this date") has
// an unambiguous, versioned answer.
export const CURRENT_BILLING_TERMS_VERSION = '2026-01-recurring-billing-v1'
