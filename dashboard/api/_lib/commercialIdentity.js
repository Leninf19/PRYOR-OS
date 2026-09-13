// Phase B.6 -- 7-day Growth trial anti-abuse. commercialIdentityKey(email)
// is a SECONDARY commercial risk/fraud signal, recorded alongside a GBP
// trial claim for future manual fraud review -- NEVER a replacement for, or
// input to, authentication/session identity. This file is intentionally
// separate from accounts.js's normalizeEmail() (login/session identity) and
// does not import it or modify it -- the two normalizations serve
// completely different purposes and must never be conflated:
//   - normalizeEmail() (accounts.js): "is this the same login identity" --
//     used for auth, session, and account-directory lookups. UNTOUCHED here.
//   - commercialIdentityKey() (this file): "does this look like the same
//     person for commercial-abuse-signal purposes" -- used ONLY to record a
//     secondary, non-blocking data point alongside a trial claim. Per
//     Phase B.6's explicit scope, a commercialIdentityKey COLLISION ALONE
//     must never deny or gate a trial by itself -- the GBP location
//     identity (trialEligibilityStore.js) remains the sole, primary,
//     authoritative eligibility signal. See that file's own header.
//
// Normalization applied (deliberately conservative -- see the note below on
// what is NOT applied):
//   1. Trim + lowercase the whole address.
//   2. Strip a "+tag" local-part suffix (RFC 5233 sub-addressing:
//      local+tag@domain -> local@domain) -- a widely and safely assumed
//      convention honored by Gmail, Outlook/Microsoft 365, Yahoo, iCloud,
//      and most modern mail providers. Stripping it here only affects this
//      SECONDARY signal, never login/session identity.
//
// Deliberately NOT applied: Gmail's dot-insensitivity in the local part
// (john.doe@gmail.com == johndoe@gmail.com). That is a Gmail-specific
// mailbox-routing quirk, not a universal email standard -- applying it
// generically to every domain (this function has no reliable way to know
// which domains are actually Gmail-backed, e.g. Google Workspace on a
// custom domain vs. a dot-sensitive provider on an unrelated domain) risks
// silently merging two genuinely distinct mailboxes. Since this key is
// explicitly a non-blocking, human-reviewed signal in B.6 (never an
// automatic denial), the cost of under-normalizing here is low, while the
// cost of a false-positive merge would not be -- so this function stays on
// the safe, provable side.
export function commercialIdentityKey(email) {
  if (typeof email !== 'string') return null
  const trimmed = email.trim().toLowerCase()
  if (!trimmed) return null
  const at = trimmed.indexOf('@')
  if (at === -1) return trimmed
  let local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)
  const plusIdx = local.indexOf('+')
  if (plusIdx !== -1) local = local.slice(0, plusIdx)
  if (!local) return null
  return `${local}@${domain}`
}
