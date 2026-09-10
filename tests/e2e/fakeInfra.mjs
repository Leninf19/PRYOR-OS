// Phase 4L pilot-readiness harness -- local, non-production infrastructure
// ONLY. Wires the exact same _setRedisClientForTests()/_setBlobClientForTests()
// test seams every Node test file already uses (never a parallel mock layer)
// to a single shared in-memory Redis-shaped store and a single shared
// in-memory Blob-shaped store, so the REAL dashboard/api/**/*.js handlers run
// completely unmodified against fake infrastructure -- exactly what this
// phase's spec asks for ("prefer test/local infrastructure and fake
// provider/blob implementations where production credentials would
// otherwise be required").
//
// ONE shared store object is used for every _lib Redis-backed module
// (userStore, tenantConfigStore, credentialStore, auditLog, tokenStore,
// notificationStore, contentAssetStore, campaignStore, taskStore,
// contactStore, actionStore, publishBridgeStore) -- this mirrors production
// reality (one Upstash instance, one keyspace, every store's own key-naming
// convention already prevents collisions) rather than the per-file-isolated
// fakes individual Node test files use (those need isolation between
// unrelated test cases; this harness is one long-lived process standing in
// for one real Redis instance).
//
// No real Upstash, no real Vercel Blob, no real Google, no production data.

import * as userStore from '../../dashboard/api/_lib/userStore.js'
import * as tenantConfigStore from '../../dashboard/api/_lib/tenantConfigStore.js'
import * as credentialStore from '../../dashboard/api/_lib/credentialStore.js'
import * as auditLog from '../../dashboard/api/_lib/auditLog.js'
import * as tokenStore from '../../dashboard/api/_lib/tokenStore.js'
import * as notificationStore from '../../dashboard/api/_lib/notificationStore.js'
import * as contentAssetStore from '../../dashboard/api/_lib/contentAssetStore.js'
import * as campaignStore from '../../dashboard/api/_lib/campaignStore.js'
import * as taskStore from '../../dashboard/api/_lib/taskStore.js'
import * as contactStore from '../../dashboard/api/_lib/contactStore.js'
import * as actionStore from '../../dashboard/api/_lib/actionStore.js'
import * as publishBridgeStore from '../../dashboard/api/_lib/publishBridgeStore.js'
import * as locationDiscoveryStore from '../../dashboard/api/_lib/locationDiscoveryStore.js'
import * as blobStore from '../../dashboard/api/_lib/blobStore.js'

// Faithfully emulates BOTH of this codebase's atomic CAS Lua scripts:
//  - credentialStore.js's CREDENTIAL_CAS_SCRIPT: a plain key/value GET+SET,
//    args = [expectedVersionStr, nextJson]
//  - tenantConfigStore.js's CAS_UPSERT_SCRIPT: a hash HGET+HSET keyed by a
//    per-record field, args = [field, expectedVersionStr, nextJson]
// A synchronous JS function body is trivially atomic with respect to any
// other code in this single-threaded Node process, exactly as the real Lua
// script is atomic with respect to any other Redis client -- the same
// reasoning every existing CAS test file in tests/ already documents.
function makeSharedRedisStore() {
  const kv = {}
  const hashes = {}
  const lists = {}

  function currentVersionOf(raw) {
    if (!raw) return '0'
    try {
      const decoded = JSON.parse(raw)
      const v = decoded?.configVersion ?? decoded?.credentialVersion
      return v !== undefined ? String(v) : '0'
    } catch {
      return '0'
    }
  }

  return {
    get: async (key) => (key in kv ? kv[key] : null),
    set: async (key, value) => { kv[key] = value; return 'OK' },
    getdel: async (key) => { const v = key in kv ? kv[key] : null; delete kv[key]; return v },
    del: async (key) => {
      let existed = false
      if (key in kv) { delete kv[key]; existed = true }
      if (key in hashes) { delete hashes[key]; existed = true }
      if (key in lists) { delete lists[key]; existed = true }
      return existed ? 1 : 0
    },
    hget: async (key, field) => hashes[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(hashes[key] ?? {}) }),
    hset: async (key, fields) => { hashes[key] = { ...(hashes[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (hashes[key]) delete hashes[key][field] },
    // Only a trailing '*' glob is supported -- the one shape every caller
    // in this codebase (notificationStore.js's listReplyFailures prefix
    // scan) actually uses.
    keys: async (pattern) => {
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern
      const all = new Set([...Object.keys(kv), ...Object.keys(hashes), ...Object.keys(lists)])
      return [...all].filter(k => k.startsWith(prefix))
    },
    lrange: async (key, start, end) => {
      const l = lists[key] ?? []
      return end === -1 ? l.slice(start) : l.slice(start, end + 1)
    },
    lpush: async (key, val) => { lists[key] = [val, ...(lists[key] ?? [])]; return lists[key].length },
    ltrim: async () => 'OK',
    eval: async (_script, keys, args) => {
      const key = keys[0]
      if (args.length === 3) {
        const [field, expectedVersionStr, nextJson] = args
        const raw = hashes[key]?.[field] ?? null
        if (currentVersionOf(raw) !== expectedVersionStr) return raw ?? false
        hashes[key] = { ...(hashes[key] ?? {}), [field]: nextJson }
        return true
      }
      const [expectedVersionStr, nextJson] = args
      const raw = key in kv ? kv[key] : null
      if (currentVersionOf(raw) !== expectedVersionStr) return raw ?? false
      kv[key] = nextJson
      return true
    },
    // introspection only, for the harness's own seeding/debugging -- never
    // used by any _lib store itself.
    _dump: () => ({ kv: { ...kv }, hashes: JSON.parse(JSON.stringify(hashes)), lists: JSON.parse(JSON.stringify(lists)) }),
  }
}

function makeSharedBlobStore() {
  const objects = new Map()
  const client = {
    put: async (pathname, buffer, opts) => {
      objects.set(pathname, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))
      return {
        url: `https://fake.blob.pilot/${pathname}`,
        downloadUrl: `https://fake.blob.pilot/${pathname}`,
        pathname,
        contentType: opts?.contentType ?? 'application/octet-stream',
        contentDisposition: '',
        etag: `fake-etag-${objects.size}`,
      }
    },
    get: async (pathname, opts) => {
      if (!objects.has(pathname)) {
        if (opts?.access === 'private') return null
        throw new Error(`fake blob: not found: ${pathname}`)
      }
      const data = objects.get(pathname)
      return {
        statusCode: 200,
        stream: (function* () { yield data })(),
        headers: new Map(),
        blob: {
          url: pathname, downloadUrl: pathname, pathname,
          contentType: 'application/json', contentDisposition: '', cacheControl: '',
          size: data.length, uploadedAt: new Date(), etag: 'fake-etag',
        },
      }
    },
    del: async (pathname) => { objects.delete(pathname) },
  }
  return { client, objects }
}

let installed = null

// Wires every _lib store's own test seam to ONE shared fake Redis client and
// ONE shared fake Blob client. Idempotent -- calling twice just returns the
// already-installed instance, so seed scripts and the HTTP server (which
// import this module independently) always share the same fake infra.
export function installFakeInfra() {
  if (installed) return installed

  const redis = makeSharedRedisStore()
  const factory = () => redis
  userStore._setRedisClientForTests(factory)
  tenantConfigStore._setRedisClientForTests(factory)
  credentialStore._setRedisClientForTests(factory)
  auditLog._setRedisClientForTests(factory)
  tokenStore._setRedisClientForTests(factory)
  notificationStore._setRedisClientForTests(factory)
  contentAssetStore._setRedisClientForTests(factory)
  campaignStore._setRedisClientForTests(factory)
  taskStore._setRedisClientForTests(factory)
  contactStore._setRedisClientForTests(factory)
  actionStore._setRedisClientForTests(factory)
  publishBridgeStore._setRedisClientForTests(factory)
  locationDiscoveryStore._setRedisClientForTests(factory)

  const blob = makeSharedBlobStore()
  blobStore._setBlobClientForTests(() => blob.client)

  installed = { redis, blob }
  return installed
}

// Deliberately no uninstall/reset export -- this harness is a single
// long-lived local process standing in for one persistent environment
// (unlike Node test files, which reset between every test case). If you
// need a clean slate, restart the harness process.

// --- Fake Google OAuth + My Business API --------------------------------
//
// Same interception point every existing Node test file already uses
// (globalThis.fetch), generalized to serve MULTIPLE tenants/credentials at
// once from one long-lived process (a real browser session can have Tenant
// A and Tenant B connecting "simultaneously"). Keyed by refresh token so
// two concurrent OAuth flows never cross-contaminate.
//
// registerGoogleAccount(refreshToken, accountsMap) where accountsMap is
// { [accountResourceName]: [{name, title, storefrontAddress?}, ...] } --
// the exact shape googleLocationDiscovery.js/google/[action].js expects
// back from Google's My Business Account Management / Business Information
// APIs (see tests/test_google_reconnect_reconciliation.js's mockGoogleFetch
// for the precedent this generalizes).
const googleFixturesByRefreshToken = new Map()
const googleFixturesByAuthCode = new Map()

export function registerGoogleFixture({ authCode, refreshToken, accessToken, accounts }) {
  const fixture = { refreshToken, accessToken: accessToken ?? `fake-access-${refreshToken}`, accounts }
  googleFixturesByRefreshToken.set(refreshToken, fixture)
  if (authCode) googleFixturesByAuthCode.set(authCode, fixture)
}

let googleFetchInstalled = false
export function installFakeGoogleFetch() {
  if (googleFetchInstalled) return
  googleFetchInstalled = true
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('oauth2.googleapis.com/token')) {
      // Both grant types this codebase uses (google/[action].js's callback()
      // for authorization_code, googleAuth.js's exchangeRefreshToken() for
      // refresh_token) send a JSON body, never form-encoded.
      let payload = {}
      try { payload = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') } catch { /* leave empty */ }
      const fixture = (payload.code && googleFixturesByAuthCode.get(payload.code))
        ?? (payload.refresh_token && googleFixturesByRefreshToken.get(payload.refresh_token))
      if (!fixture) return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'no fake fixture registered for this code/refresh_token' }) }
      // Real Google only issues a NEW refresh_token on the authorization_code
      // grant -- an ongoing refresh_token-grant exchange returns access_token
      // only, matching googleAuth.js's getAccessToken() (which only ever
      // reads d.access_token).
      const body = payload.grant_type === 'authorization_code'
        ? { access_token: fixture.accessToken, refresh_token: fixture.refreshToken, expires_in: 3600 }
        : { access_token: fixture.accessToken, expires_in: 3600 }
      return { ok: true, status: 200, json: async () => body }
    }
    // Every subsequent call authenticates with `Bearer <access_token>` --
    // resolve back to the fixture by access token so accounts/locations
    // calls route to the right tenant's fake Google account.
    const authHeader = init?.headers?.Authorization ?? init?.headers?.authorization ?? ''
    const accessToken = authHeader.replace(/^Bearer\s+/i, '')
    const fixture = [...googleFixturesByRefreshToken.values()].find(f => f.accessToken === accessToken)
    if (u.includes('mybusinessaccountmanagement.googleapis.com') && u.includes('/accounts')) {
      if (!fixture) return { ok: false, status: 401, json: async () => ({ error: { code: 401, message: 'fake: unrecognized access token' } }) }
      return { ok: true, status: 200, json: async () => ({ accounts: Object.keys(fixture.accounts).map(name => ({ name, accountName: name })) }) }
    }
    if (fixture) {
      const acctMatch = Object.keys(fixture.accounts).find(name => u.includes(`${name}/locations`))
      if (acctMatch) return { ok: true, status: 200, json: async () => ({ locations: fixture.accounts[acctMatch] }) }
    }
    if (realFetch) return realFetch(url, init)
    throw new Error(`fake Google fetch: unhandled URL in local pilot harness: ${u}`)
  }
}
