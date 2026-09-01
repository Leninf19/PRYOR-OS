// Consolidated security-hardening checks -- Multi-Location Authentication &
// User Access System, Commit 7. Covers the explicit Phase 17 test
// categories not already exercised by a dedicated test file elsewhere in
// this milestone: CSV/export isolation, search isolation, a comprehensive
// audit-log secret-scan across every new function this milestone added
// (individual files already scope-check their own functions; this is the
// cross-cutting sweep), and a structural confirmation that Owner
// (locationIds === '*') continues to bypass every new scoping check
// unchanged (the "Owner regression" requirement).
//
// Run directly: node tests/test_security_hardening.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const API_DIR = path.join(REPO_ROOT, 'dashboard', 'api')
const SRC_DIR = path.join(REPO_ROOT, 'dashboard', 'src')

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

function readApi(relPath) { return readFileSync(path.join(API_DIR, relPath), 'utf-8') }
function readSrc(relPath) { return readFileSync(path.join(SRC_DIR, relPath), 'utf-8') }

// --- CSV / export isolation -------------------------------------------------

function testExportCSVIsAPureFunctionWithNoDataSourceOfItsOwn() {
  const s = readSrc('utils/exportUtils.js')
  assert(/export function exportCSV\(filename, headers, rows\)/.test(s), 'exportCSV must take rows as a plain argument, not fetch its own data')
  assert(!/fetch\(/.test(s), 'exportUtils.js must never call fetch() itself -- whatever rows a caller passes is exactly what gets exported, nothing more')
}

function testActiveExportCallersDeriveRowsFromScopedReviewData() {
  // Reviews.jsx and ExecutiveReports.jsx are the two ROUTED pages that
  // export (ReviewExplorer.jsx is the pre-M5 rollback artifact, not
  // reachable via any route -- see App.jsx). Both must build their
  // exportCSV `rows` argument via .map()/.filter() over the page's own
  // outlet-context review data (ultimately useReviewsData(), already
  // server-scoped by Commit 4) -- not from a raw fetch()/response variable.
  // Reviews.jsx legitimately calls fetch() elsewhere on this page (the
  // publish-bridge bulk read, /api/rewrite) for unrelated features, so the
  // check is scoped to the export call site itself, not the whole file.
  for (const file of ['pages/Reviews.jsx', 'pages/ExecutiveReports.jsx']) {
    const s = readSrc(file)
    const callSite = s.match(/const rows = (\w+)\.map\(/)
    assert(callSite, `${file}: could not find an exportCSV rows builder of the form "const rows = <source>.map(...)"`)
    const source = callSite[1]
    assert(!/^(res|response|data|json|body)$/i.test(source), `${file}: export rows must be built from the page's own review-data variable (e.g. "processed"/"filtered"), not a raw fetch response named "${source}"`)
    assert(s.includes('exportCSV'), `${file} must call exportCSV`)
  }
}

// --- search isolation --------------------------------------------------------

function testSmartSearchUsesOnlyAlreadyScopedDataSources() {
  const s = readSrc('components/SmartSearch.jsx')
  assert(/useReviewsData\(\)/.test(s) && /useMeta\(\)/.test(s), 'SmartSearch must source from useReviewsData()/useMeta(), both already server-scoped by Commit 4')
  // No company-wide-only hook and no independent fetch -- search results
  // must never be built by loading everything and hiding the rest.
  const forbiddenCompanyWideHooks = ['useKPIs', 'useLocationStats', 'useActionItems', 'useCompanySummary']
  for (const hook of forbiddenCompanyWideHooks) {
    assert(!new RegExp(`\\b${hook}\\b`).test(s), `SmartSearch must not reference the company-wide ${hook}() -- it would be blocked for a scoped account and is not needed (meta.json/allReviews already carry everything search needs)`)
  }
  assert(!/\bfetch\(/.test(s), 'SmartSearch must never call fetch() directly -- both its data sources go through the shared, scoped hooks')
}

// --- audit-log secret scan, consolidated across every new function ---------

function extractFunctionSource(src, functionName) {
  const start = src.indexOf(`async function ${functionName}(`)
  if (start === -1) return null
  const nextFnMatch = src.slice(start + 1).search(/\nasync function \w+\(|\nexport default async function/)
  return nextFnMatch === -1 ? src.slice(start) : src.slice(start, start + 1 + nextFnMatch)
}

function testNoNewFunctionEverLogsASecretToAppendAuditEntry() {
  const settingsSrc = readApi('settings/[action].js')
  const sessionSrc = readApi('session/[action].js')
  const functionsToCheck = [
    ['settings/[action].js', settingsSrc, 'inviteUserAction'],
    ['settings/[action].js', settingsSrc, 'resendInviteAction'],
    ['settings/[action].js', settingsSrc, 'revokeInviteAction'],
    ['settings/[action].js', settingsSrc, 'generateResetLinkAction'],
    ['settings/[action].js', settingsSrc, 'usersListAction'],
    ['settings/[action].js', settingsSrc, 'updateUserRoleLocationsAction'],
    ['settings/[action].js', settingsSrc, 'setUserDisabledAction'],
    ['session/[action].js', sessionSrc, 'login'],
    ['session/[action].js', sessionSrc, 'acceptInvite'],
    ['session/[action].js', sessionSrc, 'forgotPassword'],
    ['session/[action].js', sessionSrc, 'resetPassword'],
  ]
  const forbidden = [/\brawToken\b/, /\btokenHash\b/, /\bpasswordHash\b/, /[,{]\s*password\s*[,:]/]
  let checkedAtLeastOneCall = false
  for (const [fileName, src, fnName] of functionsToCheck) {
    const fnSrc = extractFunctionSource(src, fnName)
    assert(fnSrc, `could not locate function ${fnName} in ${fileName} -- has it been renamed?`)
    // Multi-Tenant Phase 2 prefixed every real call with a leading
    // `resolveTenantId(account), ` argument before the object literal --
    // [^,]* tolerates that (or any other single tenantId expression with no
    // comma of its own) ahead of the required comma + object literal.
    const calls = fnSrc.match(/appendAuditEntry\([^,]*,\s*\{[\s\S]*?\}\)/g) ?? []
    for (const call of calls) {
      checkedAtLeastOneCall = true
      for (const pattern of forbidden) {
        assert(!pattern.test(call), `${fileName}#${fnName}: an appendAuditEntry call matches forbidden pattern ${pattern} -- ${call}`)
      }
    }
  }
  assert(checkedAtLeastOneCall, 'this sweep must have actually found and checked at least one appendAuditEntry call -- an empty sweep would silently prove nothing')
}

// --- Owner regression: locationIds === '*' still bypasses every new check --

function testOwnerWildcardBypassesEveryNewLocationCheck() {
  // Structural confirmation that the wildcard short-circuit exists at every
  // point Commit 4 added a location check -- the actual behavioral proof
  // (a real request succeeding end-to-end for a wildcard account) is
  // already covered by test_publish_reply.js/test_data_endpoint.js's
  // pre-existing Owner-path tests, which this milestone's commits kept
  // green throughout (see each commit's own regression run). This test
  // guards the STRUCTURE that behavior depends on.
  const authSrc = readApi('_lib/auth.js')
  assert(/if \(locationIds === '\*'\) return true/.test(authSrc), 'requireLocationAccess must short-circuit true for a wildcard account -- this is what every other check in this milestone ultimately relies on')

  // Multi-Tenant Phase 3, reviewed update: the literal wildcard check this
  // assertion originally matched (`account.locationIds !== '*'`) was
  // replaced by the centralized, tenant-aware isWildcardGrant(account)
  // helper (dashboard/api/_lib/auth.js) -- a wildcard grant now only
  // shortcuts to "sees everything" when the account's own tenant actually
  // owns a location catalog (see tenants.js's tenantOwnsLocationCatalog()),
  // which is true for every real Los Tres Amigos account today, so a real
  // Owner's behavior is unchanged. The structural guarantee this test
  // exists to protect -- data.js gates its entire per-file/per-location
  // branch behind a wildcard check, never running it for a genuinely
  // company-wide account -- still holds, just via the new helper name.
  const dataSrc = readApi('data.js')
  assert(/if \(!isWildcardGrant\(account\)\)/.test(dataSrc), 'data.js must gate its entire per-file/per-location branch behind a non-wildcard (tenant-aware) check, leaving a genuinely company-wide account\'s existing behavior completely untouched')

  const publishSrc = readApi('google/[action].js')
  assert(/account\.locationIds !== '\*' && !reviewName/.test(publishSrc), 'publish()\'s fuzzy-fallback restriction must only apply to a non-wildcard account')
}

run('exportCSV is a pure function with no data source of its own', testExportCSVIsAPureFunctionWithNoDataSourceOfItsOwn)
run('the active export-capable pages derive their rows from already-scoped review data, never an independent fetch', testActiveExportCallersDeriveRowsFromScopedReviewData)
run('SmartSearch sources only from already-scoped hooks, never a company-wide hook or its own fetch', testSmartSearchUsesOnlyAlreadyScopedDataSources)
run('no new function in this milestone ever logs a raw token, token hash, or password to the audit log', testNoNewFunctionEverLogsASecretToAppendAuditEntry)
run('Owner (locationIds === \'*\') structurally bypasses every new location check added in Commit 4', testOwnerWildcardBypassesEveryNewLocationCheck)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
