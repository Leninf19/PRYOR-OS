// Node-only password hashing (bcryptjs -- pure JS, no native compilation,
// which matters for reliable bundling into a Vercel serverless function).
// NEVER import this from dashboard/middleware.js -- bcryptjs is not
// Edge-runtime compatible. Only login.js needs this.

import bcrypt from 'bcryptjs'

const COST_FACTOR = 12

export async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, COST_FACTOR)
}

// bcrypt.compare is already constant-time w.r.t. the hash comparison itself;
// this additionally normalizes "no such account" and "wrong password" into
// the same code path in login.js so timing/response shape can't distinguish
// them (see login.js).
export async function verifyPassword(plainPassword, hash) {
  if (!plainPassword || !hash) return false
  return bcrypt.compare(plainPassword, hash)
}

// A single, reasonable, clearly-displayable rule -- minimum length only, no
// forced character-class complexity (a long passphrase is stronger and
// friendlier than "P@ssw0rd1", and the invite/reset milestone's own
// requirement is explicitly "without creating unnecessarily hostile
// complexity"). Used by accept-invite and reset-password; never by login
// (an existing password's own historical requirements aren't re-validated
// at sign-in time).
export const MIN_PASSWORD_LENGTH = 10

export function validatePasswordStrength(password) {
  if (typeof password !== 'string') return { valid: false, message: 'Password is required.' }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { valid: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }
  }
  return { valid: true, message: null }
}
