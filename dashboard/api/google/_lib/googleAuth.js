// Shared refresh-token -> access-token exchange (Phase 8, Milestone 8.2;
// updated Milestone 8.7 to take the refresh token as a parameter instead
// of reading GOOGLE_REFRESH_TOKEN directly, since the token now lives in
// credentialStore.js/Redis, not a Vercel env var). Previously duplicated
// three times across the pre-consolidation google/*.js files: status.js's
// own exchangeRefreshToken(), publish.js's own getAccessToken(), and
// test-connection.js's inline fetch call. Same request shape, same
// response passthrough as all three.
//
// Dual-client migration (Phase 5): both functions now REQUIRE the
// clientKey the caller's credential was actually issued under --
// resolveGoogleOAuthClientCredentials() (googleOAuthClients.js) is the
// ONLY place that turns that into an actual client_id/client_secret pair.
// Every caller of these two functions has already read `clientKey` off
// its stored credential record (defaulting an ABSENT field to
// 'legacy-lta' at that read site, never here) -- passing an explicit but
// unrecognized value here throws rather than silently using any
// particular pair, exactly like the resolver itself.
import { resolveGoogleOAuthClientCredentials } from './googleOAuthClients.js'

export async function exchangeRefreshToken(refreshToken, clientKey) {
  const { clientId, clientSecret } = resolveGoogleOAuthClientCredentials(clientKey)
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id:     clientId,
      client_secret: clientSecret,
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
export async function getAccessToken(refreshToken, clientKey) {
  const d = await exchangeRefreshToken(refreshToken, clientKey)
  if (!d.access_token) {
    const err = new Error(d.error_description || 'Could not get access token')
    err.code = d.error || 'unknown'
    err.description = d.error_description || null
    throw err
  }
  return d.access_token
}
