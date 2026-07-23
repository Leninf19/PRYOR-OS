// Shared refresh-token -> access-token exchange (Phase 8, Milestone 8.2).
// Previously duplicated three times across the pre-consolidation
// google/*.js files: status.js's own exchangeRefreshToken(), publish.js's
// own getAccessToken(), and test-connection.js's inline fetch call. Same
// request shape, same response passthrough as all three -- this is a pure
// de-duplication, not a behavior change.

export async function exchangeRefreshToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  })
  return r.json()
}

// publish.js's variant: throws if no access_token, returns just the token
// string -- its callers only ever need the bearer token, unlike
// status.js/test-connection.js which also report expires_in/scope.
export async function getAccessToken() {
  const d = await exchangeRefreshToken()
  if (!d.access_token) throw new Error(d.error_description || 'Could not get access token')
  return d.access_token
}
