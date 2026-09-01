// Multi-Tenant Phase 1 -- pure Redis key-builder functions for the future
// tenant-scoped stores identified in the Phase 1 audit. NONE of these keys
// are read from or written to production Redis by this phase -- every
// existing store (actionStore.js, auditLog.js, campaignStore.js,
// contactStore.js, contentAssetStore.js, credentialStore.js,
// notificationStore.js, publishBridgeStore.js, taskStore.js, tokenStore.js,
// userStore.js) is completely unmodified and continues to read/write its
// existing v1 (or v2, for tasks) key exactly as before. This file exists
// so the eventual migration -- a separate, reviewed phase -- has one
// canonical, tested place that defines what each v2/v3 key string looks
// like, rather than reinventing the format ad hoc under time pressure.
//
// Every function validates its tenantId argument and throws rather than
// silently building a malformed or empty-segment key -- a key-building
// bug here would be a cross-tenant data leak the moment a later phase
// wires these in, so failing loudly now is deliberate.

import { isValidTenantId } from './tenants.js'

function assertValidTenantId(tenantId, fnName) {
  if (!isValidTenantId(tenantId)) {
    throw new TypeError(`${fnName}: invalid tenantId ${JSON.stringify(tenantId)}`)
  }
}

function assertNonEmptyString(value, argName, fnName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${fnName}: invalid ${argName} ${JSON.stringify(value)}`)
  }
}

export function usersKeyV2(tenantId) {
  assertValidTenantId(tenantId, 'usersKeyV2')
  return `users:v2:${tenantId}`
}

export function usersEmailIndexKeyV2(tenantId) {
  assertValidTenantId(tenantId, 'usersEmailIndexKeyV2')
  return `users_email_index:v2:${tenantId}`
}

export function contactsKeyV2(tenantId) {
  assertValidTenantId(tenantId, 'contactsKeyV2')
  return `restaurant_contacts:v2:${tenantId}`
}

export function actionWorkspaceKeyV2(tenantId) {
  assertValidTenantId(tenantId, 'actionWorkspaceKeyV2')
  return `action_workspace:v2:${tenantId}`
}

export function campaignsKeyV2(tenantId) {
  assertValidTenantId(tenantId, 'campaignsKeyV2')
  return `content_campaigns:v2:${tenantId}`
}

export function contentAssetsKeyV2(tenantId) {
  assertValidTenantId(tenantId, 'contentAssetsKeyV2')
  return `content_assets:v2:${tenantId}`
}

// Existing key is tasks:v2 (not v1) -- the tenant-scoped successor bumps
// to v3 so the version number keeps meaning "this is a schema change,"
// consistent with how tasks:v2 itself was already one bump ahead of every
// other store when it was introduced.
export function tasksKeyV3(tenantId) {
  assertValidTenantId(tenantId, 'tasksKeyV3')
  return `tasks:v3:${tenantId}`
}

export function auditLogKeyV2(tenantId) {
  assertValidTenantId(tenantId, 'auditLogKeyV2')
  return `audit_log:v2:${tenantId}`
}

// Notification Center has three distinct key shapes today (a permanent
// per-user "has this user been seeded" marker, per-review reply-failure
// records, and a per-user read-state hash) -- all three gain a tenant
// segment, ahead of the userId/reviewId segment they already have.
//
// Phase 2 correction: the real v1 prefixes (dashboard/api/_lib/
// notificationStore.js) are `notif_reply_failed:v1:` and `notif_read:v1:`
// -- Phase 1's first draft of these two builders used slightly different
// words ("notif_reply_failure"/"notif_read_state"). Fixed here, before
// anything reads or writes a v2 key, so the v2 family stays a true parallel
// of the real v1 names rather than diverging from them.
export function notifSeededKeyV2(tenantId, userId) {
  assertValidTenantId(tenantId, 'notifSeededKeyV2')
  assertNonEmptyString(userId, 'userId', 'notifSeededKeyV2')
  return `notif_seeded:v2:${tenantId}:${userId}`
}

export function notifReplyFailureKeyV2(tenantId, reviewId) {
  assertValidTenantId(tenantId, 'notifReplyFailureKeyV2')
  assertNonEmptyString(reviewId, 'reviewId', 'notifReplyFailureKeyV2')
  return `notif_reply_failed:v2:${tenantId}:${reviewId}`
}

export function notifReadStateKeyV2(tenantId, userId) {
  assertValidTenantId(tenantId, 'notifReadStateKeyV2')
  assertNonEmptyString(userId, 'userId', 'notifReadStateKeyV2')
  return `notif_read:v2:${tenantId}:${userId}`
}

export function publishBridgeKeyV2(tenantId, reviewId) {
  assertValidTenantId(tenantId, 'publishBridgeKeyV2')
  assertNonEmptyString(reviewId, 'reviewId', 'publishBridgeKeyV2')
  return `publish_bridge:v2:${tenantId}:${reviewId}`
}

// Google credential -- see the audit's "Google OAuth Multi-Tenant Design"
// section. NOT wired to any endpoint in Phase 1: google/[action].js still
// reads/writes gbp_credentials:v1 exclusively, unmodified. This phase does
// not touch that file, reconnect Google, or modify gbp_credentials:v1 in
// any way.
export function credentialKeyV2(tenantId) {
  assertValidTenantId(tenantId, 'credentialKeyV2')
  return `gbp_credentials:v2:${tenantId}`
}

// Every v1 (or v2, for tasks) key name this phase is preparing a
// tenant-scoped successor for, paired with its future key-builder --
// used by the migration script's dry-run report and by tests asserting
// this pairing set stays in sync with both the audit and the real store
// files' own key constants. Deliberately NOT including tokenStore.js's
// invite:{hash}/reset:{hash} keys -- those stay globally-keyed by design
// (the token itself is already unguessable), only gaining a `tenantId`
// field inside their payload in a later phase, not a rekeyed Redis key.
export const V1_TO_V2_KEY_MAP = Object.freeze([
  Object.freeze({ v1Key: 'users:v1', buildKey: usersKeyV2 }),
  Object.freeze({ v1Key: 'users_email_index:v1', buildKey: usersEmailIndexKeyV2 }),
  Object.freeze({ v1Key: 'restaurant_contacts:v1', buildKey: contactsKeyV2 }),
  Object.freeze({ v1Key: 'action_workspace:v1', buildKey: actionWorkspaceKeyV2 }),
  Object.freeze({ v1Key: 'content_campaigns:v1', buildKey: campaignsKeyV2 }),
  Object.freeze({ v1Key: 'content_assets:v1', buildKey: contentAssetsKeyV2 }),
  Object.freeze({ v1Key: 'tasks:v2', buildKey: tasksKeyV3 }),
  Object.freeze({ v1Key: 'audit_log:v1', buildKey: auditLogKeyV2 }),
  Object.freeze({ v1Key: 'gbp_credentials:v1', buildKey: credentialKeyV2 }),
])
