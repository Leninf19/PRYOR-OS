// Triggers the existing "Update Reviews" GitHub Actions workflow on demand
// (Settings -> Connection Center -> "Sync Now"), instead of duplicating the
// sync logic in JS -- gbp_sync.py stays the one real implementation.
// POST /api/google/trigger-sync
// Returns { success: true } or { error, message }

import { requireAuth } from '../_lib/auth.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'

const REPO_OWNER = 'LosTresAmigos1'
const REPO_NAME  = 'lta-review-dashboard'
const WORKFLOW   = 'update-reviews.yml'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const account = await requireAuth(req, res, ['owner'])
  if (!account) return

  const allowed = await enforceRateLimit(req, res, `trigger-sync:${account.userId}`, { requestsPerWindow: 5, windowSeconds: 60 })
  if (!allowed) return

  const pat = process.env.GITHUB_SYNC_PAT
  if (!pat) {
    return res.status(503).json({
      error:   'not_configured',
      message: 'GITHUB_SYNC_PAT is not set in Vercel environment variables. Add a GitHub personal access token with "workflow" scope to enable manual sync triggers.',
    })
  }

  try {
    const r = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method:  'POST',
        headers: {
          Authorization:          `Bearer ${pat}`,
          Accept:                 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type':         'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    )

    if (r.status === 204) {
      return res.status(200).json({ success: true })
    }

    const body = await r.json().catch(() => ({}))
    return res.status(502).json({
      error:   'github_error',
      message: body.message || `GitHub API returned status ${r.status}.`,
    })
  } catch (err) {
    return res.status(502).json({ error: 'network_error', message: err.message })
  }
}
