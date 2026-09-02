// Multi-Tenant Phase 4F.1 -- validates tenantBlobKeys.js's key-derivation
// formula against the shared cross-language fixture (see
// tenant_blob_keys.py's own test file for the Python-side counterpart).
//
// Run directly: node tests/test_tenant_blob_keys_cross_language_consistency.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  tenantBlobRoot, reviewDbBlobKey, privateDataPrefix, privateDataBlobKey, InvalidBlobKeyInputError,
} from '../dashboard/api/_lib/tenantBlobKeys.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, 'fixtures', 'tenant_blob_keys_shape.json'), 'utf-8'))

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

run('tenantBlobRoot matches the fixture', () => {
  assert(tenantBlobRoot(fixture.exampleTenantId) === fixture.expected.tenantBlobRoot, 'root mismatch')
})

run('reviewDbBlobKey matches the fixture', () => {
  assert(reviewDbBlobKey(fixture.exampleTenantId) === fixture.expected.reviewDbBlobKey, 'reviewDbBlobKey mismatch')
})

run('privateDataPrefix matches the fixture', () => {
  assert(privateDataPrefix(fixture.exampleTenantId) === fixture.expected.privateDataPrefix, 'privateDataPrefix mismatch')
})

run('privateDataBlobKey matches the fixture for every listed relPath', () => {
  for (const [relPath, expectedKey] of Object.entries(fixture.expected.privateDataBlobKeys)) {
    const actual = privateDataBlobKey(fixture.exampleTenantId, relPath)
    assert(actual === expectedKey, `${relPath}: expected ${expectedKey}, got ${actual}`)
  }
})

run('privateDataBlobKey accepts an explicit prefix matching the derived one', () => {
  const prefix = privateDataPrefix(fixture.exampleTenantId)
  const key = privateDataBlobKey(fixture.exampleTenantId, 'meta.json', prefix)
  assert(key === fixture.expected.privateDataBlobKeys['meta.json'], 'explicit-prefix key mismatch')
})

run('every fixture-listed invalid relPath is rejected', () => {
  for (const bad of fixture.invalidRelPaths) {
    let threw = false
    try {
      privateDataBlobKey(fixture.exampleTenantId, bad)
    } catch (e) {
      threw = e instanceof InvalidBlobKeyInputError
    }
    assert(threw, `expected rejection for relPath ${JSON.stringify(bad)}`)
  }
})

run('an invalid tenantId is rejected before any key is computed', () => {
  for (const bad of ['', 't_..', 't_a/b', '../evil', 'not-even-prefixed']) {
    let threw = false
    try {
      reviewDbBlobKey(bad)
    } catch (e) {
      threw = e instanceof InvalidBlobKeyInputError
    }
    assert(threw, `expected rejection for tenantId ${JSON.stringify(bad)}`)
  }
})

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exitCode = 0
} else {
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exitCode = 1
}
