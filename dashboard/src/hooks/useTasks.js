// Operations Calendar + Content Library milestone -- the frontend data
// layer for tasks/events. Talks to dashboard/api/tasks/[action].js;
// server-side authorization already scoped the response to whatever this
// account is allowed to see (its OWN locationIds, plus company-wide '*'
// tasks) -- this hook never re-filters by location itself, matching
// useNotifications.js's own "server-side, not download-then-filter" rule.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SESSION_EXPIRED_EVENT } from '../lib/dataClient.js'

const QUERY_KEY = ['tasks']

async function callTasksApi(action, { method = 'GET', body, params } = {}) {
  // Same Vercel [action].js path-segment convention every other
  // consolidated endpoint in this app uses (see useNotifications.js's own
  // comment/regression history for why this must never be a query string).
  let url = `/api/tasks/${action}`
  if (params) url += `?${new URLSearchParams(params).toString()}`
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    throw new Error('Session expired fetching tasks')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || `Tasks request failed: ${res.status}`)
  return data
}

export function useTasks() {
  const qc = useQueryClient()

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => callTasksApi('list'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  const createMutation = useMutation({
    mutationFn: (fields) => callTasksApi('create', { method: 'POST', body: fields }),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, patch, logAction }) => callTasksApi('update', { method: 'POST', body: { id, patch, logAction } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => callTasksApi('delete', { method: 'POST', body: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })

  return {
    tasks: query.data?.tasks ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    createTask: (fields) => createMutation.mutateAsync(fields),
    updateTask: (id, patch, logAction) => updateMutation.mutateAsync({ id, patch, logAction }),
    deleteTask: (id) => deleteMutation.mutateAsync(id),
    isCreating: createMutation.isPending,
    createError: createMutation.error?.message ?? null,
  }
}
