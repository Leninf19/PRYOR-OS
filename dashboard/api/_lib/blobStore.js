// Operations Calendar + Content Library milestone -- the seam between
// content/[action].js and however binary asset storage is actually
// provided. Same role as emailSender.js's own wrapper over nodemailer
// (_setTransportForTests): a third-party SDK is never imported directly by
// an endpoint file, so tests can substitute a fake without a module-mocking
// framework this codebase doesn't otherwise use.
//
// AUTHENTICATION (audited against the installed @vercel/blob@2.8.0 SDK
// directly -- dashboard/node_modules/@vercel/blob/dist/chunk-*.js's
// resolveBlobAuth()): every operation (put/get/del, via requestApi())
// resolves credentials as:
//   1. an explicit `token` option (never used here -- see below),
//   2. otherwise a Vercel OIDC token (`VERCEL_OIDC_TOKEN`, auto-injected by
//      the Vercel runtime into every Function invocation when OIDC
//      federation is enabled for the project -- which it is here, since
//      the Blob store was connected the current Vercel-native way) paired
//      with `BLOB_STORE_ID` (also auto-provisioned on connection),
//   3. otherwise `BLOB_READ_WRITE_TOKEN`, if one happens to be set.
// This project has BLOB_STORE_ID but deliberately no BLOB_READ_WRITE_TOKEN
// (a permanent long-lived token is not part of the current Vercel-
// connected Blob model and was never manually created) -- so this module
// intentionally passes NO explicit token to put()/get()/del() at all,
// letting the SDK's own OIDC resolution do its job. Do not add
// `token: process.env.BLOB_READ_WRITE_TOKEN` back in; that would silently
// prefer a token that doesn't exist in this project over the OIDC path
// that does.
//
// content/[action].js is responsible for handling a missing/misconfigured
// store the same way every other *StoreUnavailableError-throwing module in
// this codebase does (a 503, never a silent no-op).

import { put, get, del } from '@vercel/blob'

let testClientFactory = null
export function _setBlobClientForTests(factory) { testClientFactory = factory }
export function _resetBlobClientForTests() { testClientFactory = null }

function getClient() {
  if (testClientFactory) return testClientFactory()
  return { put, get, del }
}

export class BlobStoreUnavailableError extends Error {}

// A fast pre-check, not the authority -- the SDK's own resolveBlobAuth()
// (inside put/get/del below) is what actually decides whether real
// credentials are usable at call time, and its own BlobError is caught and
// re-thrown as BlobStoreUnavailableError either way. This just avoids an
// entirely pointless network round trip when NEITHER auth signal exists at
// all (e.g. a local dev environment with no Blob store connected).
// BLOB_STORE_ID present means the OIDC path is expected to work (Vercel
// injects VERCEL_OIDC_TOKEN automatically at runtime for a connected
// store); BLOB_READ_WRITE_TOKEN present means the legacy token path is
// expected to work. Either is a legitimate "configured" signal.
function hasBlobConfig() {
  return Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN) || testClientFactory !== null
}

// Always writes access: 'private' -- the ONE place that decision is made,
// server-side, never influenced by client input. See content/[action].js's
// header comment for why this replaced the originally-planned client-
// direct-upload flow. No `token` option is passed -- see this file's
// header comment for why that's deliberate under the OIDC auth model.
export async function putBlob(pathname, buffer, { contentType } = {}) {
  if (!hasBlobConfig()) throw new BlobStoreUnavailableError('blob store is not configured (no BLOB_STORE_ID or BLOB_READ_WRITE_TOKEN)')
  try {
    return await getClient().put(pathname, buffer, {
      access: 'private',
      contentType,
      addRandomSuffix: false,
    })
  } catch (err) {
    throw new BlobStoreUnavailableError(`blob write failed: ${err.message}`)
  }
}

export async function getBlob(pathname) {
  if (!hasBlobConfig()) throw new BlobStoreUnavailableError('blob store is not configured (no BLOB_STORE_ID or BLOB_READ_WRITE_TOKEN)')
  try {
    return await getClient().get(pathname, { access: 'private' })
  } catch (err) {
    throw new BlobStoreUnavailableError(`blob read failed: ${err.message}`)
  }
}

export async function deleteBlob(pathname) {
  if (!hasBlobConfig()) throw new BlobStoreUnavailableError('blob store is not configured (no BLOB_STORE_ID or BLOB_READ_WRITE_TOKEN)')
  try {
    return await getClient().del(pathname)
  } catch (err) {
    throw new BlobStoreUnavailableError(`blob delete failed: ${err.message}`)
  }
}
