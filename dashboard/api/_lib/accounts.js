// Account directory parsing/validation -- Edge AND Node runtime compatible.
// Deliberately has no bcrypt/fs/Redis import so it can be shared by
// dashboard/middleware.js (Edge) and every Node API handler alike.
//
// Phase 1 stores the account directory as a single Vercel environment
// variable (ACCOUNT_DIRECTORY_JSON) rather than a database -- this is an
// explicit, temporary stopgap (see README) so the write-endpoint security
// hole can close now without building a full user-management system ahead
// of need. Migration path: promote this same shape into a `users` table
// once the hosted-database phase (Phase 4) lands -- userId/email/
// passwordHash/role/locationIds/sessionVersion/disabled map directly to
// columns, no redesign needed.
//
// Password hashes live in this same JSON but are only ever compared in
// _lib/password.js (Node-only, bcryptjs) -- nothing in this file touches
// passwordHash except to validate its shape and pass it through unread.
//
// Validation here is deliberately strict and fails the WHOLE directory
// (returns null, meaning "no one is authenticated") rather than tolerating
// a partially-valid record -- a malformed entry is exactly the kind of
// mistake (an extra plaintext `password` field left in next to the real
// hash, a typo'd role, a locationIds array with a stray string in it) that
// should be caught loudly at load time, not silently ignored.

// 'admin' added by the Multi-Location Authentication & User Access System
// milestone -- same grant tier as 'owner' except SETTINGS_ADMIN (GBP OAuth
// connect/disconnect stays Owner-only; see permissions.js). Every existing
// static ACCOUNT_DIRECTORY_JSON entry is unaffected -- this only widens the
// set of values `role` may validly hold.
export const ROLES = ['owner', 'admin', 'marketing', 'location_manager', 'read_only']

// 'canCreateTasks' added by the Operations Calendar + Content Library
// milestone -- optional, defaults to false when absent (see isValidAccount
// below). Only meaningful for role: 'location_manager' (see
// api/_lib/auth.js's canCreateTask()); harmless-but-ignored on every other
// role, same tolerance displayName already has.
const ACCOUNT_FIELDS = new Set([
  'userId', 'email', 'passwordHash', 'role', 'locationIds', 'sessionVersion', 'disabled', 'displayName',
  'canCreateTasks',
])

// Standard bcrypt hash shape: $2a$/$2b$/$2y$, 2-digit cost, 53 base64-ish
// characters of salt+hash. Rejects an accidentally-plaintext password (or
// any other malformed value) sitting in passwordHash instead of a real hash.
const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/

// Exported so userStore.js (the Redis-backed dynamic directory) can
// validate locationIds with the exact same core rule as the static
// directory below, without duplicating it -- '*' (wildcard) or an array of
// distinct positive integers.
//
// `allowEmpty` (Multi-Tenant Phase 4K, default false): the STATIC directory
// (ACCOUNT_DIRECTORY_JSON, hand-authored config) NEVER allows an empty
// array -- a hand-provisioned account with zero locations is virtually
// always a configuration mistake, so isValidAccount() below keeps calling
// this with the default. The DYNAMIC (Redis) store, by contrast, can
// LEGITIMATELY reach zero locations at RUNTIME -- e.g.
// tenantConfigStore.js's applyEntitlementChange() removing the last
// location a location_manager held (see userStore.js's
// reconcileAccountGrantsAfterLocationRemoval()) -- so userStore.js's
// upsertUser() calls this with `{ allowEmpty: true }`. Either way,
// requireLocationAccess() (auth.js) already treats `[]` correctly by
// construction (`[].includes(anyLocationId)` is always false, i.e. "deny
// everything") -- this parameter only ever widens what a given caller's
// SCHEMA accepts as well-formed, it never changes an authorization
// decision. The ADMIN-FACING manual assignment flow (userManagement.js's
// validateRoleAndLocations(), used by POST /api/settings/update-user-role-
// locations) separately keeps its OWN, stricter "must be non-empty" check
// on top of this -- a human assigning a location_manager zero locations by
// hand is almost certainly a mistake and stays rejected there regardless
// of what this function alone would accept.
export function isValidLocationIds(locationIds, { allowEmpty = false } = {}) {
  if (locationIds === '*') return true
  if (!Array.isArray(locationIds)) return false
  if (locationIds.length === 0) return allowEmpty
  const seen = new Set()
  for (const id of locationIds) {
    if (!Number.isInteger(id) || id <= 0) return false
    if (seen.has(id)) return false // duplicate entry -- ambiguous, reject
    seen.add(id)
  }
  return true
}

function isValidAccount(a) {
  if (!a || typeof a !== 'object') return false

  // Reject unknown fields outright -- an extra key (e.g. a leftover
  // plaintext `password` field) must never silently coexist unnoticed.
  for (const key of Object.keys(a)) {
    if (!ACCOUNT_FIELDS.has(key)) return false
  }

  return (
    typeof a.userId === 'string' && a.userId.trim().length > 0 &&
    typeof a.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email.trim()) &&
    typeof a.passwordHash === 'string' && BCRYPT_HASH_RE.test(a.passwordHash) &&
    ROLES.includes(a.role) &&
    isValidLocationIds(a.locationIds) &&
    Number.isInteger(a.sessionVersion) && a.sessionVersion >= 1 &&
    typeof a.disabled === 'boolean' &&
    (a.displayName === undefined || typeof a.displayName === 'string') &&
    (a.canCreateTasks === undefined || typeof a.canCreateTasks === 'boolean')
  )
}

// Parses and validates ACCOUNT_DIRECTORY_JSON. Returns the account array on
// success, or null if the env var is missing, malformed, or contains any
// invalid/duplicate/ambiguous record -- callers MUST treat null as "no one
// is authenticated", never as "let the request through". A broken account
// directory fails the whole auth system closed, not open.
export function loadAccountDirectory() {
  const raw = process.env.ACCOUNT_DIRECTORY_JSON
  if (!raw) return null

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  // Only "accounts" is a recognized top-level key -- an unrecognized extra
  // key is treated as a configuration mistake, not silently ignored.
  if (!Object.keys(parsed).every(k => k === 'accounts')) return null
  if (!Array.isArray(parsed.accounts) || parsed.accounts.length === 0) return null
  if (!parsed.accounts.every(isValidAccount)) return null

  const userIds = new Set()
  const emails = new Set()
  for (const a of parsed.accounts) {
    const emailNormalized = normalizeEmail(a.email)
    if (userIds.has(a.userId) || emails.has(emailNormalized)) return null
    userIds.add(a.userId)
    emails.add(emailNormalized)
  }

  return parsed.accounts
}

export function findAccountById(accounts, userId) {
  return accounts.find(a => a.userId === userId) ?? null
}

// Trim + lowercase on both sides so "  Owner@Example.com " and
// "owner@example.com" are treated as the same account -- consistent
// wherever an email is used as a lookup key (login, directory validation).
export function normalizeEmail(email) {
  return (email || '').trim().toLowerCase()
}

export function findAccountByEmail(accounts, email) {
  const target = normalizeEmail(email)
  return accounts.find(a => normalizeEmail(a.email) === target) ?? null
}

// Never include passwordHash (or anything else not needed by the caller) in
// data that might reach the frontend or a log line.
export function toSafeAccount(account) {
  if (!account) return null
  return {
    userId: account.userId,
    email: account.email,
    role: account.role,
    locationIds: account.locationIds,
    displayName: account.displayName ?? account.email,
    canCreateTasks: Boolean(account.canCreateTasks),
  }
}
