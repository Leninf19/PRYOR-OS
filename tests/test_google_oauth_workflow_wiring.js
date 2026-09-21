// Dual-client Google Business Profile OAuth migration (PRYOR OS Google
// Cloud project migration, Phase 5) -- static checks that every GitHub
// Actions workflow running a Python GBP consumer exposes the new
// GOOGLE_CLIENT_ID_LEGACY / GOOGLE_CLIENT_SECRET_LEGACY /
// GOOGLE_CLIENT_ID_PRYOR / GOOGLE_CLIENT_SECRET_PRYOR secret names
// ADDITIVELY (the existing bare GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET must
// remain present, unremoved), and that none of this ever conflates GBP
// credentials with PRYOR's separate login client
// (GOOGLE_AUTH_CLIENT_ID/GOOGLE_AUTH_CLIENT_SECRET).
//
// Run directly: node tests/test_google_oauth_workflow_wiring.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOWS_DIR = path.resolve(__dirname, '..', '.github', 'workflows')

function read(file) {
  return readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8').replace(/\r\n/g, '\n')
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
function run(name, fn) {
  try {
    fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  }
}

// Every workflow that runs a Python script funneling through
// google_api.py::get_access_token() -- confirmed by direct source
// inspection (Phase 5 audit): all six use the bare GOOGLE_CLIENT_ID/
// GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN triple for a real GBP
// consumer (sync_reviews.py/critical_alert_check.py/gbp_import.py/the
// GBP diagnostics), plus tenant-lifecycle.yml/tenant-lifecycle-dispatch.yml's
// PRODUCTION-only steps (initial_sync.py). PREVIEW_GOOGLE_CLIENT_ID/SECRET
// steps in the latter two are a SEPARATE, orthogonal Preview/Production
// environment-isolation mechanism, deliberately out of scope for this
// migration (see this phase's own design notes) -- not tested here as
// requiring the new suffixed names.
const NEW_VAR_NAMES = ['GOOGLE_CLIENT_ID_LEGACY', 'GOOGLE_CLIENT_SECRET_LEGACY', 'GOOGLE_CLIENT_ID_PRYOR', 'GOOGLE_CLIENT_SECRET_PRYOR']

const WORKFLOWS_WITH_BARE_TRIPLE = [
  'update-reviews.yml',
  'critical-alert-check.yml',
  'historical-import.yml',
  'diagnostic-gbp-locations.yml',
  'diagnostic-gbp-review-media.yml',
  'diagnostic-gbp-reply-reconciliation.yml',
]

const WORKFLOWS_WITH_PRODUCTION_PAIR_ONLY = [
  'tenant-lifecycle.yml',
  'tenant-lifecycle-dispatch.yml',
]

run('every bare-triple workflow additively exposes all 4 new secret names', () => {
  for (const file of WORKFLOWS_WITH_BARE_TRIPLE) {
    const src = read(file)
    assert(src.includes('GOOGLE_CLIENT_ID: ${{ secrets.GOOGLE_CLIENT_ID }}'), `${file}: bare GOOGLE_CLIENT_ID must remain present, unremoved`)
    assert(src.includes('GOOGLE_CLIENT_SECRET: ${{ secrets.GOOGLE_CLIENT_SECRET }}'), `${file}: bare GOOGLE_CLIENT_SECRET must remain present, unremoved`)
    assert(src.includes('GOOGLE_REFRESH_TOKEN: ${{ secrets.GOOGLE_REFRESH_TOKEN }}'), `${file}: GOOGLE_REFRESH_TOKEN must remain present, unremoved`)
    for (const name of NEW_VAR_NAMES) {
      assert(src.includes(`${name}: \${{ secrets.${name} }}`), `${file}: missing new wired variable ${name}`)
    }
  }
})

run('every production-pair-only workflow additively exposes all 4 new secret names on its Production steps', () => {
  for (const file of WORKFLOWS_WITH_PRODUCTION_PAIR_ONLY) {
    const src = read(file)
    const bareOccurrences = (src.match(/GOOGLE_CLIENT_ID: \$\{\{ secrets\.GOOGLE_CLIENT_ID \}\}/g) || []).length
    assert(bareOccurrences >= 1, `${file}: expected at least one bare GOOGLE_CLIENT_ID Production step`)
    for (const name of NEW_VAR_NAMES) {
      const occurrences = (src.match(new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`, 'g')) || []).length
      assert(occurrences === bareOccurrences, `${file}: expected ${name} wired alongside every bare Production GOOGLE_CLIENT_ID step (${bareOccurrences}), found ${occurrences}`)
    }
  }
})

run('PREVIEW_GOOGLE_CLIENT_ID/SECRET steps are untouched (no new suffixed names leaked onto the Preview path)', () => {
  for (const file of WORKFLOWS_WITH_PRODUCTION_PAIR_ONLY) {
    const src = read(file)
    // Every "GOOGLE_CLIENT_ID: ${{ secrets.PREVIEW_GOOGLE_CLIENT_ID }}" step
    // must NOT be immediately followed by the new suffixed lines -- this
    // migration is scoped to the Production client pair only.
    const previewStepRe = /GOOGLE_CLIENT_ID: \$\{\{ secrets\.PREVIEW_GOOGLE_CLIENT_ID \}\}\n\s*GOOGLE_CLIENT_SECRET: \$\{\{ secrets\.PREVIEW_GOOGLE_CLIENT_SECRET \}\}\n(\s*GOOGLE_CLIENT_ID_LEGACY)/
    assert(!previewStepRe.test(src), `${file}: a Preview step must never gain the new Production-scoped suffixed variables`)
  }
})

run('no workflow ever references GOOGLE_AUTH_CLIENT_ID/SECRET alongside GBP wiring (no conflation with the login client)', () => {
  for (const file of [...WORKFLOWS_WITH_BARE_TRIPLE, ...WORKFLOWS_WITH_PRODUCTION_PAIR_ONLY]) {
    const src = read(file)
    assert(!src.includes('GOOGLE_AUTH_CLIENT_ID'), `${file}: must never reference GOOGLE_AUTH_CLIENT_ID -- that is PRYOR's separate login client, never a GBP workflow secret`)
    assert(!src.includes('GOOGLE_AUTH_CLIENT_SECRET'), `${file}: must never reference GOOGLE_AUTH_CLIENT_SECRET`)
  }
})

run('no workflow prints a secret value for the new variables (no echo/cat of the new names)', () => {
  for (const file of [...WORKFLOWS_WITH_BARE_TRIPLE, ...WORKFLOWS_WITH_PRODUCTION_PAIR_ONLY]) {
    const src = read(file)
    for (const name of NEW_VAR_NAMES) {
      const printLines = src.split('\n').filter(line => line.includes(name) && /echo|print|cat\s/.test(line))
      assert(printLines.length === 0, `${file}: found a line that both references ${name} and looks like it prints something: ${JSON.stringify(printLines)}`)
    }
  }
})

const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed}/${results.length} tests passed`)
process.exit(failed > 0 ? 1 : 0)
