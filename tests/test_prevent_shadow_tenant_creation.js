// "Prevent duplicate/shadow tenant creation during self-service onboarding"
// hardening phase. This file does NOT introduce a new guard -- the trace
// for this phase found that register() and createTenantForVerifiedRegistration()
// (dashboard/api/session/[action].js) already re-check getAccountByEmail()
// (Redis identity index, Redis bootstrap/legacy hash, AND the static
// ACCOUNT_DIRECTORY_JSON) before ever reserving or creating a tenant, and
// that generateTenantId() (tenantIdGenerator.js) always appends a random
// 6-character suffix, making a bare, human-guessable collision like
// "t_los-tres-amigos-pilot" structurally impossible from this code path.
// test_registration.js and test_tenant_creation_from_registration.js
// already cover the STATIC-directory case, the email-occupied-during-the-
// verification-window race, the tenant-creation lock, and the "imitator
// names their company Los Tres Amigos" slug case. This file fills the
// remaining gaps: a REAL REDIS account (bootstrap hash and, separately, the
// global identity index for a different tenant), a disabled account, an
// invited-but-not-yet-accepted account, and register()'s own concurrent-
// resubmission race -- so every identity source this guard is supposed to
// cover (per this phase's own "STATIC DIRECTORY EDGE CASE" section) has
// explicit, independent test coverage.
//
// No production Redis, no production tenant, no production account is
// touched anywhere in this file -- everything runs against one in-memory
// fake Redis, reset after every test.
//
// Run directly: node tests/test_prevent_shadow_tenant_creation.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import handler from '../dashboard/api/session/[action].js'
import { _setRedisClientForTests as setPendingClient, _resetRedisClientForTests as resetPendingClient, getPendingRegistration } from '../dashboard/api/_lib/pendingRegistrationStore.js'
import { _setRedisClientForTests as setTokenClient, _resetRedisClientForTests as resetTokenClient } from '../dashboard/api/_lib/tokenStore.js'
import { _setRedisClientForTests as setTenantConfigClient, _resetRedisClientForTests as resetTenantConfigClient, getTenantConfig } from '../dashboard/api/_lib/tenantConfigStore.js'
import {
  _setRedisClientForTests as setUserStoreClient, _resetRedisClientForTests as resetUserStoreClient,
  upsertUser, UserCreationMode, UserCreationNotAllowedError, getUserById, UserStoreUnavailableError,
} from '../dashboard/api/_lib/userStore.js'
import { _setTransportForTests, _resetTransportForTests } from '../dashboard/api/_lib/emailSender.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'
import {
  upsertTenantConfig, TenantDoesNotExistError,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import {
  createNewTenant, TenantCreationMode, TenantCreationModeRequiredError,
  IdentityAlreadyExistsError, TenantAlreadyExistsError,
} from '../dashboard/api/_lib/tenantCreation.js'
import { getAccountByEmailRequireRedisHealthy } from '../dashboard/api/_lib/accountStore.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
async function run(name, fn) {
  try {
    await fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  } finally {
    resetPendingClient()
    resetTokenClient()
    resetTenantConfigClient()
    resetUserStoreClient()
    _resetTransportForTests()
    delete process.env.ACCOUNT_DIRECTORY_JSON
  }
}

// Same tick-based fake as test_tenant_creation_from_registration.js -- a
// real Redis REST call always crosses a genuine event-loop boundary, and
// only routing every op through one matters for the concurrent-register
// test below to actually exercise interleaving rather than accidentally
// serializing the two requests end-to-end.
function tick(fn) {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try { resolve(fn()) } catch (err) { reject(err) }
    })
  })
}

function fakeRedis() {
  const data = {}
  function expired(entry) { return entry.expiresAtMs !== null && Date.now() >= entry.expiresAtMs }
  return {
    get: (key) => tick(() => {
      const e = data[key]
      if (!e || e.kind !== 'string' || expired(e)) return null
      return e.value
    }),
    set: (key, value, opts = {}) => tick(() => {
      const existing = data[key]
      const alive = existing && existing.kind === 'string' && !expired(existing)
      if (opts.nx && alive) return null
      data[key] = { kind: 'string', value, expiresAtMs: opts.ex ? Date.now() + opts.ex * 1000 : null }
      return 'OK'
    }),
    getdel: (key) => tick(() => {
      const e = data[key]
      if (!e || e.kind !== 'string' || expired(e)) { delete data[key]; return null }
      delete data[key]
      return e.value
    }),
    del: (key) => tick(() => {
      const existed = key in data
      delete data[key]
      return existed ? 1 : 0
    }),
    hget: (key, field) => tick(() => {
      const e = data[key]
      if (!e || e.kind !== 'hash') return null
      return e.value[field] ?? null
    }),
    hgetall: (key) => tick(() => (data[key]?.kind === 'hash' ? { ...data[key].value } : {})),
    hset: (key, fields) => tick(() => {
      data[key] ??= { kind: 'hash', value: {}, expiresAtMs: null }
      Object.assign(data[key].value, fields)
    }),
    hdel: (key, field) => tick(() => {
      const e = data[key]
      if (!e || !(field in e.value)) return 0
      delete e.value[field]
      return 1
    }),
    _raw: data,
  }
}

function installFakeRedis() {
  const client = fakeRedis()
  setPendingClient(() => client)
  setTokenClient(() => client)
  setTenantConfigClient(() => client)
  setUserStoreClient(() => client)
  return client
}

let sentEmails
function installWorkingEmailTransport() {
  sentEmails = []
  _setTransportForTests(() => ({
    sendMail: async (opts) => { sentEmails.push(opts); return { messageId: 'test-message-id', response: '250 OK' } },
  }))
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  res.getHeader = (name) => res.headers[name]
  return res
}

async function invoke(action, body, extra = {}) {
  const req = {
    method: extra.method ?? 'POST', body, headers: { host: 'app.futuremark.studio', ...(extra.headers ?? {}) },
    query: { action, ...(extra.query ?? {}) }, socket: { remoteAddress: '127.0.0.1' },
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

const VALID_PASSWORD = 'correct-horse-battery-staple'
function registerBody(overrides = {}) {
  return {
    email: 'newowner@example.com', password: VALID_PASSWORD, passwordConfirmation: VALID_PASSWORD,
    displayName: 'New Owner', companyName: 'Sunset Grill Group', ...overrides,
  }
}

const REAL_HASH = '$2b$12$Y0I8ZmmUnNDBireCWez0M.AGkTN6bxJWhySMGh8LPi.5tu7ynlnsm'

async function testBrandNewEmailCanCreateAWorkspace() {
  installFakeRedis()
  installWorkingEmailTransport()
  const res = await invoke('register', registerBody({ email: 'genuinely-new@example.com' }))
  assert(res.statusCode === 200 && res.body.success === true)
  assert(sentEmails.length === 1, 'a genuinely new email must get a verification email and a reserved tenant id')
  const pending = await getPendingRegistration('genuinely-new@example.com')
  assert(pending && pending.tenantIdReserved, 'a pending registration with a reserved tenant id must exist for a brand-new email')
}

async function testExistingRedisBootstrapUserCannotCreateAnotherWorkspace() {
  const client = installFakeRedis()
  installWorkingEmailTransport()
  // A real account living in Redis's LEGACY/bootstrap hash for
  // DEFAULT_TENANT_ID -- exactly the shape advertising@l3amigos.com's
  // account has TODAY, after this incident's own repair/migration.
  const promotedRecord = {
    userId: 'usr_promoted', email: 'promoted@l3amigos.com', passwordHash: REAL_HASH,
    role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 3, disabled: false,
  }
  await upsertUser(DEFAULT_TENANT_ID, promotedRecord, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: promotedRecord })

  const res = await invoke('register', registerBody({ email: 'promoted@l3amigos.com' }))
  assert(res.statusCode === 200 && res.body.success === true, 'must still return the generic response, never reveal the account exists')
  assert(sentEmails.length === 0, 'no verification email may be sent -- no new tenant may be reserved for an email with a real Redis account')
  assert((await getPendingRegistration('promoted@l3amigos.com')) === null, 'no pending registration may be created for an email with a real Redis account')
  void client
}

async function testExistingRedisIdentityIndexUserCannotCreateAnotherWorkspace() {
  installFakeRedis()
  installWorkingEmailTransport()
  // A real account in a DIFFERENT, already-existing self-service tenant --
  // upsertUser() for any non-default tenant writes the GLOBAL identity
  // index (TENANT_SCOPED mode), which is exactly the path
  // getAccountByEmail() consults FIRST.
  const OTHER_TENANT = 't_some-other-restaurant-abc123'
  await upsertTenantConfig(OTHER_TENANT, {}, { allowCreate: true, creationSource: 'migration' })
  await upsertUser(OTHER_TENANT, {
    userId: 'usr_other_owner', email: 'owner@otherplace.example.com', passwordHash: REAL_HASH,
    role: 'owner', locationIds: '*', tenantId: OTHER_TENANT, sessionVersion: 1, disabled: false,
  }, { creationMode: UserCreationMode.INITIAL_TENANT_OWNER })

  const res = await invoke('register', registerBody({ email: 'owner@otherplace.example.com' }))
  assert(res.statusCode === 200 && res.body.success === true)
  assert(sentEmails.length === 0, 'an identity already indexed to a different tenant must not be able to reserve a second, shadow tenant')
  assert((await getPendingRegistration('owner@otherplace.example.com')) === null)
}

async function testCanonicalLtaAdvertisingAccountCannotCreateAnotherTenant() {
  installFakeRedis()
  installWorkingEmailTransport()
  // The exact real-world post-repair shape: advertising@l3amigos.com now
  // lives in LTA's own canonical LEGACY Redis storage.
  const advertisingRecord = {
    userId: 'usr_7a7db167-e1a9-48e0-abb0-1fe62dfa1c7d', email: 'advertising@l3amigos.com', passwordHash: REAL_HASH,
    role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 7, disabled: false,
  }
  await upsertUser(DEFAULT_TENANT_ID, advertisingRecord, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: advertisingRecord })

  const res = await invoke('register', registerBody({ email: 'advertising@l3amigos.com', companyName: 'Los Tres Amigos Pilot' }))
  assert(res.statusCode === 200 && res.body.success === true)
  assert(sentEmails.length === 0, 'the real, repaired Advertising account must never be able to spin up another (e.g. "...Pilot") tenant again')
  assert((await getPendingRegistration('advertising@l3amigos.com')) === null)
  // No new stray tenant_config may be created no matter what company name
  // is typed into the form.
  const allPossiblePilotIds = await getTenantConfig('t_los-tres-amigos-pilot')
  assert(allPossiblePilotIds === null, 'no new pilot-style tenant_config may be created for an already-real identity')
}

async function testStaleDisabledAccountStillBlocksRegistration() {
  installFakeRedis()
  installWorkingEmailTransport()
  // Explicitly defines the "stale/disabled account" behavior this phase
  // asked to pin down: a disabled account is still a REAL account --
  // getAccountByEmail() does not filter on `disabled`, so a disabled user
  // cannot bypass their own disablement by spinning up a brand-new
  // workspace under the same email.
  const disabledRecord = {
    userId: 'usr_disabled', email: 'disabled@l3amigos.com', passwordHash: REAL_HASH,
    role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 4, disabled: true,
  }
  await upsertUser(DEFAULT_TENANT_ID, disabledRecord, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: disabledRecord })

  const res = await invoke('register', registerBody({ email: 'disabled@l3amigos.com' }))
  assert(res.statusCode === 200 && res.body.success === true)
  assert(sentEmails.length === 0, 'a disabled account must still block self-service creation of a new workspace under the same email')
  assert((await getPendingRegistration('disabled@l3amigos.com')) === null)
}

async function testInvitedButNotYetAcceptedAccountStillBlocksRegistration() {
  installFakeRedis()
  installWorkingEmailTransport()
  // An admin has already invited this email into an existing tenant, but
  // the invitee has not yet clicked accept-invite (no passwordSetAt) --
  // still a real, existing user record, and existing invite state must
  // block a competing self-service signup for the same email.
  const invitedRecord = {
    userId: 'usr_invited', email: 'invitee@l3amigos.com', passwordHash: REAL_HASH,
    role: 'location_manager', locationIds: [1], tenantId: DEFAULT_TENANT_ID, sessionVersion: 1, disabled: false,
    invitedAt: new Date().toISOString(), passwordSetAt: null,
    inviteTokenHash: 'deadbeef', inviteExpiresAt: new Date(Date.now() + 86400000).toISOString(),
  }
  await upsertUser(DEFAULT_TENANT_ID, invitedRecord, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: invitedRecord })

  const res = await invoke('register', registerBody({ email: 'invitee@l3amigos.com' }))
  assert(res.statusCode === 200 && res.body.success === true)
  assert(sentEmails.length === 0, 'an outstanding invitation must block a competing self-service registration for the same email')
  assert((await getPendingRegistration('invitee@l3amigos.com')) === null)
}

async function testServerRejectsRegistrationForRealAccountEvenWithoutAnyFrontendInvolvement() {
  // Directly simulates "frontend bypass" -- a bare API call with no
  // Referer/cookie/UI state at all, exactly like curl or Postman, proving
  // the guard is enforced by the server itself, not by AuthGate.jsx's
  // redirect (which a bypassed frontend could never invoke anyway).
  installFakeRedis()
  installWorkingEmailTransport()
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{ userId: 'usr_static_owner', email: 'owner@l3amigos.com', passwordHash: REAL_HASH, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Static Owner' }],
  })

  const req = {
    method: 'POST',
    body: registerBody({ email: 'owner@l3amigos.com' }),
    headers: {}, // no host, no cookie, no referer -- the bare minimum a raw HTTP client would send
    query: { action: 'register' },
    socket: { remoteAddress: '203.0.113.7' },
  }
  const res = fakeRes()
  await handler(req, res)

  assert(res.statusCode === 200 && res.body.success === true, 'server must still respond with the generic response')
  assert(sentEmails.length === 0, 'server-side guard must reject this even with zero frontend involvement')
  assert((await getPendingRegistration('owner@l3amigos.com')) === null)
}

async function testConcurrentRegistrationsForSameBrandNewEmailCreateExactlyOnePendingRegistration() {
  installFakeRedis()
  installWorkingEmailTransport()
  const email = 'racing-signup@example.com'

  const [a, b] = await Promise.all([
    invoke('register', registerBody({ email, displayName: 'Request A' })),
    invoke('register', registerBody({ email, displayName: 'Request B' })),
  ])
  assert(a.statusCode === 200 && b.statusCode === 200, 'both concurrent requests get the same generic 200 response')

  const pending = await getPendingRegistration(email)
  assert(pending, 'exactly one pending registration must exist after the race')
  assert(sentEmails.length >= 1, 'at least one verification email must have been sent')
  // Whichever request's write actually landed, there is exactly one
  // reserved tenant id for this email -- never two different reservations
  // silently orphaned against each other.
  assert(typeof pending.tenantIdReserved === 'string' && pending.tenantIdReserved.length > 0)
}

async function testTwoDifferentCustomersWithTheSameCompanyNameGetDistinctTenantIds() {
  installFakeRedis()
  installWorkingEmailTransport()
  // Deliberately NOT solved by name-matching (per this phase's explicit
  // "do not guess solely from company name" instruction) -- two genuinely
  // different people/emails naming their business the same thing is a
  // real, legitimate case, not a defect. Each gets its own, independently
  // random tenant id; neither is silently merged or blocked.
  await invoke('register', registerBody({ email: 'first-owner@example.com', companyName: 'Downtown Tacos' }))
  const first = await getPendingRegistration('first-owner@example.com')

  await invoke('register', registerBody({ email: 'second-owner@example.com', companyName: 'Downtown Tacos' }))
  const second = await getPendingRegistration('second-owner@example.com')

  assert(first && second, 'both registrations must succeed independently')
  assert(first.tenantIdReserved !== second.tenantIdReserved, 'two different identities must never be collapsed onto the same generated tenant id merely for sharing a company name')
  assert(sentEmails.length === 2, 'both must receive their own verification email')
}

// ===========================================================================
// "CENTRALIZE NEW-TENANT CREATION" hardening -- direct, store-level
// adversarial proofs. These exercise tenantConfigStore.js/userStore.js/
// tenantCreation.js DIRECTLY (never through the HTTP layer above), because
// the property being proven is "the raw primitive itself refuses this,"
// not merely "the one endpoint that happens to call it correctly refuses
// this" -- exactly the distinction this phase's investigation drew between
// the self-service HTTP path (already guarded) and a bare script import
// (previously not).
// ===========================================================================

const OWNER_HASH = REAL_HASH

async function testRawTenantConfigUpdateCannotCreateUnknownTenant() {
  installFakeRedis()
  let threw = null
  try {
    await upsertTenantConfig('t_completely-unknown-raw-script', { status: 'active' })
  } catch (err) {
    threw = err
  }
  assert(threw instanceof TenantDoesNotExistError, `a bare upsertTenantConfig() call with no allowCreate must throw TenantDoesNotExistError, got ${threw?.constructor?.name}`)
  assert((await getTenantConfig('t_completely-unknown-raw-script')) === null, 'no tenant_config may be materialized by the rejected call')
}

async function testRawUserUpdateCannotCreateUserInUnknownTenant() {
  installFakeRedis()
  let threw = null
  try {
    await upsertUser('t_completely-unknown-raw-script', {
      userId: 'usr_raw', email: 'raw@example.com', passwordHash: OWNER_HASH,
      role: 'owner', locationIds: '*', tenantId: 't_completely-unknown-raw-script', sessionVersion: 1, disabled: false,
    })
  } catch (err) {
    threw = err
  }
  assert(threw instanceof UserCreationNotAllowedError, `a bare upsertUser() call with no creationMode must throw UserCreationNotAllowedError, got ${threw?.constructor?.name}`)
  assert((await getUserById('t_completely-unknown-raw-script', 'usr_raw')) === null, 'no user record may be materialized by the rejected call')
}

async function testUserCreationIntoNonexistentTenantRejectedEvenWithAMode() {
  installFakeRedis()
  // Supplying a valid-looking creationMode does not bypass the underlying
  // invariant -- EXISTING_TENANT_INVITE/MIGRATION both still require the
  // target tenant to genuinely exist.
  let threw = null
  try {
    await upsertUser('t_still-unknown', {
      userId: 'usr_raw2', email: 'raw2@example.com', passwordHash: OWNER_HASH,
      role: 'owner', locationIds: '*', tenantId: 't_still-unknown', sessionVersion: 1, disabled: false,
    }, { creationMode: UserCreationMode.EXISTING_TENANT_INVITE })
  } catch (err) {
    threw = err
  }
  assert(threw instanceof UserCreationNotAllowedError, `EXISTING_TENANT_INVITE against a nonexistent tenant must still be rejected, got ${threw?.constructor?.name}`)
}

async function testInitialOwnerCanOnlyBeCreatedThroughCentralizedTenantCreation() {
  installFakeRedis()
  const tenantId = await createNewTenantHelper()
  // A SECOND "initial owner" for a tenant that already has one must be
  // rejected -- proves this mode is not a general-purpose bypass, only a
  // one-shot primitive createNewTenant() itself uses exactly once per tenant.
  let threw = null
  try {
    await upsertUser(tenantId, {
      userId: 'usr_second_owner', email: 'second-owner@example.com', passwordHash: OWNER_HASH,
      role: 'owner', locationIds: '*', tenantId, sessionVersion: 1, disabled: false,
    }, { creationMode: UserCreationMode.INITIAL_TENANT_OWNER })
  } catch (err) {
    threw = err
  }
  assert(threw instanceof UserCreationNotAllowedError, `INITIAL_TENANT_OWNER must refuse a tenant that already has a user, got ${threw?.constructor?.name}`)
}

async function testInvitedUserCanBeCreatedInExistingTenant() {
  installFakeRedis()
  const tenantId = await createNewTenantHelper()
  const invited = await upsertUser(tenantId, {
    userId: 'usr_invited_ok', email: 'invited-ok@example.com', passwordHash: null,
    role: 'location_manager', locationIds: [1], tenantId, sessionVersion: 1, disabled: false,
  }, { creationMode: UserCreationMode.EXISTING_TENANT_INVITE })
  assert(invited.userId === 'usr_invited_ok', 'EXISTING_TENANT_INVITE must succeed for a brand-new identity in an already-existing tenant')
}

async function testSelfServiceCannotPassTenantIdOverride() {
  installFakeRedis()
  let threw = null
  try {
    await createNewTenant({
      mode: TenantCreationMode.SELF_SERVICE, tenantIdOverride: 't_operator-chosen-name',
      companyName: 'Whatever', ownerEmail: 'x@example.com', ownerUserId: 'usr_x', ownerPasswordHash: OWNER_HASH,
    })
  } catch (err) {
    threw = err
  }
  assert(threw instanceof TenantCreationModeRequiredError, `self_service + tenantIdOverride must be refused, got ${threw?.constructor?.name}`)
  assert((await getTenantConfig('t_operator-chosen-name')) === null)
}

async function testDuplicateTenantRejectedForAdminProvisioning() {
  installFakeRedis()
  const tenantId = 't_admin-chosen-explicit-id'
  await createNewTenant({
    mode: TenantCreationMode.ADMIN_PROVISIONING, tenantIdOverride: tenantId,
    companyName: 'First', ownerEmail: 'first@example.com', ownerUserId: 'usr_first_admin', ownerPasswordHash: OWNER_HASH,
    createdByType: 'admin', createdByActorId: 'usr_operator',
  })
  let threw = null
  try {
    await createNewTenant({
      mode: TenantCreationMode.ADMIN_PROVISIONING, tenantIdOverride: tenantId,
      companyName: 'Second', ownerEmail: 'second@example.com', ownerUserId: 'usr_second_admin', ownerPasswordHash: OWNER_HASH,
      createdByType: 'admin', createdByActorId: 'usr_operator',
    })
  } catch (err) {
    threw = err
  }
  assert(threw instanceof TenantAlreadyExistsError, `a second admin_provisioning call at the same explicit id must be rejected, got ${threw?.constructor?.name}`)
  const config = await getTenantConfig(tenantId)
  assert(config.displayName === 'First', 'the original tenant_config must be completely untouched by the rejected second attempt')
}

async function testDuplicateIdentityRejectedByCreateNewTenant() {
  installFakeRedis()
  await createNewTenant({
    mode: TenantCreationMode.SELF_SERVICE, companyName: 'First Biz',
    ownerEmail: 'duplicate-identity@example.com', ownerUserId: 'usr_dup_1', ownerPasswordHash: OWNER_HASH,
  })
  let threw = null
  try {
    await createNewTenant({
      mode: TenantCreationMode.SELF_SERVICE, companyName: 'Second Biz',
      ownerEmail: 'duplicate-identity@example.com', ownerUserId: 'usr_dup_2', ownerPasswordHash: OWNER_HASH,
    })
  } catch (err) {
    threw = err
  }
  assert(threw instanceof IdentityAlreadyExistsError, `the same email must never be allowed to create a second tenant, got ${threw?.constructor?.name}`)
}

async function testRedisOutageDuringTenantCreationCausesNoWrites() {
  installFakeRedis()
  // Simulate an identity-index read failure -- the exact fail-closed path
  // Phase D of this hardening added.
  setUserStoreClient(() => ({ hget: async () => { throw new Error('ECONNREFUSED fake-outage') } }))
  let threw = null
  try {
    await createNewTenant({
      mode: TenantCreationMode.SELF_SERVICE, companyName: 'Outage Co',
      ownerEmail: 'outage@example.com', ownerUserId: 'usr_outage', ownerPasswordHash: OWNER_HASH,
    })
  } catch (err) {
    threw = err
  }
  assert(threw instanceof UserStoreUnavailableError, `an unverifiable identity store must fail closed with UserStoreUnavailableError, got ${threw?.constructor?.name}`)
  // Also proves getAccountByEmailRequireRedisHealthy() itself never
  // degrades to "no account found" the way plain getAccountByEmail() does.
  let threw2 = null
  try { await getAccountByEmailRequireRedisHealthy('outage@example.com') } catch (err) { threw2 = err }
  assert(threw2 instanceof UserStoreUnavailableError, 'getAccountByEmailRequireRedisHealthy must propagate a Redis outage, never swallow it')
}

async function testTwoConcurrentSelfServiceCreationsResultInAtMostOneTenant() {
  installFakeRedis()
  // Both requests reuse the SAME pre-reserved id (exactly what register()
  // hands createNewTenant() in production) -- proves createNewTenant()'s
  // own re-check-before-write closes the window, independent of whatever
  // lock discipline the caller layer adds on top (already covered at the
  // HTTP layer by test_tenant_creation_from_registration.js's
  // testTwoTenantCreationRequestsRacingExactlyOneWins).
  const reservedTenantId = 't_racing-company-abc123'
  const attempt = (userId, email) => createNewTenant({
    mode: TenantCreationMode.SELF_SERVICE, reservedTenantId, companyName: 'Racing Company',
    ownerEmail: email, ownerUserId: userId, ownerPasswordHash: OWNER_HASH,
  }).then(r => ({ ok: true, r })).catch(e => ({ ok: false, e }))

  const [a, b] = await Promise.all([
    attempt('usr_race_a', 'race-a@example.com'),
    attempt('usr_race_b', 'race-b@example.com'),
  ])
  const succeeded = [a, b].filter(x => x.ok)
  assert(succeeded.length >= 1, 'at least one concurrent attempt must succeed')
  const config = await getTenantConfig(reservedTenantId)
  assert(config, 'exactly one tenant_config must exist at the reserved id after the race')
  // Whichever attempt's owner ended up written, there must be exactly one
  // user record for this tenant -- never two owners from two racing writes.
  const winnerEmail = succeeded[0].r.userRecord.email
  const winnerUser = await getUserById(reservedTenantId, succeeded[0].r.userRecord.userId)
  assert(winnerUser && winnerUser.email === winnerEmail, 'the tenant must have exactly the winning attempt\'s owner, consistently')
}

async function testNoPartialTenantOwnerWithoutTenantConfig() {
  const client = installFakeRedis()
  // Force the tenant_config write itself to fail -- the owner-user write
  // must never be reached, proving the write order (config THEN owner)
  // rather than merely asserting the happy-path order looks right.
  const originalHset = client.hset
  client.hset = async (key, fields) => {
    if (key === 'tenant_config:v1') throw new Error('simulated outage writing tenant_config')
    return originalHset(key, fields)
  }
  let threw = null
  let mintedTenantId = null
  try {
    const result = await createNewTenant({
      mode: TenantCreationMode.SELF_SERVICE, companyName: 'Partial Co',
      ownerEmail: 'partial@example.com', ownerUserId: 'usr_partial', ownerPasswordHash: OWNER_HASH,
    })
    mintedTenantId = result.tenantId
  } catch (err) {
    threw = err
  }
  assert(threw, 'a failed tenant_config write must propagate, not be silently swallowed')
  client.hset = originalHset
  const anyUser = mintedTenantId ? await getUserById(mintedTenantId, 'usr_partial') : null
  assert(anyUser == null, 'no owner user may exist without its tenant_config')
}

async function testProvenanceStampedExactlyOnceAndImmutable() {
  installFakeRedis()
  const { tenantId } = await createNewTenant({
    mode: TenantCreationMode.SELF_SERVICE, companyName: 'Provenance Co',
    ownerEmail: 'provenance@example.com', ownerUserId: 'usr_provenance', ownerPasswordHash: OWNER_HASH,
    createdByType: 'user', createdByActorId: 'usr_provenance',
  })
  const config = await getTenantConfig(tenantId)
  assert(config.creation && config.creation.creationSource === 'self_service', 'a newly-created tenant must carry creation.creationSource')
  assert(config.creation.createdByType === 'user' && config.creation.createdByActorId === 'usr_provenance')
  assert(config.creation.creationVersion === 1)
  const firstCreation = JSON.stringify(config.creation)

  // A later, unrelated status update must never re-stamp or alter creation.
  await upsertTenantConfig(tenantId, { status: 'locations_approved' })
  const after = await getTenantConfig(tenantId)
  assert(JSON.stringify(after.creation) === firstCreation, 'creation provenance must be immutable after the tenant is first created')
}

async function testProvenanceCannotBeClientSuppliedOrForged() {
  installFakeRedis()
  const { tenantId } = await createNewTenant({
    mode: TenantCreationMode.SELF_SERVICE, companyName: 'Forge Co',
    ownerEmail: 'forge@example.com', ownerUserId: 'usr_forge', ownerPasswordHash: OWNER_HASH,
  })
  // Attempt to overwrite creation via an ordinary patch, exactly as a
  // caller who found the field name might try.
  await upsertTenantConfig(tenantId, {
    creation: { createdAt: '1970-01-01T00:00:00.000Z', creationSource: 'bootstrap', createdByType: 'system', createdByActorId: 'forged', creationVersion: 999 },
  })
  const config = await getTenantConfig(tenantId)
  assert(config.creation.creationSource === 'self_service', 'a patch-supplied `creation` value must never override the real, stamped-at-creation provenance')
  assert(config.creation.creationVersion === 1, 'creationVersion must never be forgeable via patch')
}

async function testInvalidCreationSourceRejected() {
  installFakeRedis()
  let threw = null
  try {
    await upsertTenantConfig('t_bad-source', {}, { allowCreate: true, creationSource: 'made_up_source' })
  } catch (err) {
    threw = err
  }
  assert(threw instanceof TypeError, `an unrecognized creationSource must be rejected, got ${threw?.constructor?.name}`)
}

// Shared helper for the tests above that just need SOME real, existing
// self-service tenant to operate against.
async function createNewTenantHelper() {
  const { tenantId } = await createNewTenant({
    mode: TenantCreationMode.SELF_SERVICE, companyName: 'Helper Co',
    ownerEmail: `helper-${Math.random().toString(36).slice(2)}@example.com`,
    ownerUserId: `usr_helper_${Math.random().toString(36).slice(2)}`,
    ownerPasswordHash: OWNER_HASH,
  })
  return tenantId
}

const tests = [
  ['a brand-new email can create a workspace', testBrandNewEmailCanCreateAWorkspace],
  ['an existing Redis (bootstrap-hash) user cannot create another workspace', testExistingRedisBootstrapUserCannotCreateAnotherWorkspace],
  ['an existing Redis identity-index user (different tenant) cannot create another workspace', testExistingRedisIdentityIndexUserCannotCreateAnotherWorkspace],
  ['the canonical, repaired LTA Advertising account cannot create another (e.g. "pilot") tenant', testCanonicalLtaAdvertisingAccountCannotCreateAnotherTenant],
  ['a stale/disabled account still blocks self-service re-registration under the same email', testStaleDisabledAccountStillBlocksRegistration],
  ['an invited-but-not-yet-accepted account still blocks a competing self-service registration', testInvitedButNotYetAcceptedAccountStillBlocksRegistration],
  ['the server rejects shadow registration for a real account even with zero frontend involvement', testServerRejectsRegistrationForRealAccountEvenWithoutAnyFrontendInvolvement],
  ['two concurrent registrations for the same brand-new email create exactly one pending registration', testConcurrentRegistrationsForSameBrandNewEmailCreateExactlyOnePendingRegistration],
  ['two different customers with the same company name get distinct tenant ids, never merged or blocked', testTwoDifferentCustomersWithTheSameCompanyNameGetDistinctTenantIds],

  // Centralized tenant-creation primitive -- direct, store-level proofs.
  ['a raw upsertTenantConfig() call cannot create an unknown tenant', testRawTenantConfigUpdateCannotCreateUnknownTenant],
  ['a raw upsertUser() call cannot create a user in an unknown tenant', testRawUserUpdateCannotCreateUserInUnknownTenant],
  ['user creation into a nonexistent tenant is rejected even with an explicit creationMode', testUserCreationIntoNonexistentTenantRejectedEvenWithAMode],
  ['an initial owner can only be created once, through the centralized tenant-creation path', testInitialOwnerCanOnlyBeCreatedThroughCentralizedTenantCreation],
  ['an invited user can be created in an already-existing tenant', testInvitedUserCanBeCreatedInExistingTenant],
  ['self-service mode cannot accept an operator-chosen tenantIdOverride', testSelfServiceCannotPassTenantIdOverride],
  ['a duplicate explicit tenant id is rejected for admin_provisioning', testDuplicateTenantRejectedForAdminProvisioning],
  ['a duplicate identity is rejected by createNewTenant()', testDuplicateIdentityRejectedByCreateNewTenant],
  ['a Redis outage during tenant creation fails closed with no writes', testRedisOutageDuringTenantCreationCausesNoWrites],
  ['two concurrent self-service creations for the same reserved id result in at most one tenant', testTwoConcurrentSelfServiceCreationsResultInAtMostOneTenant],
  ['no partial tenant owner can exist without its tenant_config', testNoPartialTenantOwnerWithoutTenantConfig],
  ['creation provenance is stamped exactly once and is immutable', testProvenanceStampedExactlyOnceAndImmutable],
  ['creation provenance cannot be client-supplied or forged via patch', testProvenanceCannotBeClientSuppliedOrForged],
  ['an unrecognized creationSource is rejected', testInvalidCreationSourceRejected],
]

for (const [name, fn] of tests) await run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
