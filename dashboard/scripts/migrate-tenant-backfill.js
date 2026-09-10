#!/usr/bin/env node
// Multi-Tenant Phase 1 -- dry-run-capable backfill/migration REPORT for
// the existing Los Tres Amigos data. DEFAULT BEHAVIOR IS DRY-RUN/READ-ONLY,
// and Phase 1 does not implement a write mode at all: this script only
// ever calls Redis read commands (hgetall/lrange/get) against the
// existing v1 (or v2, for tasks) keys -- it never calls hset/set/lpush/del
// against any key, in any mode.
//
// A --write flag is accepted on the command line for forward
// compatibility with a later, SEPARATELY REVIEWED migration phase, but
// Phase 1 deliberately does not implement write behavior: passing --write
// makes the script exit non-zero with an explanation, rather than
// silently no-op'ing (which could look like a successful migration to an
// unattended caller) or performing any write.
//
// Run directly (read-only report against real Redis, if configured):
//   node scripts/migrate-tenant-backfill.js
//
// Requires UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in the
// environment to connect to a real Redis for an actual report -- when
// unset, every store is reported as "skipped_not_configured" rather than
// throwing, the same convention scripts/check-prod-env.mjs already uses.

import { Redis } from '@upstash/redis'
import { pathToFileURL } from 'url'
import { DEFAULT_TENANT_ID, isValidTenant, LOS_TRES_AMIGOS_TENANT } from '../api/_lib/tenants.js'
import {
  usersKeyV2, usersEmailIndexKeyV2, contactsKeyV2, actionWorkspaceKeyV2,
  campaignsKeyV2, contentAssetsKeyV2, tasksKeyV3, auditLogKeyV2, credentialKeyV2,
} from '../api/_lib/tenantKeys.js'

const WRITE_FLAG = process.argv.includes('--write')

// Same test-seam pattern as every Redis-backed store in this codebase
// (actionStore.js, contactStore.js, credentialStore.js, ...).
let testClientFactory = null
export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null }

function getClient() {
  if (testClientFactory) return testClientFactory()
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null
  return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
}

// HASH-shaped v1 (or v2, for tasks) stores -- every one of these is read
// with a single hgetall(), never mutated. Verified directly against each
// real store file's own client.hgetall()/hset() calls: userStore.js,
// actionStore.js, contactStore.js, campaignStore.js, contentAssetStore.js,
// taskStore.js all use this exact hash-per-record shape (field = record
// id or email, value = a JSON string).
const HASH_STORES = [
  { v1Key: 'users:v1', buildKey: usersKeyV2 },
  { v1Key: 'users_email_index:v1', buildKey: usersEmailIndexKeyV2 },
  { v1Key: 'restaurant_contacts:v1', buildKey: contactsKeyV2 },
  { v1Key: 'action_workspace:v1', buildKey: actionWorkspaceKeyV2 },
  { v1Key: 'content_campaigns:v1', buildKey: campaignsKeyV2 },
  { v1Key: 'content_assets:v1', buildKey: contentAssetsKeyV2 },
  { v1Key: 'tasks:v2', buildKey: tasksKeyV3 },
]

function tryParse(value) {
  try {
    JSON.parse(typeof value === 'string' ? value : JSON.stringify(value))
    return null
  } catch (err) {
    return err.message
  }
}

async function inventoryHashStore(client, { v1Key, buildKey }, tenantId) {
  const destinationKey = buildKey(tenantId)
  const report = { sourceKey: v1Key, destinationKey, recordCount: 0, validationFailures: [] }
  if (!client) { report.status = 'skipped_not_configured'; return report }
  try {
    const raw = await client.hgetall(v1Key)
    const entries = Object.entries(raw ?? {})
    report.recordCount = entries.length
    for (const [field, value] of entries) {
      const error = tryParse(value)
      if (error) report.validationFailures.push({ field, error })
    }
    report.status = 'read_ok'
  } catch (err) {
    report.status = 'read_error'
    report.error = err.message
  }
  return report
}

// audit_log:v1 is a Redis LIST (client.lpush/client.lrange in
// auditLog.js), not a hash -- read in full with a single lrange().
async function inventoryAuditLog(client, tenantId) {
  const destinationKey = auditLogKeyV2(tenantId)
  const report = { sourceKey: 'audit_log:v1', destinationKey, recordCount: 0, validationFailures: [] }
  if (!client) { report.status = 'skipped_not_configured'; return report }
  try {
    const entries = await client.lrange('audit_log:v1', 0, -1)
    report.recordCount = entries.length
    entries.forEach((entry, index) => {
      const error = tryParse(entry)
      if (error) report.validationFailures.push({ index, error })
    })
    report.status = 'read_ok'
  } catch (err) {
    report.status = 'read_error'
    report.error = err.message
  }
  return report
}

// gbp_credentials:v1 is a single JSON-string value (client.get/client.set
// in credentialStore.js) -- exactly one "record" if it exists at all.
// This phase's dry run only reports whether it EXISTS and parses; it does
// not decrypt it, does not read CREDENTIAL_ENCRYPTION_KEY, and never
// prints its contents.
async function inventoryCredential(client, tenantId) {
  const destinationKey = credentialKeyV2(tenantId)
  const report = { sourceKey: 'gbp_credentials:v1', destinationKey, recordCount: 0, validationFailures: [] }
  if (!client) { report.status = 'skipped_not_configured'; return report }
  try {
    const raw = await client.get('gbp_credentials:v1')
    report.recordCount = raw ? 1 : 0
    if (raw) {
      const error = tryParse(raw)
      if (error) report.validationFailures.push({ field: 'gbp_credentials:v1', error })
    }
    report.status = 'read_ok'
  } catch (err) {
    report.status = 'read_error'
    report.error = err.message
  }
  return report
}

// The full dry-run report. Read-only: calls only hgetall/lrange/get on
// the provided client, never hset/set/lpush/del/expire/hdel. Exported so
// tests can drive it directly against a fake client without going through
// the CLI/process.exit path below.
export async function runDryRun(tenantId = DEFAULT_TENANT_ID) {
  if (!isValidTenant(LOS_TRES_AMIGOS_TENANT)) {
    throw new Error('runDryRun: LOS_TRES_AMIGOS_TENANT fails its own validator -- refusing to proceed')
  }
  const client = getClient()
  const reports = []
  for (const store of HASH_STORES) {
    reports.push(await inventoryHashStore(client, store, tenantId))
  }
  reports.push(await inventoryAuditLog(client, tenantId))
  reports.push(await inventoryCredential(client, tenantId))
  return { tenantId, mode: 'dry-run', reports }
}

function printReport(result) {
  console.log(`migrate-tenant-backfill: DRY RUN for tenant ${result.tenantId}\n`)
  for (const r of result.reports) {
    console.log(`  ${r.sourceKey}  ->  ${r.destinationKey}`)
    console.log(`    status: ${r.status}${r.error ? ` (${r.error})` : ''}`)
    console.log(`    records that would receive tenantId: ${r.recordCount}`)
    if (r.validationFailures.length > 0) {
      console.log(`    VALIDATION FAILURES: ${r.validationFailures.length}`)
      for (const failure of r.validationFailures) console.log(`      - ${JSON.stringify(failure)}`)
    }
    console.log()
  }
  console.log('No Redis key was written, renamed, or deleted. This was a read-only report.')
}

async function main() {
  if (WRITE_FLAG) {
    console.error('migrate-tenant-backfill: --write was supplied, but Phase 1 does not implement write mode.')
    console.error('This script is read-only by design until a migration plan/script is separately reviewed and approved.')
    process.exit(1)
  }

  const result = await runDryRun(DEFAULT_TENANT_ID)
  printReport(result)
}

// Only auto-run when executed directly (`node scripts/migrate-tenant-backfill.js`),
// not when its exports are imported by a test. Compared as URLs (via
// pathToFileURL), not raw strings -- a naive `file://${process.argv[1]}`
// string comparison silently never matches on Windows, where
// process.argv[1] uses backslashes/unencoded spaces and import.meta.url
// uses forward slashes/percent-encoding/a file:/// prefix.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err); process.exit(1) })
}
