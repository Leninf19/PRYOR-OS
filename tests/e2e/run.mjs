// Phase 4L pilot-readiness local harness -- entry point.
//
// Seeds a full roster of synthetic, unmistakably non-production tenant
// fixtures (t_pilot-test-a / t_pilot-test-b, plus one of each at every
// lifecycle stage the spec asks for) into the shared fake Redis/Blob store,
// then starts the local HTTP server (server.mjs) so a real browser can be
// pointed at it. Prints every seeded login so a human or Playwright session
// can drive the actual UI.
//
// No real Upstash, no real Vercel Blob, no real Google, no production data.
// Run: node tests/e2e/run.mjs

process.env.SESSION_SIGNING_SECRET ??= 'pilot-harness-session-secret-not-a-real-secret-32ch'
process.env.CREDENTIAL_ENCRYPTION_KEY ??= 'pilot-harness-credential-key-not-a-real-secret'
process.env.GOOGLE_CLIENT_ID ??= 'pilot-harness-fake-client-id'
process.env.GOOGLE_CLIENT_SECRET ??= 'pilot-harness-fake-client-secret'
// Deliberately UNSET: UPSTASH_REDIS_REST_URL/TOKEN, BLOB_READ_WRITE_TOKEN,
// ACCOUNT_DIRECTORY_JSON -- every store's hasUpstashConfig()/getClient()
// would otherwise try to build a REAL client even though
// _setRedisClientForTests()/_setBlobClientForTests() already override
// getClient()'s return value; leaving these unset is simply the correct,
// honest "no production credentials configured" state for a local harness,
// and confirms nothing in this process could reach a real backend even by
// accident.

import {
  seedOnboardingTenant, seedLocationsApprovedTenant, seedProvisioningFailedTenant,
  seedProvisionedTenant, seedInitialSyncInProgressTenant, seedInitialSyncFailedTenant,
  seedActiveTenant, seedSuspendedTenant,
} from './seedFixtures.mjs'
import { registerGoogleFixture } from './fakeInfra.mjs'
import { signOAuthState } from '../../dashboard/api/google/_lib/oauthState.js'

const TENANT_A = 't_pilot-test-a'
const TENANT_B = 't_pilot-test-b'

async function main() {
  const roster = {}

  // Tenant A -- the primary "active, healthy" pilot tenant, used for every
  // A/B isolation check against Tenant B below.
  roster.tenantA_active = await seedActiveTenant({
    tenantId: TENANT_A, userId: 'usr_pilot_a_owner', email: 'owner@pilot-test-a.example',
    googleLocationIds: ['accounts/1/locations/A1', 'accounts/1/locations/A2'],
  })

  // Tenant B -- walked through every OTHER lifecycle stage the spec asks
  // for, one synthetic sibling tenant per stage (t_pilot-test-b-<stage>) so
  // every state can be inspected independently in the same running harness
  // without one stage's fixture overwriting another's.
  roster.tenantB_onboarding = await seedOnboardingTenant({
    tenantId: `${TENANT_B}-onboarding`, userId: 'usr_pilot_b1_owner', email: 'owner@pilot-test-b-onboarding.example',
  })
  roster.tenantB_locationsApproved = await seedLocationsApprovedTenant({
    tenantId: `${TENANT_B}-locations-approved`, userId: 'usr_pilot_b2_owner', email: 'owner@pilot-test-b-locations-approved.example',
    googleLocationIds: ['accounts/2/locations/B1'],
  })
  roster.tenantB_provisioningFailed = await seedProvisioningFailedTenant({
    tenantId: `${TENANT_B}-provisioning-failed`, userId: 'usr_pilot_b3_owner', email: 'owner@pilot-test-b-provisioning-failed.example',
    googleLocationIds: ['accounts/3/locations/B1'],
  })
  roster.tenantB_provisioned = await seedProvisionedTenant({
    tenantId: `${TENANT_B}-provisioned`, userId: 'usr_pilot_b4_owner', email: 'owner@pilot-test-b-provisioned.example',
    googleLocationIds: ['accounts/4/locations/B1'],
  })
  roster.tenantB_initialSyncInProgress = await seedInitialSyncInProgressTenant({
    tenantId: `${TENANT_B}-initial-sync`, userId: 'usr_pilot_b5_owner', email: 'owner@pilot-test-b-initial-sync.example',
    googleLocationIds: ['accounts/5/locations/B1'],
  })
  roster.tenantB_initialSyncFailed = await seedInitialSyncFailedTenant({
    tenantId: `${TENANT_B}-initial-sync-failed`, userId: 'usr_pilot_b6_owner', email: 'owner@pilot-test-b-initial-sync-failed.example',
    googleLocationIds: ['accounts/6/locations/B1'],
  })
  roster.tenantB_active = await seedActiveTenant({
    tenantId: `${TENANT_B}-active`, userId: 'usr_pilot_b7_owner', email: 'owner@pilot-test-b-active.example',
    googleLocationIds: ['accounts/7/locations/B1', 'accounts/7/locations/B2'], titlePrefix: 'Pilot B Location',
  })
  roster.tenantB_suspended = await seedSuspendedTenant({
    tenantId: `${TENANT_B}-suspended`, userId: 'usr_pilot_b8_owner', email: 'owner@pilot-test-b-suspended.example',
    googleLocationIds: ['accounts/8/locations/B1'],
  })

  // Pre-registered Google fixtures + ready-to-use state tokens for flows a
  // real browser cannot complete on its own (Google's real OAuth consent
  // screen is unreachable without real credentials) -- these let a separate
  // script issue the exact HTTP GET a real Google redirect would produce,
  // against THIS running harness, so callback()'s real discovery/
  // reconciliation logic still executes end to end. See
  // tests/e2e/completeGoogleConnect.mjs.
  const onboardingTarget = roster.tenantB_onboarding
  registerGoogleFixture({
    authCode: 'fake-code-onboarding-b', refreshToken: `fake-refresh-${onboardingTarget.tenantId}-initial`,
    accounts: { [`accounts/${onboardingTarget.tenantId}`]: [
      { name: `accounts/${onboardingTarget.tenantId}/locations/1`, title: 'Pilot B Downtown' },
      { name: `accounts/${onboardingTarget.tenantId}/locations/2`, title: 'Pilot B Uptown' },
    ] },
  })
  console.log(`[fixture] connect-Google flow ready for ${onboardingTarget.tenantId}: authCode=fake-code-onboarding-b`)
  console.log(`[fixture]   state token: ${await signOAuthState({ nonce: 'pilot-fixture-nonce-onboarding', tenantId: onboardingTarget.tenantId, userId: 'usr_pilot_b1_owner' }, { expiresInSeconds: 3600 })}\n`)

  // Account-key namespace MUST match Tenant A's ORIGINAL approvedLocations
  // prefix ("accounts/1/locations/A1", "accounts/1/locations/A2" -- see
  // seedActiveTenant's caller below) -- google/[action].js's callback()
  // reconstructs each discovered location's canonical googleLocationId as
  // `${accountResourceName}/locations/${tail}` (v4LocationPath) and compares
  // THAT against what's already approved, so a reconnect fixture keyed
  // under any other account name would look "incompatible" even when it is
  // meant to be the SAME Google account reconnecting.
  registerGoogleFixture({
    authCode: 'fake-code-reconnect-a-compatible', refreshToken: `fake-refresh-${TENANT_A}-reconnect-ok`,
    accounts: { 'accounts/1': [
      { name: 'locations/A1', title: 'Pilot Location 1' },
      { name: 'locations/A2', title: 'Pilot Location 2' },
      { name: 'locations/A3', title: 'Pilot Location 3 (new, not yet approved)' },
    ] },
  })
  console.log(`[fixture] COMPATIBLE reconnect ready for ${TENANT_A}: authCode=fake-code-reconnect-a-compatible (sees both approved locations plus one extra)`)
  console.log(`[fixture]   state token: ${await signOAuthState({ nonce: 'pilot-fixture-nonce-reconnect-ok', tenantId: TENANT_A, userId: 'usr_pilot_a_owner' }, { expiresInSeconds: 3600 })}\n`)

  registerGoogleFixture({
    authCode: 'fake-code-reconnect-a-incompatible', refreshToken: `fake-refresh-${TENANT_A}-reconnect-bad`,
    accounts: { 'accounts/1': [
      { name: 'locations/A1', title: 'Pilot Location 1' },
      // A2 deliberately missing -- this credential cannot see an already-approved location.
    ] },
  })
  console.log(`[fixture] INCOMPATIBLE reconnect ready for ${TENANT_A}: authCode=fake-code-reconnect-a-incompatible (missing an approved location)`)
  console.log(`[fixture]   state token: ${await signOAuthState({ nonce: 'pilot-fixture-nonce-reconnect-bad', tenantId: TENANT_A, userId: 'usr_pilot_a_owner' }, { expiresInSeconds: 3600 })}\n`)

  console.log('\n=== Phase 4L pilot-readiness harness: seeded fixtures ===\n')
  for (const [name, { tenantId, token }] of Object.entries(roster)) {
    console.log(`${name.padEnd(28)} tenantId=${tenantId}`)
    console.log(`${''.padEnd(28)} session cookie value (lta_session)=${token}\n`)
  }
  console.log('All owner accounts share the password: pilot-harness-not-a-real-password\n')

  await import('./server.mjs')
}

main().catch(err => { console.error('[pilot-harness] fatal error during seeding:', err); process.exit(1) })
