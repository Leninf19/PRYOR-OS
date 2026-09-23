#!/usr/bin/env node
// Read-only diagnostic: finds the real tenant created for
// lenin@futuremark.studio (now that account creation succeeded) and
// reports its provisioning-dispatch state, including the exact
// provisioning.lastError string -- the Onboarding.jsx UI deliberately
// never shows this to the Owner (see that file's own comment), but it is
// exactly what's needed to diagnose a 'provisioning_dispatch_failed'
// status precisely instead of guessing.
//
// Makes NO writes: no retry-provisioning dispatch, no tenant_config
// mutation. Reuses only existing exported store functions.

import { getAccountByEmail } from './api/_lib/accountStore.js'
import { getTenantConfig } from './api/_lib/tenantConfigStore.js'

const TARGET_EMAIL = 'lenin@futuremark.studio'

async function main() {
  console.log(`=== Account lookup for ${TARGET_EMAIL} ===`)
  const account = await getAccountByEmail(TARGET_EMAIL)
  if (!account) {
    console.log('No account found.')
    return
  }
  console.log(JSON.stringify({ role: account.role, disabled: account.disabled, tenantId: account.tenantId }, null, 2))

  if (!account.tenantId) {
    console.log('Account has no tenantId -- cannot look up tenant_config.')
    return
  }

  console.log(`\n=== tenant_config for ${account.tenantId} ===`)
  const config = await getTenantConfig(account.tenantId)
  if (!config) {
    console.log('No tenant_config record found for this tenantId.')
    return
  }

  const approved = config.approvedLocations || []
  const provisioning = config.provisioning || {}
  console.log(JSON.stringify({
    status: config.status,
    storageMode: config.storageMode,
    locationCount: approved.length,
    locationNames: approved.map(l => l.title),
    createdAt: config.createdAt,
    provisioning: {
      status: provisioning.status,
      dispatchAttemptId: provisioning.dispatchAttemptId ?? null,
      dispatchedAt: provisioning.dispatchedAt ?? null,
      lastAttemptAt: provisioning.lastAttemptAt ?? null,
      lastError: provisioning.lastError ?? null,
    },
  }, null, 2))
}

main().catch(err => { console.error(err.stack || err.message); process.exitCode = 1 })
