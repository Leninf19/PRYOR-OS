// The seam between authorization code and however accounts are actually
// stored -- Milestone 1 of the Phase 2 authorization plan. Every caller
// that needs "the account behind this id/email" goes through here, never
// through accounts.js's own loadAccountDirectory() directly. This is what
// lets a future hosted-database migration (Phase 4) replace only this
// file's internals -- an env-var parse becomes a query -- leaving every
// permission helper, every endpoint, and the whole role/location model
// unmodified.
//
// Today: delegates straight to ACCOUNT_DIRECTORY_JSON via accounts.js.
// Returns the full account record (including passwordHash) -- exactly what
// findAccountById()/findAccountByEmail() already returned. Callers that
// need to expose an account externally are responsible for their own
// sanitization, the same way they always have been; this store's only job
// is finding the record, not shaping it.
//
// Edge AND Node runtime compatible -- the same constraint accounts.js
// itself has always had, since dashboard/middleware.js (Edge) calls this
// too. No bcrypt/fs/Redis import here, same as accounts.js.

import { loadAccountDirectory, findAccountById, findAccountByEmail } from './accounts.js'

// A missing/invalid ACCOUNT_DIRECTORY_JSON is a whole-app misconfiguration
// (every account lookup fails, not just this one), so it's worth a single
// consistent log line regardless of which lookup triggered it -- this
// replaces the two slightly different '[auth]'/'[login]'-prefixed messages
// that used to live at each call site.
function loadDirectoryOrWarn() {
  const accounts = loadAccountDirectory()
  if (!accounts) {
    console.error('[accountStore] ACCOUNT_DIRECTORY_JSON is missing or invalid -- rejecting all requests.')
    return null
  }
  return accounts
}

export function getAccountById(userId) {
  const accounts = loadDirectoryOrWarn()
  if (!accounts) return null
  return findAccountById(accounts, userId)
}

export function getAccountByEmail(email) {
  const accounts = loadDirectoryOrWarn()
  if (!accounts) return null
  return findAccountByEmail(accounts, email)
}
