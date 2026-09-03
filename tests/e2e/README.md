# Phase 4L local pilot-readiness harness

A local, non-production full-stack harness that serves the REAL, unmodified
`dashboard/api/**/*.js` serverless handlers (plus the built dashboard SPA)
to a real browser, backed by fake in-memory Redis/Blob/Google
infrastructure. Built to let Phase 4L verify Tenant B pilot readiness
end-to-end -- lifecycle transitions, onboarding UI, tenant isolation --
against genuine code paths instead of source-regex assertions alone.

No real Upstash, no real Vercel Blob, no real Google OAuth, no production
data, ever. Every store's real `_setRedisClientForTests()`/
`_setBlobClientForTests()` test seam is wired to one shared fake instance
(see `fakeInfra.mjs`) -- the same seam every Node test file in `tests/`
already uses.

## Usage

```bash
cd dashboard && npm run build   # the harness serves the built dist/
cd ..
node tests/e2e/run.mjs          # seeds fixtures, starts the server on :4173
```

The console output prints every seeded tenant's login email + a ready-to-use
session cookie, plus pre-registered Google OAuth fixtures (authCode + signed
state token) for flows a real browser cannot complete on its own (there is
no real Google to redirect to) -- see `run.mjs`'s comments for how to
complete an OAuth callback via a plain HTTP GET using those.

```bash
node tests/e2e/verifyAbIsolation.mjs        # 10 A/B isolation checks against the live server
bash tests/e2e/verifyWorkflowValidation.sh  # tenant-lifecycle.yml's input-validation logic, exercised locally
```

## Files

- `fakeInfra.mjs` -- wires every `_lib` Redis-backed store to one shared
  in-memory client (faithfully emulating both CAS Lua scripts this
  codebase uses), wires `blobStore.js` to one shared in-memory Blob client,
  and installs a `globalThis.fetch` router that fakes Google's OAuth token
  endpoint + My Business Account Management/Business Information APIs.
- `seedFixtures.mjs` -- seeds a tenant at any lifecycle stage
  (onboarding/locations_approved/provisioning_failed/provisioned/
  initial_sync/initial_sync_failed/active/suspended) using only the real,
  reviewed domain functions (`tenantConfigStore.js`, `userStore.js`,
  `credentialStore.js`) -- never a raw Redis write.
- `server.mjs` -- a minimal local reimplementation of Vercel's own routing
  (path -> function, dynamic `[action]` segment -> `req.query.action`) plus
  static serving of `dashboard/dist`, so a browser sees one single origin
  exactly like production.
- `run.mjs` -- entry point: seeds a full roster of synthetic tenants and
  starts the server.
- `verifyAbIsolation.mjs` -- drives the live server over real HTTP as two
  simultaneously-logged-in tenants and proves the 10 named A/B isolation
  invariants from the Phase 4L spec.
- `verifyWorkflowValidation.sh` -- the tenant-lifecycle workflow's own
  "Validate inputs" bash logic, copied verbatim, exercised against forged
  tenant ids/confirmations/shell-injection attempts, entirely locally
  (never dispatches the real GitHub Actions workflow).

Every tenant id used anywhere in this directory is prefixed `t_pilot-test-`
-- unmistakably synthetic, never a real customer identifier.
