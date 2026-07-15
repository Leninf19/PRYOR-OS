// Minimal Vercel REST API client -- just enough to upsert an environment
// variable and trigger a redeploy after a fresh refresh token comes back
// from the Google OAuth callback, so the token never has to be displayed in
// the browser or hand-copied into the Vercel dashboard.
// Docs: https://vercel.com/docs/rest-api

const API_BASE = 'https://api.vercel.com'

function teamQuery(teamId) {
  return teamId ? `?teamId=${teamId}` : ''
}

async function vercelFetch(path, token, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error?.message || `Vercel API ${res.status}`)
  }
  return data
}

export async function upsertEnvVar({ token, projectId, teamId, key, value, targets = ['production', 'preview'] }) {
  const { envs } = await vercelFetch(`/v9/projects/${projectId}/env${teamQuery(teamId)}`, token)
  const existing = (envs || []).find(e => e.key === key)

  if (existing) {
    await vercelFetch(`/v9/projects/${projectId}/env/${existing.id}${teamQuery(teamId)}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ value, target: targets }),
    })
  } else {
    await vercelFetch(`/v10/projects/${projectId}/env${teamQuery(teamId)}`, token, {
      method: 'POST',
      body: JSON.stringify({ key, value, type: 'encrypted', target: targets }),
    })
  }
}

export async function triggerRedeploy(deployHookUrl) {
  const res = await fetch(deployHookUrl, { method: 'POST' })
  if (!res.ok) {
    throw new Error(`Deploy hook returned ${res.status}`)
  }
}
