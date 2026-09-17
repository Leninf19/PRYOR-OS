import { useQuery, useMutation } from '@tanstack/react-query'
import * as billingService from '../services/billingService.js'

const QK = ['billing-status']

// Billing settings state (Phase B.13.1) -- read-only status over the
// existing owner-only GET /api/session/billing-status endpoint, same
// useQuery convention as useEmailSystemStatus.js. No aggressive polling --
// unlike useTenantStatus() (which drives the onboarding gate and must
// notice a lifecycle transition quickly), this is a settings page a user
// opens deliberately; a manual refetch/retry is enough.
export function useBillingStatus() {
  return useQuery({
    queryKey: QK,
    queryFn: billingService.getBillingStatus,
    staleTime: 15 * 1000,
  })
}

// "Manage Billing" -- creates a server-side Stripe Billing Portal session
// and returns its URL for the caller to navigate to. Never touches any
// query cache/canonical billing state itself: the Portal is the sole
// authority for payment methods/invoices/cancellation, and the ONLY way
// PRYOR ever learns a resulting change happened is the existing B.13
// webhook pipeline (customer.subscription.updated/deleted) updating
// tenant_config/billing:v1 server-side -- never an optimistic client-side
// write. A user who completes a change in the Portal and returns sees the
// new state on their next natural refetch of billing-status, same as any
// other server-authoritative read in this app.
export function useCreateBillingPortalSession() {
  return useMutation({
    mutationFn: billingService.createBillingPortalSession,
  })
}
