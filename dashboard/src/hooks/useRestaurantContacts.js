import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import * as contactsService from '../services/contactsService.js'

const QK = ['restaurant-contacts']

// Restaurant Contacts state (Phase 8, Milestone 8.4) -- same useQuery +
// optimistic-mutation convention as useActionWorkspace.js. `data` is keyed
// by locationId (string), matching the server's { contacts: { [locationId]: record } } shape.
export function useRestaurantContacts() {
  return useQuery({
    queryKey: QK,
    queryFn: contactsService.getAll,
    staleTime: 30 * 1000,
    initialData: {},
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
