// Shared fetch helper for the authenticated data endpoint
// (dashboard/api/data.js) -- replaces the old direct fetch('/data/...')
// calls against dashboard/public/data/, which is no longer where this data
// lives (see README "Standing rule").
//
// Uses a query string parameter (?file=...) rather than a dynamic path
// segment (/api/data/...) -- a prior dynamic catch-all route version of
// this endpoint hit a confirmed platform bug where Edge Middleware's
// next() continuation failed to route multi-segment catch-all requests to
// the underlying function at all. A plain query parameter is populated by
// ordinary query-string parsing, a completely different code path.
//
// Every hook that reads review/analytics/intelligence data should go
// through this, not a bespoke fetch() call, so a session expiring mid-use
// is handled the same way everywhere: a 401 dispatches SESSION_EXPIRED_EVENT
// on `window`, which AuthGate listens for to drop back to the login screen
// instead of every page independently rendering its own error state for
// what is actually "please sign in again".

export const SESSION_EXPIRED_EVENT = 'lta:session-expired'

export async function fetchJSON(relPath) {
  const res = await fetch(`/api/data?file=${encodeURIComponent(relPath)}`)
  if (res.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    throw new Error(`Session expired fetching ${relPath}`)
  }
  if (!res.ok) throw new Error(`Failed to fetch ${relPath}: ${res.status}`)
  return res.json()
}
