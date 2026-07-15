// Triggers the "Historical Import" GitHub Actions workflow on demand
// (Settings -> Connection Center -> "Preview Import" / "Run Import"),
// instead of duplicating gbp_import.py's reconciliation logic in JS.
// Mirrors trigger-sync.js exactly -- same PAT, different workflow file.
// POST /api/google/trigger-import  { apply?: boolean }
// Returns { success: true } or { error, message }

const REPO_OWNER = 'LosTresAmigos1'
const REPO_NAME  = 'lta-review-dashboard'
const WORKFLOW   = 'historical-import.yml'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const pat = process.env.GITHUB_SYNC_PAT
  if (!pat) {
    return res.status(503).json({
      error:   'not_configured',
      message: 'GITHUB_SYNC_PAT is not set in Vercel environment variables. Add a GitHub personal access token with "workflow" scope to enable this.',
    })
  }

  const apply = req.body?.apply === true

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
        body: JSON.stringify({ ref: 'main', inputs: { apply: apply ? 'true' : 'false' } }),
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
