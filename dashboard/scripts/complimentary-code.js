#!/usr/bin/env node
// Complimentary Restaurant Access Codes -- the ONLY way to create/list/
// revoke a complimentary code. Deliberately a LOCAL/OPERATOR-ONLY CLI, never
// a browser-reachable endpoint: there is no public or authenticated-user API
// route anywhere in this codebase that can mint a complimentary code --
// session/[action].js only ever REDEEMS one (redeemComplimentaryCodeAction()),
// via complimentaryAccessStore.js's own atomic, server-only functions.
//
// Requires UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in the
// environment to reach a real Redis (e.g. `vercel env pull` locally, or
// exported by hand for a one-off run) -- same convention as every other
// operator script in this directory (migrate-tenant-backfill.js).
//
// Usage:
//   node scripts/complimentary-code.js create \
//     --label "Agave D'Oro Pilot" --plan growth --days 30 \
//     --locations 1 --users 3 [--max-redemptions 1] [--deadline 2026-12-31]
//
//   node scripts/complimentary-code.js list
//
//   node scripts/complimentary-code.js revoke --hash <codeHash> [--reason "..."]
//
// `create` prints the plaintext code EXACTLY ONCE -- it is never persisted
// anywhere and cannot be recovered afterward; write it down immediately.
// Every other command prints only non-sensitive metadata (never a
// datastore credential, never a plaintext code, since none is ever stored).

import { pathToFileURL } from 'url'
import {
  createComplimentaryCode, listComplimentaryCodes, revokeComplimentaryCode, getComplimentaryCodeByHash,
} from '../api/_lib/complimentaryAccessStore.js'

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next
        i++
      } else {
        flags[name] = true
      }
    } else {
      positional.push(arg)
    }
  }
  return { command: positional[0], flags }
}

function requireIntFlag(flags, name) {
  const raw = flags[name]
  if (raw === undefined) throw new Error(`--${name} is required`)
  const n = Number(raw)
  if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer, got ${JSON.stringify(raw)}`)
  return n
}

async function runCreate(flags) {
  const label = typeof flags.label === 'string' ? flags.label : null
  const planId = flags.plan
  if (typeof planId !== 'string' || !planId) throw new Error('--plan is required (core|growth|enterprise)')
  const durationDays = requireIntFlag(flags, 'days')
  const maxLocations = requireIntFlag(flags, 'locations')
  const maxUsers = requireIntFlag(flags, 'users')
  const maxRedemptions = flags['max-redemptions'] !== undefined ? Number(flags['max-redemptions']) : 1
  const redemptionDeadline = typeof flags.deadline === 'string' ? new Date(flags.deadline).toISOString() : null
  const createdBy = typeof flags['created-by'] === 'string' ? flags['created-by'] : 'operator_cli'

  const { rawCode, record } = await createComplimentaryCode({
    label, planId, durationDays, maxLocations, maxUsers, maxRedemptions, redemptionDeadline, createdBy,
  })

  console.log('Complimentary access code created.\n')
  console.log(`  CODE (shown once, write it down now): ${rawCode}\n`)
  console.log(`  label:             ${record.label ?? '(none)'}`)
  console.log(`  plan:              ${record.planId}`)
  console.log(`  durationDays:      ${record.durationDays}`)
  console.log(`  maxLocations:      ${record.maxLocations}`)
  console.log(`  maxUsers:          ${record.maxUsers}`)
  console.log(`  maxRedemptions:    ${record.maxRedemptions}`)
  console.log(`  redemptionDeadline: ${record.redemptionDeadline ?? '(none)'}`)
  console.log(`  codeHash:          ${record.codeHash}`)
  console.log(`  createdAt:         ${record.createdAt}`)
  console.log('\nThis code was NOT applied to any Production tenant. Give it privately to the intended restaurant owner.')
}

async function runList() {
  const codes = await listComplimentaryCodes()
  if (codes.length === 0) {
    console.log('No complimentary access codes exist yet.')
    return
  }
  for (const c of codes) {
    console.log(`${c.codeHash}`)
    console.log(`  label:          ${c.label ?? '(none)'}`)
    console.log(`  plan:           ${c.planId}`)
    console.log(`  status:         ${c.status}`)
    console.log(`  durationDays:   ${c.durationDays}  maxLocations: ${c.maxLocations}  maxUsers: ${c.maxUsers}`)
    console.log(`  redemptions:    ${c.redemptionCount}/${c.maxRedemptions}`)
    console.log(`  redemptionDeadline: ${c.redemptionDeadline ?? '(none)'}`)
    console.log(`  createdAt:      ${c.createdAt}  createdBy: ${c.createdBy}`)
    if (c.revokedAt) console.log(`  revokedAt:      ${c.revokedAt}  reason: ${c.revokeReason ?? '(none)'}`)
    if (c.tenantId) console.log(`  redeemedByTenant: ${c.tenantId}  redeemedAt: ${c.redeemedAt}`)
    console.log()
  }
}

async function runRevoke(flags) {
  const hash = flags.hash
  if (typeof hash !== 'string' || !hash) throw new Error('--hash is required (see `list` for each code\'s codeHash)')
  const existing = await getComplimentaryCodeByHash(hash)
  if (!existing) {
    console.error(`No complimentary access code found for hash ${hash}`)
    process.exitCode = 1
    return
  }
  const reason = typeof flags.reason === 'string' ? flags.reason : null
  const updated = await revokeComplimentaryCode(hash, { reason })
  console.log(`Revoked complimentary access code ${hash} (label: ${updated.label ?? '(none)'}).`)
  if (reason) console.log(`  reason: ${reason}`)
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2))
  if (command === 'create') return runCreate(flags)
  if (command === 'list') return runList()
  if (command === 'revoke') return runRevoke(flags)
  console.error('Usage: node scripts/complimentary-code.js <create|list|revoke> [--flags]')
  process.exitCode = 1
}

// Only auto-run when executed directly, not when imported by a test --
// mirrors migrate-tenant-backfill.js's own Windows-safe URL comparison.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err.message); process.exitCode = 1 })
}
