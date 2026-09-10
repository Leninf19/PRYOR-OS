// Regression tests for dashboard/api/_lib/auditLog.js -- the cross-entity,
// company-wide audit trail (Phase 8, Milestone 8.6). No real Upstash
// account anywhere in this file: every test drives the module's test-only
// client-factory seam, same pattern as actionStore.js/contactStore.js.
//
// Run directly: node tests/test_audit_log.js

import {
  appendAuditEntry,
  listAuditEntries,
  clientIp,
  AuditLogUnavailableError,
  _setRedisClientForTests,
  _resetRedisClientForTests,
} from '../dashboard/api/_lib/auditLog.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
async function run(name, fn) {
  try {
    await fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  } finally {
    _resetRedisClientForTests()
  }
}

// A tiny in-memory stand-in for the real Upstash LIST commands this module
// uses (lpush/ltrim/lrange). Records every ltrim call's args so the
// capping behavior itself can be asserted without needing 20,000 entries.
function fakeRedis() {
  const list = []
  const ltrimCalls = []
  return {
    lpush: async (_key, value) => { list.unshift(value); return list.length },
    ltrim: async (_key, start, stop) => { ltrimCalls.push([start, stop]); return 'OK' },
    lrange: async (_key, start, stop) => list.slice(start, stop === -1 ? undefined : stop + 1),
    _list: list,
    _ltrimCalls: ltrimCalls,
  }
}

const OWNER = { actorId: 'usr_owner', actorName: 'Owner Person', actorEmail: 'owner@example.com', ip: '203.0.113.5' }

async function testAppendNeverThrowsWhenUnconfigured() {
  const ok = await appendAuditEntry(DEFAULT_TENANT_ID, { ...OWNER, entity: 'contact', entityId: '9', action: 'contact.created', changes: null, result: 'success', message: 'x' })
  assert(ok === false, 'appendAuditEntry must return false (not throw) when the audit log is unconfigured -- it must never break the caller\'s primary action')
}

async function testListThrowsWhenUnconfigured() {
  let threw = false
  try {
    await listAuditEntries(DEFAULT_TENANT_ID, {})
  } catch (err) {
    threw = err instanceof AuditLogUnavailableError
  }
  assert(threw, 'listAuditEntries must throw AuditLogUnavailableError when unconfigured -- an empty log must never be confused with a genuinely empty audit trail')
}

async function testAppendStampsIdAndTimestamp() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  const ok = await appendAuditEntry(DEFAULT_TENANT_ID, { ...OWNER, entity: 'contact', entityId: '9', action: 'contact.created', changes: null, result: 'success', message: 'Created contact for Canton.' })
  assert(ok === true, 'a configured store must return true on a successful append')
  const { entries } = await listAuditEntries(DEFAULT_TENANT_ID, {})
  assert(entries.length === 1, 'the appended entry must be readable back')
  assert(typeof entries[0].id === 'string' && entries[0].id.length > 0, 'a server-generated id must be stamped')
  assert(typeof entries[0].at === 'string' && !isNaN(new Date(entries[0].at).getTime()), 'a server-generated ISO timestamp must be stamped')
  assert(entries[0].actorId === 'usr_owner', 'actor fields must be preserved')
}

async function testAppendCallsLtrimToCapTheList() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await appendAuditEntry(DEFAULT_TENANT_ID, { ...OWNER, entity: 'contact', entityId: '9', action: 'contact.created', changes: null, result: 'success', message: 'x' })
  assert(client._ltrimCalls.length === 1, 'every append must call ltrim to cap the list length')
  const [start, stop] = client._ltrimCalls[0]
  assert(start === 0 && stop === 19999, `ltrim must cap at the most recent 20,000 entries, got [${start}, ${stop}]`)
}

async function testListReturnsNewestFirst() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await appendAuditEntry(DEFAULT_TENANT_ID, { ...OWNER, entity: 'contact', entityId: '1', action: 'contact.created', changes: null, result: 'success', message: 'first' })
  await appendAuditEntry(DEFAULT_TENANT_ID, { ...OWNER, entity: 'contact', entityId: '2', action: 'contact.created', changes: null, result: 'success', message: 'second' })
  const { entries } = await listAuditEntries(DEFAULT_TENANT_ID, {})
  assert(entries[0].message === 'second', 'the most recently appended entry must come first (LPUSH prepends)')
  assert(entries[1].message === 'first', 'older entries follow in order')
}

async function testFiltersByEntity() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await appendAuditEntry(DEFAULT_TENANT_ID, { ...OWNER, entity: 'contact', entityId: '1', action: 'contact.created', changes: null, result: 'success', message: 'a contact event' })
  await appendAuditEntry(DEFAULT_TENANT_ID, { ...OWNER, entity: 'google_oauth', entityId: null, action: 'google.reconnected', changes: null, result: 'success', message: 'an oauth event' })
  const { entries, total } = await listAuditEntries(DEFAULT_TENANT_ID, { entity: 'contact' })
  assert(total === 1 && entries.length === 1, 'filtering by entity must exclude non-matching entries')
  assert(entries[0].entity === 'contact')
}

async function testFiltersByActorIdAndResult() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await appendAuditEntry(DEFAULT_TENANT_ID, { ...OWNER, entity: 'contact', entityId: '1', action: 'contact.created', changes: null, result: 'success', message: 'owner did this' })
  await appendAuditEntry(DEFAULT_TENANT_ID, { actorId: 'usr_martin', actorName: 'Martin', actorEmail: 'martin@example.com', ip: null, entity: 'contact', entityId: '2', action: 'contact.created', changes: null, result: 'failure', message: 'martin failed' })
  const byActor = await listAuditEntries(DEFAULT_TENANT_ID, { actorId: 'usr_martin' })
  assert(byActor.total === 1 && byActor.entries[0].message === 'martin failed', 'filtering by actorId must work')
  const byResult = await listAuditEntries(DEFAULT_TENANT_ID, { result: 'failure' })
  assert(byResult.total === 1 && byResult.entries[0].result === 'failure', 'filtering by result must work')
}

async function testPaginatesWithLimitAndOffset() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  for (let i = 0; i < 5; i++) {
    await appendAuditEntry(DEFAULT_TENANT_ID, { ...OWNER, entity: 'contact', entityId: String(i), action: 'contact.created', changes: null, result: 'success', message: `event ${i}` })
  }
  const page1 = await listAuditEntries(DEFAULT_TENANT_ID, { limit: 2, offset: 0 })
  assert(page1.entries.length === 2 && page1.total === 5, 'a page must respect limit while total reflects the full filtered count')
  const page2 = await listAuditEntries(DEFAULT_TENANT_ID, { limit: 2, offset: 2 })
  assert(page2.entries.length === 2, 'offset must skip already-seen entries')
  assert(page1.entries[0].message !== page2.entries[0].message, 'different pages must return different entries')
}

async function testMalformedStoredEntryIsSkippedNotThrown() {
  const client = fakeRedis()
  client._list.push('not valid json {{{')
  _setRedisClientForTests(() => client)
  const { entries, total } = await listAuditEntries(DEFAULT_TENANT_ID, {})
  assert(entries.length === 0 && total === 0, 'a corrupted stored entry must be skipped, not crash the whole read')
}

async function testReadFailureThrowsUnavailable() {
  _setRedisClientForTests(() => ({ lrange: async () => { throw new Error('ECONNREFUSED fake-upstash-outage') } }))
  let threw = false
  try {
    await listAuditEntries(DEFAULT_TENANT_ID, {})
  } catch (err) {
    threw = err instanceof AuditLogUnavailableError
  }
  assert(threw, 'a Redis read failure must surface as AuditLogUnavailableError, never as an empty result')
}

async function testAppendFailureLogsAndReturnsFalseNeverThrows() {
  _setRedisClientForTests(() => ({ lpush: async () => { throw new Error('ECONNREFUSED fake-upstash-outage') } }))
  const ok = await appendAuditEntry(DEFAULT_TENANT_ID, { ...OWNER, entity: 'contact', entityId: '1', action: 'contact.created', changes: null, result: 'success', message: 'x' })
  assert(ok === false, 'an append failure must return false, never throw -- the audit log must never break the caller\'s primary action')
}

function testClientIpReadsFirstForwardedHop() {
  assert(clientIp({ headers: { 'x-forwarded-for': '203.0.113.5, 70.41.3.18' } }) === '203.0.113.5', 'must return only the first hop')
  assert(clientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }) === '127.0.0.1', 'must fall back to socket.remoteAddress')
  assert(clientIp({ headers: {}, socket: {} }) === null, 'must return null (never throw) when no IP is available at all')
}

async function main() {
  await run('appendAuditEntry never throws when unconfigured (returns false)', testAppendNeverThrowsWhenUnconfigured)
  await run('listAuditEntries throws AuditLogUnavailableError when unconfigured', testListThrowsWhenUnconfigured)
  await run('append stamps a server-generated id and timestamp', testAppendStampsIdAndTimestamp)
  await run('every append calls ltrim to cap the list at 20,000 entries', testAppendCallsLtrimToCapTheList)
  await run('list returns newest-first', testListReturnsNewestFirst)
  await run('filters by entity', testFiltersByEntity)
  await run('filters by actorId and result', testFiltersByActorIdAndResult)
  await run('paginates with limit and offset', testPaginatesWithLimitAndOffset)
  await run('a corrupted stored entry is skipped, not thrown', testMalformedStoredEntryIsSkippedNotThrown)
  await run('a Redis read failure surfaces as AuditLogUnavailableError', testReadFailureThrowsUnavailable)
  await run('an append failure logs and returns false, never throws', testAppendFailureLogsAndReturnsFalseNeverThrows)
  await run('clientIp reads the first forwarded hop, falls back safely', testClientIpReadsFirstForwardedHop)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
