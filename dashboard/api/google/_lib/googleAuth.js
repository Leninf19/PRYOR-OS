// Shared refresh-token -> access-token exchange (Phase 8, Milestone 8.2;
// updated Milestone 8.7 to take the refresh token as a parameter instead
// of reading GOOGLE_REFRESH_TOKEN directly, since the token now lives in
// credentialStore.js/Redis, not a Vercel env var). Previously duplicated
// three times across the pre-consolidation google/*.js files: status.js's
// own exchangeRefreshToken(), publish.js's own getAccessToken(), and
// test-connection.js's inline fetch call. Same request shape, same
// response passthrough as all three.

export async function exchangeRefreshToken(refreshToken) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  })
  return r.json()
}

// publish.js's variant: throws if no access_token, returns just the token
// string -- its callers only ever need the bearer token, unlike
// status.js/test-connection.js which also report expires_in/scope. The
// thrown error carries `.code`/`.description` (Google's raw error/
// error_description) so callers can feed it straight into
// credentialStore.recordSyncOutcome() without re-deriving it.
export async function getAccessToken(refreshToken) {
  const d = await exchangeRefreshToken(refreshToken)
  if (!d.access_token) {
    const err = new Error(d.error_description || 'Could not get access token')
    err.code = d.error || 'unknown'
    err.description = d.error_description || null
    throw err
  }
  return d.access_token
}
