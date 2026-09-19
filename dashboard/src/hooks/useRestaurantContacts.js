import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import * as contactsService from '../services/contactsService.js'

const QK = ['restaurant-contacts']

// Restaurant Contacts state (Phase 8, Milestone 8.4) -- same useQuery +
// optimistic-mutation convention as useActionWorkspace.js. `data` is keyed
// by locationId (string), matching the server's { contacts: { [locationId]: record } } shape.
//
// PART 15 root-cause fix: this previously passed `initialData: {}`
// alongside `staleTime: 30_000`. Under TanStack Query v5, supplying
// `initialData` makes the query considered "fresh" (isPending: false,
// dataUpdatedAt: now) from the very first render -- combined with a 30s
// staleTime, a genuine page reload (which always constructs a brand-new
// QueryClient -- see main.jsx) could display this `{}` placeholder as the
// real result for up to 30 seconds, showing every location as
// "Not Configured" even though the actual Redis-persisted contact record
// was completely intact. This looked exactly like "my edit didn't stick,"
// with no actual persistence bug underneath. Removing `initialData`
// restores the normal, correct loading state (RestaurantContacts.jsx
// already handles `isLoading` -- it just never had a chance to be true
// before) and guarantees every mount fetches the real server value at
// least once before ever rendering contact data.
export function useRestaurantContacts() {
  return useQuery({
    queryKey: QK,
    queryFn: contactsService.getAll,
    staleTime: 30 * 1000,
  })
}

export function useUpsertContact() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ locationId, patch, logAction }) => contactsService.upsertContact(locationId, patch, logAction),
    onMutate: async ({ locationId, patch }) => {
      await qc.cancelQueries({ queryKey: QK })
      const prev = qc.getQueryData(QK) ?? {}
      qc.setQueryData(QK, { ...prev, [locationId]: { ...prev[locationId], locationId, ...patch } })
      return { prev }
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) qc.setQueryData(QK, context.prev)
    },
    // Merge the server-authoritative record (createdBy/At, updatedBy/At,
    // history) into the cache rather than trusting the optimistic value.
    onSuccess: ({ record }, { locationId }) => {
      const prev = qc.getQueryData(QK) ?? {}
      qc.setQueryData(QK, { ...prev, [locationId]: record })
    },
  })
}

export function useDeleteContact() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ locationId }) => contactsService.deleteContact(locationId),
    onMutate: async ({ locationId }) => {
      await qc.cancelQueries({ queryKey: QK })
      const prev = qc.getQueryData(QK) ?? {}
      const next = { ...prev }
      delete next[locationId]
      qc.setQueryData(QK, next)
      return { prev }
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) qc.setQueryData(QK, context.prev)
    },
  })
}

export function useToggleContactActive() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ locationId, active }) => contactsService.toggleContactActive(locationId, active),
    onMutate: async ({ locationId, active }) => {
      await qc.cancelQueries({ queryKey: QK })
      const prev = qc.getQueryData(QK) ?? {}
      if (!prev[locationId]) return { prev }
      qc.setQueryData(QK, { ...prev, [locationId]: { ...prev[locationId], active } })
      return { prev }
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) qc.setQueryData(QK, context.prev)
    },
    onSuccess: (record, { locationId }) => {
      const prev = qc.getQueryData(QK) ?? {}
      qc.setQueryData(QK, { ...prev, [locationId]: record })
    },
  })
}
