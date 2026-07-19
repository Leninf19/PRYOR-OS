// Vercel Edge Middleware -- runs before routing/rewrites for any matched
// path, which is exactly why it's needed here and not just "delete the
// files and let it 404 naturally": dashboard/vercel.json's SPA rewrite
// (`/((?!api/).*)` -> /index.html) would otherwise catch a request for a
// no-longer-existing /data/*.json file and serve index.html with a 200,
// not a 404. This runs first and short-circuits that.
//
// This is DEFENSE IN DEPTH / a legacy-path guard, not the primary security
// boundary -- dashboard/api/data/[...path].js (Node) is authoritative and
// independently re-verifies everything below itself; it never assumes
// middleware already ran (a matcher typo or a future route outside it must
// not silently lose protection).
//
// What this file verifies vs. what the Node endpoint verifies:
//   - Middleware (/api/data/*): signature + expiry (via _lib/session.js)
//     and current sessionVersion/disabled/role (via _lib/accounts.js) --
//     everything that's Edge-runtime safe (no bcrypt, no fs, no Redis).
//   - Node endpoint (dashboard/api/data/[...path].js): the SAME checks
//     again, independently, PLUS the file-path allowlist and the actual
//     file read. It does not trust that middleware already approved the
//     request.
//   - Neither layer does rate limiting here -- Upstash is Node-only.
//
// /data/* (legacy): no files exist there after this phase's migration, so
// there's nothing to gate -- this simply always 404s, matching requirement
// "direct requests to the old /data/* paths return 404".

import { next } from '@vercel/functions'
import { verifySession, SESSION_COOKIE } from './api/_lib/session.js'
import { loadAccountDirectory, findAccountById } from './api/_lib/accounts.js'

const ALLOWED_ROLES = ['owner', 'marketing']

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

  // TEMPORARY DIAGNOSTIC (see Phase 1 /api/data/* routing investigation --
  // remove once root cause is confirmed). Logs no secrets/cookie values,
  // only whether a cookie header is present at all.
  console.log(`[middleware-diag] pathname=${pathname} method=${request.method} hasCookie=${Boolean(request.headers.get('cookie'))} segments=${pathname.split('/').filter(Boolean).length}`)

  if (pathname.startsWith('/data/')) {
    return json(404, { error: 'not_found' })
  }

  // pathname.startsWith('/api/data/') from here on (per the matcher below).
  const cookies = parseCookieHeader(request.headers.get('cookie'))
  const claims = await verifySession(cookies[SESSION_COOKIE])
  if (!claims) return json(401, { error: 'unauthenticated', message: 'Sign in required.' })

  const accounts = loadAccountDirectory()
  if (!accounts) return json(401, { error: 'unauthenticated', message: 'Sign in required.' })

  const account = findAccountById(accounts, claims.userId)
  if (!account || account.disabled) return json(401, { error: 'unauthenticated', message: 'Sign in required.' })
  if (account.sessionVersion !== claims.sessionVersion) {
    return json(401, { error: 'session_expired', message: 'Your session is no longer valid. Please sign in again.' })
  }
  if (!ALLOWED_ROLES.includes(account.role)) {
    return json(403, { error: 'forbidden', message: 'You do not have permission to view this.' })
  }

  // TEMPORARY DIAGNOSTIC (see above -- remove with the rest of this pass).
  console.log(`[middleware-diag] passed edge pre-check, calling next() for pathname=${pathname}`)

  // Passed the edge pre-check -- continue to the Node function, which
  // authoritatively re-verifies all of the above.
  return next()
}

export const config = {
  matcher: ['/data/:path*', '/api/data/:path*'],
}
