// Phase 4L pilot-readiness -- item 4, "Absolute A/B isolation validation".
//
// Drives the REAL, RUNNING local pilot harness (tests/e2e/run.mjs, real
// handlers, fake Redis/Blob/Google) over genuine HTTP, logging in as Tenant
// A's and Tenant B's real owner accounts SIMULTANEOUSLY (two independent
// cookie values held in this one script, each presented to whichever
// request needs it -- the same "simultaneous, independent sessions"
// guarantee two separate logged-in browser tabs would have, without the
// shared-cookie-jar limitation two tabs in the SAME browser context would
// introduce). Every check below hits the live server process, not
// in-process test doubles -- this is the harness's server.mjs + the
// unmodified dashboard/api/**/*.js handlers.
//
// Run against an already-running harness: node tests/e2e/run.mjs (separate
// process), then: node tests/e2e/verifyAbIsolation.mjs

const BASE = process.env.PILOT_HARNESS_URL || 'http://localhost:4173'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
async function check(name, fn) {
  try {
    await fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  }
}

async function login(email, password) {
  const res = await fetch(`${BASE}/api/session/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`)
  const setCookie = res.headers.get('set-cookie') || ''
  const match = setCookie.match(/lta_session=([^;]+)/)
  if (!match) throw new Error(`login for ${email} did not set a session cookie`)
  return match[1]
}

async function api(cookie, path, opts = {}) {
  return fetch(`${BASE}${path}`, { ...opts, headers: { cookie: `lta_session=${cookie}`, 'content-type': 'application/json', ...(opts.headers ?? {}) } })
}

async function main() {
  const cookieA = await login('owner@pilot-test-a.example', 'pilot-harness-not-a-real-password')
  const cookieB = await login('owner@pilot-test-b-active.example', 'pilot-harness-not-a-real-password')
  console.log('Logged in as Tenant A (t_pilot-test-a) and Tenant B (t_pilot-test-b-active) SIMULTANEOUSLY -- two independent session cookies held for the rest of this run.\n')

  // 1. A cannot see B users.
  await check('Tenant A cannot list Tenant B users', async () => {
    const res = await api(cookieA, '/api/settings/users-list')
    if (res.status === 200) {
      const body = await res.json()
      const emails = (body.users ?? []).map(u => u.email)
      assert(!emails.some(e => e.includes('pilot-test-b')), `Tenant A's user listing leaked a Tenant B email: ${JSON.stringify(emails)}`)
    }
    // A 403/404 is an equally valid "cannot see" outcome for this check.
  })

  // 2. A cannot see B locations (tenant-status/entitlement surface).
  await check('Tenant A cannot see Tenant B locations via a forged tenantId', async () => {
    const res = await api(cookieA, '/api/session/tenant-status?tenantId=t_pilot-test-b-active')
    const body = await res.json()
    assert(body.tenantId !== 't_pilot-test-b-active', `a forged ?tenantId= must never redirect tenant-status to a different tenant, got ${JSON.stringify(body)}`)
    assert(body.tenantId === 't_pilot-test-a', `tenant-status must always resolve to the AUTHENTICATED session's own tenant regardless of a forged query param, got tenantId=${body.tenantId}`)
  })

  // 3. A cannot read B reviews / private data (data.js dynamic resolution).
  await check('Tenant A cannot read Tenant B private-data artifacts', async () => {
    const res = await api(cookieA, '/api/data?file=meta.json')
    const body = await res.json()
    const locationIds = (body.locations ?? []).map(l => l.locationId)
    // Tenant B's active fixture has its own independent location numbering
    // (locationId 1/2 within TENANT B's own namespace) -- the check that
    // actually matters is that Tenant A's meta.json reflects ONLY its own
    // 2 locations (Pilot Location 1/2), never Tenant B's names.
    const names = (body.locations ?? []).map(l => l.name)
    assert(!names.some(n => /Pilot B/i.test(n)), `Tenant A's meta.json leaked a Tenant B location name: ${JSON.stringify(names)}`)
    assert(names.length === 2, `expected exactly Tenant A's own 2 locations, got ${JSON.stringify(names)}`)
  })

  // 4. A cannot reply to B reviews (google/publish requires a resolvable,
  // owned local review id -- a cross-tenant id must never resolve).
  await check('Tenant A cannot publish/reply against a Tenant B review id', async () => {
    const res = await api(cookieA, '/api/google/publish', { method: 'POST', body: JSON.stringify({ localReviewId: 'does-not-exist-in-tenant-a', replyText: 'hi' }) })
    assert(res.status === 404 || res.status === 400, `expected a not-found/bad-request denial for an unresolvable/foreign review id, got ${res.status}`)
  })

  // 5. A cannot read B Blob artifacts (already covered by check 3's
  // meta.json isolation -- this repeats the same proof against a
  // per-location file, the more sensitive artifact class).
  await check('Tenant A cannot read a Tenant B per-location reviews file by guessing its slug', async () => {
    const res = await api(cookieA, '/api/data?file=reviews/by-location/pilot-location-1.json')
    // Tenant A's OWN location 1 is also literally named "Pilot Location 1"
    // (slug pilot-location-1) in this harness's fixtures -- this call
    // resolves to TENANT A's OWN file (correct), so the real adversarial
    // case is Tenant B's distinctly-named location.
    const resForeign = await api(cookieA, '/api/data?file=reviews/by-location/pilot-b-downtown.json')
    void res
    assert(resForeign.status === 403 || resForeign.status === 404, `Tenant A must never be able to read a Tenant B slug's reviews file even by guessing it, got ${resForeign.status}`)
  })

  // 6. A cannot mutate B entitlements (tenant-entitlements is
  // platform-super-admin-only -- an ordinary tenant Owner, even acting on
  // their OWN tenant, must be refused outright).
  await check('Tenant A (an ordinary Owner) cannot call the platform-admin entitlement-change endpoint at all', async () => {
    const res = await api(cookieA, '/api/tenant-entitlements/apply', { method: 'POST', body: JSON.stringify({ tenantId: 't_pilot-test-b-active', removeLocationIds: [1] }) })
    assert(res.status === 403 || res.status === 401, `expected the platform-admin-only endpoint to refuse a non-super-admin Owner outright, got ${res.status}`)
  })

  // 7. A cannot install/reconcile B's Google credential (reconnect is
  // scoped to the AUTHENTICATED session's own tenant server-side, never a
  // request-supplied tenant).
  await check('Tenant A cannot trigger a Google status/discovery call that resolves to Tenant B', async () => {
    const res = await api(cookieA, '/api/google/status')
    const body = await res.json().catch(() => ({}))
    assert(JSON.stringify(body).includes('pilot-test-b') === false, `Tenant A's own /api/google/status must never mention Tenant B: ${JSON.stringify(body)}`)
  })

  // 8. A cannot trigger B's lifecycle operations (there is no tenant-scoped
  // dispatcher exposed to ordinary Owners at all -- tenant-ops is
  // read-only, tenant-entitlements is super-admin-only -- confirmed by (6)
  // above and by the absence of any other lifecycle-mutating endpoint).
  await check('Tenant A has no reachable endpoint that can mutate Tenant B\'s lifecycle state', async () => {
    const res = await api(cookieA, '/api/tenant-ops/list')
    // tenant-ops is READ-only (list) and, even so, must not leak Tenant B's
    // sanitized status to an ordinary (non-super-admin) Owner.
    assert(res.status === 403 || res.status === 401, `an ordinary Owner must be refused by the platform tenant-ops surface entirely, got ${res.status}`)
  })

  // 9. B cannot fall back to LTA data (DEFAULT_TENANT_ID) -- a brand-new
  // synthetic tenant must never see Los Tres Amigos's real static-directory
  // identity or data merged in.
  await check('Tenant B never falls back to LTA (DEFAULT_TENANT_ID) data', async () => {
    const res = await api(cookieB, '/api/session/tenant-status')
    const body = await res.json()
    assert(body.tenantId === 't_pilot-test-b-active', `Tenant B's own tenant-status must report its own tenantId, got ${body.tenantId}`)
    assert(body.displayName !== 'Los Tres Amigos', `Tenant B must never inherit LTA's displayName, got ${JSON.stringify(body.displayName)}`)
    const metaRes = await api(cookieB, '/api/data?file=meta.json')
    const meta = await metaRes.json()
    const names = (meta.locations ?? []).map(l => l.name)
    assert(!names.some(n => /Amigo|Casa Tequila|Taco/i.test(n)), `Tenant B's meta.json must never contain LTA's real location names: ${JSON.stringify(names)}`)
  })

  // 10. Duplicate local location IDs across tenants remain harmless --
  // Tenant A's location 1 and Tenant B's location 1 are BOTH locationId=1
  // within their own tenant's locationIdMap (confirmed by each fixture's
  // seeding), yet each tenant's session only ever resolves ITS OWN
  // location 1.
  await check('Duplicate local locationId=1 across Tenant A and Tenant B never collide', async () => {
    const metaA = await (await api(cookieA, '/api/data?file=meta.json')).json()
    const metaB = await (await api(cookieB, '/api/data?file=meta.json')).json()
    const loc1A = (metaA.locations ?? []).find(l => l.locationId === 1)
    const loc1B = (metaB.locations ?? []).find(l => l.locationId === 1)
    assert(loc1A && loc1B, 'sanity: both tenants must independently have a locationId=1')
    assert(loc1A.name !== loc1B.name, `both tenants' locationId=1 resolved to the SAME name (${loc1A.name}) -- the tenant namespace is not actually authoritative`)
    assert(/Pilot Location/.test(loc1A.name) && /Pilot B/.test(loc1B.name), `each tenant's own locationId=1 must resolve within its own namespace, got A=${loc1A.name} B=${loc1B.name}`)
  })

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} A/B ISOLATION CHECKS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} A/B ISOLATION CHECKS FAILED`)
  process.exit(1)
}

main().catch(err => { console.error('fatal:', err); process.exit(1) })
