// Vercel Edge Middleware -- runs before routing/rewrites for any matched
// path, which is exactly why it's needed here and not just "delete the
// files and let it 404 naturally": dashboard/vercel.json's SPA rewrite
// (`/((?!api/).*)` -> /index.html) would otherwise catch a request for a
// no-longer-existing /data/*.json file and serve index.html with a 200,
// not a 404. This runs first and short-circuits that.
//
// This is DEFENSE IN DEPTH / a legacy-path guard, not the primary security
// boundary -- dashboard/api/data.js (Node) is authoritative and
// independently re-verifies everything below itself; it never assumes
// middleware already ran (a matcher typo or a future route outside it must
// not silently lose protection).
//
// What this file verifies vs. what the Node endpoint verifies:
//   - Middleware (/api/data): signature + expiry (via _lib/session.js)
//     and current sessionVersion/disabled account status (via
//     _lib/accountStore.js) -- everything that's Edge-runtime safe (no
//     bcrypt, no fs, no Redis for the account lookup itself, though
//     accountStore.js's dual-read may consult Upstash's Edge-safe REST
//     client).
//   - Node endpoint (dashboard/api/data.js): the SAME identity checks
//     again, independently, PLUS the file-path allowlist, PER-FILE
//     location-of-request authorization (Multi-Location Authentication &
//     User Access System, Commit 4), and the actual file read. It does not
//     trust that middleware already approved the request.
//   - Neither layer does rate limiting here -- Upstash rate-limiting is
//     Node-only.
//
// ROLE GATE, Commit 4: this layer no longer restricts by role at all --
// every authenticated, non-disabled, current-sessionVersion account passes
// through to the Node layer, which is the ONLY place that can know which
// specific file/location a request concerns (this Edge check never reads
// req.query.file) and therefore the only place that can make the real
// per-file/per-location decision. A role/location-scoped account reaching
// past this coarse check is not yet "authorized" -- data.js's own allowlist
// and location check are still fully independent and authoritative.
//
// /data/* (legacy): no files exist there after this phase's migration, so
// there's nothing to gate -- this simply always 404s, matching requirement
// "direct requests to the old /data/* paths return 404".
//
// Matcher note: this used to also match /api/data/:path* (a dynamic
// catch-all route). That combination hit a confirmed Vercel platform bug --
// next() failed to route multi-segment catch-all requests to the
// underlying function at all -- so the data endpoint is now a single
// static path (/api/data, with the file identified by a ?file= query
// param) and the matcher below only needs an exact match for it.

import { next } from '@vercel/functions'
import { verifySession, SESSION_COOKIE } from './api/_lib/session.js'
import { getAccountById } from './api/_lib/accountStore.js'
import { resolveTenantId } from './api/_lib/tenants.js'

function parseCookieHeader(header) {
  const out = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
  }
  return out
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })
}

export default async function middleware(request) {
  const { pathname } = new URL(request.url)

  if (pathname.startsWith('/data/')) {
    return json(404, { error: 'not_found' })
  }

  // pathname === '/api/data' from here on (per the matcher below).
  const cookies = parseCookieHeader(request.headers.get('cookie'))
  const claims = await verifySession(cookies[SESSION_COOKIE])
  if (!claims) return json(401, { error: 'unauthenticated', message: 'Sign in required.' })

  const account = await getAccountById(claims.userId)
  if (!account || account.disabled) return json(401, { error: 'unauthenticated', message: 'Sign in required.' })
  if (account.sessionVersion !== claims.sessionVersion) {
    return json(401, { error: 'session_expired', message: 'Your session is no longer valid. Please sign in again.' })
  }
  // Multi-Tenant Phase 3: same tenant-claim verification as _lib/auth.js's
  // evaluateSession() -- a claim that doesn't match the account's freshly
  // re-derived current tenant is rejected here too, at the Edge, for the
  // same defense-in-depth reason this file duplicates the sessionVersion
  // check rather than trusting the Node layer alone. resolveTenantId() now
  // fails closed (throws) rather than defaulting to DEFAULT_TENANT_ID for
  // anything it cannot positively resolve (Phase 3 hardening) -- caught
  // here and treated as the same safe rejection, never an unhandled error.
  let currentTenantId
  try {
    currentTenantId = resolveTenantId(account)
  } catch {
    return json(401, { error: 'session_expired', message: 'Your session is no longer valid. Please sign in again.' })
  }
  if (claims.tenantId !== currentTenantId) {
    return json(401, { error: 'session_expired', message: 'Your session is no longer valid. Please sign in again.' })
  }

  // Passed the edge pre-check -- continue to the Node function, which
  // authoritatively re-verifies all of the above.
  return next()
}

export const config = {
  matcher: ['/data/:path*', '/api/data'],
}
