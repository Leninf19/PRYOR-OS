// Regression tests for dashboard/src/pages/settings/settingsSections.js --
// the Phase 8 extensibility mechanism (Part 7). Structural checks only --
// component values are React.lazy() wrappers, never invoked here (same
// technique test_action_workspace_utils.js uses for logic-only imports).
//
// Run directly: node tests/test_settings_registry.js

import { settingsSections } from '../dashboard/src/pages/settings/settingsSections.js'

// REVIEWED UPDATE (Multi-Location Authentication & User Access System,
// Commit 1): 'admin' added to accounts.js's ROLES.
const KNOWN_ROLES = new Set(['owner', 'admin', 'marketing', 'location_manager', 'read_only'])

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

function testRegistryIsNonEmptyArray() {
  assert(Array.isArray(settingsSections), 'settingsSections must be an array')
  assert(settingsSections.length > 0, 'settingsSections must not be empty')
}

function testEveryEntryHasRequiredShape() {
  for (const s of settingsSections) {
    assert(typeof s.id === 'string' && s.id.length > 0, `entry missing a valid id: ${JSON.stringify(s)}`)
    assert(typeof s.path === 'string', `entry ${s.id} must have a string path (possibly empty for the index route)`)
    assert(typeof s.label === 'string' && s.label.length > 0, `entry ${s.id} missing a label`)
    assert(typeof s.component === 'object' || typeof s.component === 'function',
      `entry ${s.id}'s component must be a React.lazy() reference`)
  }
}

function testIdsAreUnique() {
  const ids = settingsSections.map(s => s.id)
  assert(new Set(ids).size === ids.length, `duplicate id(s) found: ${ids.join(', ')}`)
}

function testPathsAreUnique() {
  const paths = settingsSections.map(s => s.path)
  assert(new Set(paths).size === paths.length, `duplicate path(s) found: ${paths.join(', ')}`)
}

function testExactlyOneIndexRoute() {
  const indexEntries = settingsSections.filter(s => s.path === '')
  assert(indexEntries.length === 1, `expected exactly one index (path: '') entry, found ${indexEntries.length}`)
}

function testRequiredRolesReferenceKnownRolesOnly() {
  for (const s of settingsSections) {
    if (s.requiredRoles == null) continue
    assert(Array.isArray(s.requiredRoles), `entry ${s.id}'s requiredRoles must be null or an array`)
    for (const role of s.requiredRoles) {
      assert(KNOWN_ROLES.has(role), `entry ${s.id} references an unknown role: ${role}`)
    }
  }
}

function testGeneralAndGoogleSectionsExist() {
  const ids = settingsSections.map(s => s.id)
  assert(ids.includes('general'), 'the General section (moved out of the old flat Settings.jsx) must exist')
  assert(ids.includes('google'), 'the Google Business Profile section must exist')
}

function main() {
  run('registry is a non-empty array', testRegistryIsNonEmptyArray)
  run('every entry has the required shape', testEveryEntryHasRequiredShape)
  run('every entry has a unique id', testIdsAreUnique)
  run('every entry has a unique path', testPathsAreUnique)
  run('exactly one index (path: "") entry exists', testExactlyOneIndexRoute)
  run('requiredRoles (when present) only references known roles', testRequiredRolesReferenceKnownRolesOnly)
  run('General and Google Business Profile sections exist', testGeneralAndGoogleSectionsExist)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
