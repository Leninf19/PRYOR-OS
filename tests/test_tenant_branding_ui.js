// Multi-Tenant Phase 4J -- source-content regression tests for tenant
// branding wiring in Layout.jsx (sidebar footer label + optional logo).
// Same regex/source-content convention as this project's other *_ui.js
// tests (no React render framework here).
//
// Run directly: node tests/test_tenant_branding_ui.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.resolve(__dirname, '..', 'dashboard', 'src')

function read(relPath) {
  return readFileSync(path.join(SRC_DIR, relPath), 'utf-8')
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

const content = read('components/Layout.jsx')

function testImportsTenantStatus() {
  assert(/from '\.\.\/hooks\/useTenantStatus\.js'/.test(content), 'Layout.jsx must read tenant branding from the real useTenantStatus() hook')
}

function testFooterLabelUsesTenantDisplayNameWithLtaFallback() {
  assert(/const tenantDisplayName = tenantStatus\?\.displayName \|\| 'Los Tres Amigos'/.test(content),
    'the sidebar footer must use tenantStatus.displayName, falling back to the exact literal "Los Tres Amigos" (LTA\'s own tenant-status response already returns this, so the fallback is defense-in-depth, not a behavior change for LTA)')
  assert(!/`Los Tres Amigos ·/.test(content), 'the OLD hardcoded "Los Tres Amigos ·" literal must be gone -- the label must be built from tenantDisplayName now')
  assert(/\$\{tenantDisplayName\} ·/.test(content), 'the footer label must interpolate the tenant-aware display name')
}

function testLogoRendersOnlyWhenConfigured() {
  assert(/tenantStatus\?\.logoUrl && \(/.test(content), 'a tenant logo must only render when tenant_config actually has a logoUrl -- never a placeholder image')
}

function testProductBrandingUnchanged() {
  // The Pryor OS product logo/attribution must remain exactly as before --
  // this phase changes only the RESTAURANT/tenant identity, never the
  // product's own branding.
  assert(/pryor-os-black-cropped\.svg/.test(content) && /pryor-os-white-cropped\.svg/.test(content), 'the Pryor OS product logo images must be unchanged')
  assert(/By Future Marketing Studio/.test(content), 'the product attribution line must be unchanged')
}

run('Layout.jsx imports useTenantStatus', testImportsTenantStatus)
run('the footer label uses tenant displayName with the LTA-preserving fallback', testFooterLabelUsesTenantDisplayNameWithLtaFallback)
run('a tenant logo renders only when configured', testLogoRendersOnlyWhenConfigured)
run('Pryor OS product branding is unchanged', testProductBrandingUnchanged)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
