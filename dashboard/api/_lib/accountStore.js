// The seam between authorization code and however accounts are actually
// stored -- Milestone 1 of the Phase 2 authorization plan. Every caller
// that needs "the account behind this id/email" goes through here, never
// through accounts.js's own loadAccountDirectory() directly. This is what
// let the Multi-Location Authentication & User Access System milestone
// replace only this file's internals -- an env-var-only parse became a
// dual-read against a durable store -- leaving every permission helper,
// every endpoint, and the whole role/location model unmodified.
//
// DUAL-READ (Commit 1 of that milestone): checks the Redis-backed
// userStore.js FIRST, falling back to the static ACCOUNT_DIRECTORY_JSON
// path only when Redis has no matching record. This is a deliberate,
// deterministic precedence rule, not a merge: once an account exists in
// Redis, it is authoritative for that identity, full stop. It exists so
// every new account (invited or self-service-reset) lives in Redis while
// the original hand-provisioned Owner accounts keep working from the
// static directory with zero migration required -- see README "Multi-
// Location Authentication" for the full migration story.
//
// FAILURE MODEL, load-bearing: userStore.js throws UserStoreUnavailableError
// on a missing/unreachable Redis. This file is the ONE place that catches
// that and degrades to static-directory-only, because ONLY the auth path
// carries the explicit requirement that a Redis outage must never take
// down the existing Owner accounts. Every other Redis-backed caller in this
// codebase (contactStore.js, auditLog.js, and this same userStore.js for
// non-auth callers like the Users & Access admin listing) lets the error
// propagate -- this is the one deliberate exception, and it only ever
// WIDENS availability (an account that exists only in the static directory
// still resolves), it never grants access to an account that doesn't
// legitimately exist.
//
// Edge AND Node runtime compatible -- the same constraint accounts.js
// itself has always had, since dashboard/middleware.js (Edge) calls this
// too. userStore.js's @upstash/redis client is a plain fetch-based REST
// client with no Node-only APIs, so it (unlike bcryptjs/fs) is safe here.

import { loadAccountDirectory, findAccountById, findAccountByEmail, normalizeEmail } from './accounts.js'
import { getUserById, getUserByEmail, listUsers, UserStoreUnavailableError } from './userStore.js'

// A missing/invalid ACCOUNT_DIRECTORY_JSON is a whole-app misconfiguration
// (every static-directory account lookup fails, not just this one), so it's
// worth a single consistent log line regardless of which lookup triggered
// it -- this replaces the two slightly different '[auth]'/'[login]'-prefixed
// messages that used to live at each call site.
function loadDirectoryOrWarn() {
  const accounts = loadAccountDirectory()
  if (!accounts) {
    console.error('[accountStore] ACCOUNT_DIRECTORY_JSON is missing or invalid -- static-directory accounts unavailable.')
    return null
  }
  return accounts
}

// See the failure-model note above: a Redis outage degrades this ONE lookup
// to "not found in Redis" rather than propagating, so the caller falls
// through to the static directory instead of the whole request failing.
async function tryRedisLookup(fn, label) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof UserStoreUnavailableError) {
      console.error(`[accountStore] user store unreachable during ${label} -- falling back to the static directory only: ${err.message}`)
      return null
    }
    throw err
  }
}

export async function getAccountById(userId) {
  const redisUser = await tryRedisLookup(() => getUserById(userId), `getAccountById(${userId})`)
  if (redisUser) return redisUser
  const accounts = loadDirectoryOrWarn()
  if (!accounts) return null
  return findAccountById(accounts, userId)
}

export async function getAccountByEmail(email) {
  const redisUser = await tryRedisLookup(() => getUserByEmail(email), `getAccountByEmail`)
  if (redisUser) return redisUser
  const accounts = loadDirectoryOrWarn()
  if (!accounts) return null
  return findAccountByEmail(accounts, email)
}

// Merged, de-duplicated listing: every Redis user, plus every static-
// directory account whose normalized email is NOT already present in
// Redis (Redis wins on precedence, same rule as the single-record lookups
// above) -- so a legacy static account that has since been "promoted" into
// Redis (e.g. re-provisioned through the same invite flow) is never listed
// twice. Used by both auth-adjacent callers (GET /api/session/accounts) and
// the Users & Access admin listing/last-Owner counting -- both need the
// same de-duplicated view.
export async function listAccounts() {
  const redisUsers = await tryRedisLookup(() => listUsers(), 'listAccounts') ?? []
  const redisEmails = new Set(redisUsers.map(u => normalizeEmail(u.email)))

  const staticAccounts = loadDirectoryOrWarn() ?? []
  const staticOnly = staticAccounts.filter(a => !redisEmails.has(normalizeEmail(a.email)))

  return [...redisUsers, ...staticOnly]
}
