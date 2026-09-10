// Vercel Edge Middleware unsupported Node crypto dependency fix -- this
// file exists ONLY to hold the one Node-only (`crypto`) piece of tenant-id
// logic, split out of tenants.js so that file can go back to being fully
// Edge-runtime-safe (dashboard/middleware.js imports tenants.js directly,
// and transitively again through accountStore.js/userStore.js/
// tenantKeys.js/tenantDualRead.js -- see middleware.js's own header for
// why it needs tenant resolution at all). tenants.js's own header has
// always been explicit that it must stay import-light enough to run at
// the Edge; Phase 4Q's self-service tenant-id generator broke that
// property by adding `import { randomInt } from 'crypto'` directly into
// tenants.js. Node's `crypto` module cannot be bundled into an Edge
// Function at all -- Vercel's build step fails packaging with
// "referencing unsupported modules" the moment ANY file crypto imports
// from ends up in that bundle's dependency graph, regardless of whether
// the Edge code path actually calls the function that uses it.
//
// generateTenantId() is exclusively a SERVER-SIDE, Node-only concern --
// it is called from exactly one place, session/[action].js's self-service
// registration flow (createTenantForVerifiedRegistration()'s caller),
// which runs as an ordinary Vercel (Node/Fluid Compute) serverless
// function, never at the Edge. Moving it here changes NOTHING about its
// behavior, security properties, or call sites' semantics -- it is the
// exact same function, byte-for-byte, just no longer physically inside a
// file the Edge bundle must include.

import { randomInt } from 'crypto'
import { isValidTenantId, DEFAULT_TENANT_ID } from './tenants.js'
import { getTenantConfig } from './tenantConfigStore.js'

// Phase 4Q -- the self-service-onboarding tenant id generator
// tenants.js's own Phase 1 header comment anticipated ("every tenant
// created later via self-service onboarding gets a generated ID"). Never
// called with client input: the caller (the registration/tenant-creation
// transaction) supplies the company name a REGISTERED, EMAIL-VERIFIED user
// typed, purely for a human-recognizable prefix -- the actual uniqueness
// guarantee is the random suffix plus the collision check below, not the
// slug. Collides astronomically rarely (a 6-character base36 suffix is
// ~31 bits of entropy); the bounded retry loop exists only as defense in
// depth, never expected to iterate more than once in practice.
function slugifyForTenantId(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'tenant'
}

function randomTenantSuffix() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 6; i++) out += alphabet[randomInt(alphabet.length)]
  return out
}

export async function generateTenantId(companyName) {
  const base = `t_${slugifyForTenantId(companyName)}`
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = `${base}-${randomTenantSuffix()}`
    if (!isValidTenantId(candidate)) continue // defensive; slugify already guarantees this
    if (candidate === DEFAULT_TENANT_ID) continue // structurally impossible, checked anyway
    const existing = await getTenantConfig(candidate)
    if (existing === null) return candidate
  }
  throw new Error('generateTenantId: could not find an unused tenant id after 10 attempts')
}
