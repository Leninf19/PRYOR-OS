#!/usr/bin/env node
// One-off, disposable investigation script -- proves or disproves whether
// this Redis-compatible backend's Lua `cjson` library round-trips JSON
// `null` values correctly through cjson.decode -> cjson.encode, which is
// exactly the operation accessCodeStore.js's REDEEM_SCRIPT performs on a
// whole access-code record during redemption.
//
// Three probes, all isolated from real data:
//   1. A synthetic payload round-tripped through the EXACT script shape
//      REDEEM_SCRIPT uses today (naive decode -> encode).
//   2. The same payload round-tripped through a candidate fix (explicitly
//      re-asserting cjson.null for any field that decodes to Lua nil,
//      immediately before encode).
//   3. A full simulated create -> store -> read -> "redeem" sequence using
//      the CANDIDATE FIXED script, against a disposable, clearly-namespaced
//      test key (diagnostic_test:access_code_null_roundtrip:v1) that is
//      deleted before and after the probe runs. Never touches
//      access_codes:v1 or any other real key.
//
// This script is meant to be deleted once the investigation concludes --
// it is not reusable operator tooling like access_code_diagnostic.mjs.

import { Redis } from '@upstash/redis'

function getClient() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('Upstash env vars are not configured')
  }
  return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
}

// @upstash/redis auto-deserializes values that look like JSON, so a GET or
// EVAL result may already be an object, not the raw string -- mirrors
// accessCodeStore.js's own parseRecord() helper, which defends against
// exactly this.
function toRecord(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  return JSON.parse(value)
}

// Mirrors REDEEM_SCRIPT's own decode -> encode shape exactly, minus the
// Redis reads/writes -- pure computation, touches no keys.
const NAIVE_ROUNDTRIP_SCRIPT = `
local t = cjson.decode(ARGV[1])
return cjson.encode(t)
`

// Candidate fix: force any field that came back as Lua nil after decode
// (whether because cjson.decode dropped JSON null to real nil, or because
// cjson.encode fails to re-emit the cjson.null sentinel) back to the
// cjson.null sentinel immediately before encoding.
const FIXED_ROUNDTRIP_SCRIPT = `
local t = cjson.decode(ARGV[1])
for _, k in ipairs({'b', 'd'}) do
  if t[k] == nil then t[k] = cjson.null end
end
return cjson.encode(t)
`

const TEST_KEY = 'diagnostic_test:access_code_null_roundtrip:v1'
const TEST_CLAIM_KEY = 'diagnostic_test:access_code_null_roundtrip_claim:v1'

// The candidate fixed REDEEM_SCRIPT -- identical structure/checks to the
// real one in accessCodeStore.js, plus the null re-assertion, run against
// the disposable test key instead of access_codes:v1.
const FIXED_REDEEM_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return false end
local ok, code = pcall(cjson.decode, raw)
if not ok then return false end
if code.status ~= 'active' then return false end
if code.redemptionCount >= code.maxRedemptions then return false end
for _, k in ipairs({'trialDays', 'discountPercent', 'discountFixedCents', 'expiresAt'}) do
  if code[k] == nil then code[k] = cjson.null end
end
code.redemptionCount = code.redemptionCount + 1
if not code.redemptions or code.redemptions == cjson.null then code.redemptions = {} end
table.insert(code.redemptions, { tenantId = ARGV[1], userId = ARGV[2], redeemedAt = ARGV[3] })
local encoded = cjson.encode(code)
redis.call('SET', KEYS[1], encoded)
redis.call('SET', KEYS[2], 'probe', 'EX', 60)
return encoded
`

async function main() {
  const client = getClient()
  const payload = JSON.stringify({ a: 1, b: null, c: 'x', d: null, e: 0, f: false })

  console.log('=== Probe 1: naive decode->encode round trip (mirrors REDEEM_SCRIPT today) ===')
  try {
    const naive = await client.eval(NAIVE_ROUNDTRIP_SCRIPT, [], [payload])
    const parsed = toRecord(naive)
    console.log(`Output: ${JSON.stringify(parsed)}`)
    console.log(`b key present: ${'b' in parsed}, value: ${JSON.stringify(parsed.b)} -- d key present: ${'d' in parsed}, value: ${JSON.stringify(parsed.d)}`)
  } catch (err) {
    console.log(`Probe 1 failed: ${err.message}`)
  }

  console.log('\n=== Probe 2: round trip WITH candidate fix (re-assert cjson.null before encode) ===')
  try {
    const fixed = await client.eval(FIXED_ROUNDTRIP_SCRIPT, [], [payload])
    const parsed = toRecord(fixed)
    console.log(`Output: ${JSON.stringify(parsed)}`)
    console.log(`b key present: ${'b' in parsed}, value: ${JSON.stringify(parsed.b)} -- d key present: ${'d' in parsed}, value: ${JSON.stringify(parsed.d)}`)
  } catch (err) {
    console.log(`Probe 2 failed: ${err.message}`)
  }

  console.log('\n=== Probe 3: full simulated create -> store -> read -> redeem, using the candidate fixed script ===')
  try {
    await client.del(TEST_KEY)
    await client.del(TEST_CLAIM_KEY)
    const testRecord = {
      status: 'active', redemptionCount: 0, maxRedemptions: 1,
      trialDays: null, discountPercent: null, discountFixedCents: null, expiresAt: null,
      redemptions: [],
    }
    await client.set(TEST_KEY, JSON.stringify(testRecord))

    const beforeRaw = await client.get(TEST_KEY)
    const before = toRecord(beforeRaw)
    console.log(`Before redemption -- trialDays present: ${'trialDays' in before}, value: ${JSON.stringify(before.trialDays)}`)

    const redeemResult = await client.eval(
      FIXED_REDEEM_SCRIPT,
      [TEST_KEY, TEST_CLAIM_KEY],
      ['test-tenant', 'test-user', new Date().toISOString()]
    )
    const after = toRecord(redeemResult)
    console.log(`After simulated redemption -- redemptionCount: ${after.redemptionCount}, trialDays present: ${'trialDays' in after}, value: ${JSON.stringify(after.trialDays)}, discountPercent present: ${'discountPercent' in after}, value: ${JSON.stringify(after.discountPercent)}, discountFixedCents present: ${'discountFixedCents' in after}, value: ${JSON.stringify(after.discountFixedCents)}`)

    const afterStoredRaw = await client.get(TEST_KEY)
    const afterStored = toRecord(afterStoredRaw)
    console.log(`Re-read from storage (not the script's return value) -- trialDays present: ${'trialDays' in afterStored}, value: ${JSON.stringify(afterStored.trialDays)}`)
  } catch (err) {
    console.log(`Probe 3 failed: ${err.message}`)
  } finally {
    await client.del(TEST_KEY)
    await client.del(TEST_CLAIM_KEY)
    console.log('(disposable test keys deleted)')
  }
}

main().catch(err => { console.error(err.stack || err.message); process.exitCode = 1 })
