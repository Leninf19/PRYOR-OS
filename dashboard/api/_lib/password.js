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
