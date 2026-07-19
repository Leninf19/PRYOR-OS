#!/usr/bin/env node
// Optional deploy-time readiness check -- NOT wired into vercel.json's
// buildCommand automatically. Vercel serverless functions have no
// persistent process to run a real "boot-time" assertion in (every
// invocation is stateless), so the closest equivalent is a check that runs
// during the build step, which CAN fail the deployment outright if it
// exits non-zero.
//
// This is left as an opt-in because failing the build over a missing
// Upstash config would block every deploy (including ones that don't
// touch auth/rate-limiting at all) until it's configured -- that's a real
// tradeoff the project owner should choose deliberately, not one this
// script should impose silently.
//
// To enable: change dashboard/vercel.json's "buildCommand" to
// `"node scripts/check-prod-env.mjs && npm run build"`.
//
// Run directly: node scripts/check-prod-env.mjs

function fail(msg) {
  console.error(`::error::check-prod-env: ${msg}`)
  process.exitCode = 1
}

function checkAccountDirectory() {
  const raw = process.env.ACCOUNT_DIRECTORY_JSON
  if (!raw) return fail('ACCOUNT_DIRECTORY_JSON is not set.')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fail('ACCOUNT_DIRECTORY_JSON is not valid JSON.')
  }
  if (!parsed || !Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
    return fail('ACCOUNT_DIRECTORY_JSON must contain a non-empty "accounts" array.')
  }
  console.log(`check-prod-env: ACCOUNT_DIRECTORY_JSON has ${parsed.accounts.length} account(s).`)
}

function checkSessionSecret() {
  const secret = process.env.SESSION_SIGNING_SECRET
  if (!secret) return fail('SESSION_SIGNING_SECRET is not set.')
  if (secret.length < 32) return fail('SESSION_SIGNING_SECRET is shorter than 32 characters.')
  console.log('check-prod-env: SESSION_SIGNING_SECRET is set.')
}

function checkUpstash() {
  const hasUrl = Boolean(process.env.UPSTASH_REDIS_REST_URL)
  const hasToken = Boolean(process.env.UPSTASH_REDIS_REST_TOKEN)
  if (!hasUrl || !hasToken) {
    fail('UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN are not both set -- sensitive endpoints will return 503 in production until this is configured.')
    return
  }
  console.log('check-prod-env: Upstash rate-limiting config is present.')
}

checkAccountDirectory()
checkSessionSecret()
checkUpstash()

if (process.exitCode) {
  console.error('check-prod-env: FAILED -- see errors above.')
} else {
  console.log('check-prod-env: all checks passed.')
}
