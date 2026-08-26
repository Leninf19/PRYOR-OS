// Notification Center Audit & Fix -- the frontend data layer for the
// notification bell. Talks to dashboard/api/notifications/[action].js;
// server-side authorization (dashboard/api/_lib/notificationEvents.js)
// already scoped the response to whatever this account is allowed to see,
// so this hook never re-filters by location itself -- exactly the "server-
// side, not by downloading everything and filtering in React" requirement.
//
// Polls every 60s (matches useReviewsData.js's publish-bridge poll interval)
// so the badge count feels live without an expensive/complex push
// mechanism -- critical-alert-check.yml only runs every 15 minutes, so a
// 60s client poll is already far more responsive than the underlying data
// ever changes.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SESSION_EXPIRED_EVENT } from '../lib/dataClient.js'

const QUERY_KEY = ['notifications']

async function callNotificationsApi(action, { method = 'GET', body } = {}) {
  // Vercel's [action].js dynamic-route convention maps the URL PATH
  // SEGMENT to req.query.action (e.g. /api/actions/list, /api/settings/
  // contacts-upsert) -- a query string (`?action=`) never matches this
  // route pattern at all and 404s before the function is even invoked.
  // Every other consolidated endpoint in this app already calls its
  // actions this way (see actionWorkspaceService.js/contactsService.js).
  const url = `/api/notifications/${action}`
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    throw new Error('Session expired fetching notifications')
  }
  if (!res.ok) throw new Error(`Notifications request failed: ${res.status}`)
  return res.json()
}

export function useNotifications() {
  const qc = useQueryClient()

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => callNotificationsApi('list'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  const markReadMutation = useMutation({
    mutationFn: (key) => callNotificationsApi('mark-read', { method: 'POST', body: { key } }),
    // Optimistic: the bell should feel instant, not wait on a round trip --
    // a failure below reverts via the invalidateQueries in onSettled.
    onMutate: async (key) => {
      await qc.cancelQueries({ queryKey: QUERY_KEY })
      const prev = qc.getQueryData(QUERY_KEY)
      if (prev) {
        qc.setQueryData(QUERY_KEY, {
          ...prev,
          notifications: prev.notifications.map(n => n.key === key ? { ...n, read: true } : n),
          unreadCount: Math.max(0, prev.unreadCount - (prev.notifications.find(n => n.key === key && !n.read) ? 1 : 0)),
        })
      }
      return { prev }
    },
    onError: (_err, _key, context) => {
      if (context?.prev) qc.setQueryData(QUERY_KEY, context.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })

  const markAllReadMutation = useMutation({
    mutationFn: () => callNotificationsApi('mark-all-read', { method: 'POST' }),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: QUERY_KEY })
      const prev = qc.getQueryData(QUERY_KEY)
      if (prev) {
        qc.setQueryData(QUERY_KEY, {
          ...prev,
          notifications: prev.notifications.map(n => ({ ...n, read: true })),
          unreadCount: 0,
        })
      }
      return { prev }
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) qc.setQueryData(QUERY_KEY, context.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })

  return {
    notifications: query.data?.notifications ?? [],
    unreadCount: query.data?.unreadCount ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
    markRead: (key) => markReadMutation.mutate(key),
    markAllRead: () => markAllReadMutation.mutate(),
  }
}
