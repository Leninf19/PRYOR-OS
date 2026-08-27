// Operations Calendar + Content Library milestone -- frontend data layer
// for Campaigns and Content assets. Talks to dashboard/api/content/
// [action].js; server-side authorization already scoped every response
// (Draft campaigns invisible without CONTENT_MANAGE, location-gated
// otherwise) -- never re-filtered here, matching useTasks.js/
// useNotifications.js's established convention.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SESSION_EXPIRED_EVENT } from '../lib/dataClient.js'

async function callContentApi(action, { method = 'GET', body, params } = {}) {
  let url = `/api/content/${action}`
  if (params) url += `?${new URLSearchParams(params).toString()}`
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    throw new Error('Session expired fetching content')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || `Content request failed: ${res.status}`)
  return data
}

export function useCampaigns({ includeArchived = false } = {}) {
  const qc = useQueryClient()
  const queryKey = ['content-campaigns', includeArchived]

  const query = useQuery({
    queryKey,
    queryFn: () => callContentApi('list-campaigns', { params: includeArchived ? { includeArchived: '1' } : undefined }),
    staleTime: 30_000,
  })

  const upsertMutation = useMutation({
    mutationFn: (fields) => callContentApi('upsert-campaign', { method: 'POST', body: fields }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['content-campaigns'] }),
  })

  return {
    campaigns: query.data?.campaigns ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    createCampaign: (fields) => upsertMutation.mutateAsync(fields),
    updateCampaign: (id, patch) => upsertMutation.mutateAsync({ id, ...patch }),
    isSaving: upsertMutation.isPending,
    saveError: upsertMutation.error?.message ?? null,
  }
}

export function useContentAssets(campaignId) {
  const qc = useQueryClient()
  const queryKey = ['content-assets', campaignId ?? 'all']

  const query = useQuery({
    queryKey,
    queryFn: () => callContentApi('list-assets', { params: campaignId ? { campaignId } : undefined }),
    staleTime: 30_000,
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['content-assets'] })

  const uploadMutation = useMutation({
    mutationFn: (fields) => callContentApi('upload', { method: 'POST', body: fields }),
    onSuccess: invalidate,
  })
  const createTextAssetMutation = useMutation({
    mutationFn: (fields) => callContentApi('create-text-asset', { method: 'POST', body: fields }),
    onSuccess: invalidate,
  })
  const deleteMutation = useMutation({
    mutationFn: (id) => callContentApi('delete-asset', { method: 'POST', body: { id } }),
    onSuccess: invalidate,
  })

  return {
    assets: query.data?.assets ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    uploadAsset: (fields) => uploadMutation.mutateAsync(fields),
    addCaption: (fields) => createTextAssetMutation.mutateAsync(fields),
    deleteAsset: (id) => deleteMutation.mutateAsync(id),
    isUploading: uploadMutation.isPending,
    uploadError: uploadMutation.error?.message ?? null,
  }
}

// Triggers a real browser download of a private asset -- the endpoint
// streams the file through after re-authorizing, so this is a plain fetch
// + object-URL download, never a direct link to a Blob URL/pathname (never
// exposed to the frontend in the first place -- see list-assets' response
// shape, which omits blobPathname entirely).
export async function downloadAsset(assetId, filename) {
  const res = await fetch(`/api/content/download?id=${encodeURIComponent(assetId)}`)
  if (!res.ok) throw new Error('Could not download this file.')
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// Print-ready PDFs use the browser's own printable-PDF workflow: opened
// inline (disposition=inline) in a new tab, the browser's native PDF
// viewer renders it and its own Print control does the rest -- no custom
// print engine, per the explicit product requirement.
export function printAssetUrl(assetId) {
  return `/api/content/download?id=${encodeURIComponent(assetId)}&disposition=inline`
}
