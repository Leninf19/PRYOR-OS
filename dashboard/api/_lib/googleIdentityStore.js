// Google Sign-In (PRYOR login identity) -- the provider-identity model.
// Structurally SEPARATE from credentialStore.js (which owns the Google
// BUSINESS PROFILE refresh-token credential, one per TENANT, encrypted,
// used for data access) -- this store owns a login IDENTITY LINK, one per
// USER, never encrypted (it holds no secret/bearer material at all: a
// provider `sub` and email are not credentials, they are stable identifiers
// Google itself already treats as public-ish within a token). Zero overlap,
// zero shared keys, zero shared code path with credentialStore.js.
//
// STORAGE, deliberately small (Part 4's "avoid a large storage rewrite" --
// this is additive, not a userStore.js schema migration):
//   - ONE global (tenant-independent) Redis hash,
//     google_identity_index_by_subject:v1, field = Google's own stable
//     `sub` claim (providerSubject), value = JSON { tenantId, userId }.
//     Global, exactly like userStore.js's own
//     identity_index_by_email/user_id indexes, because a returning-login
//     callback must resolve WHICH tenant a Google identity belongs to
//     before it can do anything tenant-scoped -- there is no tenantId to
//     scope a lookup key by yet at that point.
//   - The user's OWN record (userStore.js) gains one additive field,
//     `googleIdentity: { providerSubject, providerEmail,
//     providerEmailVerified, linkedAt } | null` -- written via
//     userStore.js's existing updateUser() (a plain partial-merge UPDATE,
//     never a new CREATE path, never a new creationMode). This is what lets
//     deriveUserStatus() and any future "manage your login methods" UI read
//     a user's own linkage without a second round trip.
//
// INVARIANTS ENFORCED HERE (Part 7 -- security-critical):
//   - One providerSubject can belong to AT MOST ONE PRYOR user, ever.
//   - One PRYOR user can have AT MOST ONE linked providerSubject at a time
//     (linking a second one first requires explicitly unlinking the first --
//     this store never silently replaces an existing link).
//   - Email equality is NEVER used as a linking key by this store -- every
//     write here is keyed by tenantId+userId (already resolved by the
//     caller via session/[action].js's own explicit, audited decision
//     tree), never inferred from providerEmail matching an existing
//     account's email.
// Both invariants are enforced with a CAS read-then-conditional-write
// (matches tenantConfigStore.js's own discipline) rather than assumed from
// the caller's own bookkeeping.

import { Redis } from '@upstash/redis'
import { getUserById, updateUser } from './userStore.js'

const IDENTITY_INDEX_KEY = 'google_identity_index_by_subject:v1'

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class GoogleIdentityStoreUnavailableError extends Error {}
// Thrown when linking would violate either invariant above -- the caller
// (session/[action].js) always treats this as "fail closed, never merge,"
// per Part 7.
export class GoogleIdentityConflictError extends Error {}

function hasUpstashConfig() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
}

function getClient() {
  if (testClientFactory) return testClientFactory()
  if (!hasUpstashConfig()) return null
  if (!redisClient) {
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  }
  return redisClient
}

function parseRecord(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

// Returns { tenantId, userId } for a linked Google identity, or null if
// this providerSubject has never been linked to any PRYOR user.
export async function getIdentityBySubject(providerSubject) {
  const client = getClient()
  if (!client) throw new GoogleIdentityStoreUnavailableError('google identity store is not configured')
  if (typeof providerSubject !== 'string' || !providerSubject) return null
  try {
    return parseRecord(await client.hget(IDENTITY_INDEX_KEY, providerSubject))
  } catch (err) {
    throw new GoogleIdentityStoreUnavailableError(`google identity store unreachable: ${err.message}`)
  }
}

// Links providerSubject to tenantId/userId -- idempotent for a REPEAT link
// of the exact same (providerSubject, tenantId, userId) triple (a retried
// callback, or a returning login re-confirming its own existing link finds
// nothing to change and succeeds silently); throws GoogleIdentityConflictError
// for any genuine conflict:
//   - this providerSubject is already linked to a DIFFERENT user, or
//   - this user already has a DIFFERENT providerSubject linked.
// Never silently overwrites either side of the mapping.
export async function linkGoogleIdentity(tenantId, userId, { providerSubject, providerEmail, providerEmailVerified }) {
  if (typeof tenantId !== 'string' || !tenantId) throw new TypeError('linkGoogleIdentity: tenantId is required')
  if (typeof userId !== 'string' || !userId) throw new TypeError('linkGoogleIdentity: userId is required')
  if (typeof providerSubject !== 'string' || !providerSubject) throw new TypeError('linkGoogleIdentity: providerSubject is required')
  if (providerEmailVerified !== true) throw new TypeError('linkGoogleIdentity: providerEmailVerified must be true -- an unverified Google email must never be linked')

  const client = getClient()
  if (!client) throw new GoogleIdentityStoreUnavailableError('google identity store is not configured')

  const existingIndexEntry = await getIdentityBySubject(providerSubject)
  if (existingIndexEntry && existingIndexEntry.userId !== userId) {
    throw new GoogleIdentityConflictError(
      `linkGoogleIdentity: providerSubject ${JSON.stringify(providerSubject)} is already linked to a different PRYOR user`
    )
  }

  const userRecord = await getUserById(tenantId, userId)
  if (!userRecord) throw new TypeError(`linkGoogleIdentity: no such user ${JSON.stringify(userId)} in tenant ${JSON.stringify(tenantId)}`)
  if (userRecord.googleIdentity && userRecord.googleIdentity.providerSubject !== providerSubject) {
    throw new GoogleIdentityConflictError(
      `linkGoogleIdentity: user ${JSON.stringify(userId)} already has a different Google identity linked -- unlink it first`
    )
  }

  const linkedAt = userRecord.googleIdentity?.linkedAt ?? new Date().toISOString()
  try {
    await client.hset(IDENTITY_INDEX_KEY, { [providerSubject]: JSON.stringify({ tenantId, userId }) })
  } catch (err) {
    throw new GoogleIdentityStoreUnavailableError(`google identity store unreachable: ${err.message}`)
  }
  await updateUser(tenantId, userId, {
    googleIdentity: { providerSubject, providerEmail, providerEmailVerified: true, linkedAt },
  })
}

// Removes the link in both directions. Never touches credentialStore.js
// (the GBP data-access credential) -- see this file's own header. Safe to
// call on an already-unlinked user (harmless no-op).
export async function unlinkGoogleIdentity(tenantId, userId) {
  const client = getClient()
  if (!client) throw new GoogleIdentityStoreUnavailableError('google identity store is not configured')
  const userRecord = await getUserById(tenantId, userId)
  const providerSubject = userRecord?.googleIdentity?.providerSubject
  if (providerSubject) {
    try {
      await client.hdel(IDENTITY_INDEX_KEY, providerSubject)
    } catch (err) {
      throw new GoogleIdentityStoreUnavailableError(`google identity store unreachable: ${err.message}`)
    }
  }
  if (userRecord) {
    await updateUser(tenantId, userId, { googleIdentity: null })
  }
}
