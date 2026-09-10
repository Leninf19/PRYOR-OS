// Phase 4L pilot-readiness local harness -- a minimal, LOCAL-ONLY
// reimplementation of Vercel's own routing (path -> serverless function,
// dynamic [action] segment -> req.query.action) so the REAL, unmodified
// dashboard/api/**/*.js handlers can be exercised by an actual browser
// against fake Redis/Blob/Google infrastructure (see fakeInfra.mjs).
//
// This file contains ZERO application logic of its own -- it only adapts
// Node's raw http.IncomingMessage/ServerResponse into the same req/res
// shape every existing test file already builds by hand (see e.g.
// tests/test_login.js's fakeRes()/req literals), then forwards to the real
// handler. Confirmed against tests/test_google_reconnect_reconciliation.js
// and tests/test_provisioned_tenant_api_reads.js for exact conventions:
// a single `headers.cookie` string, `query.action` populated from the
// dynamic path segment, `res.send()` for google/[action].js's raw-HTML
// callback responses, `res.redirect()` for auth()'s redirect to Google.
//
// No real Upstash, no real Vercel Blob, no real Google, no production data.

import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { installFakeInfra, installFakeGoogleFetch } from './fakeInfra.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST_DIR = path.resolve(__dirname, '../../dashboard/dist')

installFakeInfra()
installFakeGoogleFetch()

// Dynamic-route directories: dashboard/api/<dir>/[action].js, dispatched by
// the path segment AFTER <dir> (Vercel populates req.query.action from this
// exact same path segment in production -- confirmed via every frontend
// fetch('/api/<dir>/<action>') call site, never a ?action= query param).
const ACTION_ROUTES = {
  session: '../../dashboard/api/session/[action].js',
  settings: '../../dashboard/api/settings/[action].js',
  google: '../../dashboard/api/google/[action].js',
  actions: '../../dashboard/api/actions/[action].js',
  content: '../../dashboard/api/content/[action].js',
  notifications: '../../dashboard/api/notifications/[action].js',
  tasks: '../../dashboard/api/tasks/[action].js',
  'tenant-entitlements': '../../dashboard/api/tenant-entitlements/[action].js',
  'tenant-ops': '../../dashboard/api/tenant-ops/[action].js',
}

// Flat (non-dynamic) routes.
const FLAT_ROUTES = {
  '/api/data': '../../dashboard/api/data.js',
  '/api/executive-brief': '../../dashboard/api/executive-brief.js',
  '/api/rewrite': '../../dashboard/api/rewrite.js',
}

const handlerCache = new Map()
async function loadHandler(relPath) {
  if (!handlerCache.has(relPath)) {
    const mod = await import(relPath)
    handlerCache.set(relPath, mod.default)
  }
  return handlerCache.get(relPath)
}

function buildRes(nodeRes) {
  const res = { statusCode: 200, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.setHeader = (name, value) => { res.headers[name] = value; nodeRes.setHeader(name, value); return res }
  res.getHeader = (name) => res.headers[name] ?? nodeRes.getHeader(name)
  res.json = (obj) => {
    if (!res.headers['content-type'] && !res.headers['Content-Type']) nodeRes.setHeader('content-type', 'application/json; charset=utf-8')
    nodeRes.writeHead(res.statusCode)
    nodeRes.end(JSON.stringify(obj))
    return res
  }
  res.send = (bodyStr) => {
    if (!res.headers['content-type'] && !res.headers['Content-Type']) {
      const looksHtml = typeof bodyStr === 'string' && /^\s*</.test(bodyStr)
      nodeRes.setHeader('content-type', looksHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8')
    }
    nodeRes.writeHead(res.statusCode)
    nodeRes.end(bodyStr ?? '')
    return res
  }
  res.end = (bodyStr) => { nodeRes.writeHead(res.statusCode); nodeRes.end(bodyStr ?? ''); return res }
  res.redirect = (code, url) => {
    if (typeof code === 'string') { url = code; code = 302 }
    nodeRes.writeHead(code, { Location: url })
    nodeRes.end()
    return res
  }
  return res
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf-8')
  if (!raw) return {}
  const contentType = req.headers['content-type'] || ''
  if (contentType.includes('application/json')) {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return {}
}

async function serveStatic(pathname, nodeRes) {
  const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
  const safeRel = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  let filePath = path.join(DIST_DIR, safeRel)
  try {
    const data = await readFile(filePath)
    nodeRes.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream' })
    nodeRes.end(data)
    return
  } catch { /* fall through to SPA index.html, mirroring vercel.json's rewrite rule */ }
  const indexData = await readFile(path.join(DIST_DIR, 'index.html'))
  nodeRes.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  nodeRes.end(indexData)
}

const server = http.createServer(async (nodeReq, nodeRes) => {
  const url = new URL(nodeReq.url, 'http://localhost')
  const pathname = url.pathname

  if (!pathname.startsWith('/api/')) {
    return serveStatic(pathname, nodeRes)
  }

  const query = Object.fromEntries(url.searchParams.entries())
  const body = ['POST', 'PUT', 'PATCH'].includes(nodeReq.method) ? await readBody(nodeReq) : {}

  let handlerPath = FLAT_ROUTES[pathname]
  if (!handlerPath) {
    const segments = pathname.slice('/api/'.length).split('/').filter(Boolean)
    const [dir, action] = segments
    if (ACTION_ROUTES[dir]) {
      handlerPath = ACTION_ROUTES[dir]
      query.action = action
    }
  }

  if (!handlerPath) {
    nodeRes.writeHead(404, { 'content-type': 'application/json' })
    nodeRes.end(JSON.stringify({ error: 'no local pilot-harness route for ' + pathname }))
    return
  }

  const req = {
    method: nodeReq.method,
    query,
    body,
    headers: nodeReq.headers, // raw Node headers object -- already lowercased keys, `cookie` forwarded verbatim
    socket: { remoteAddress: nodeReq.socket.remoteAddress },
  }
  const res = buildRes(nodeRes)

  try {
    const handler = await loadHandler(handlerPath)
    await handler(req, res)
  } catch (err) {
    console.error(`[pilot-harness] handler error for ${pathname}:`, err)
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(500, { 'content-type': 'application/json' })
      nodeRes.end(JSON.stringify({ error: 'internal error in local pilot harness', message: err.message }))
    }
  }
})

const PORT = process.env.PILOT_HARNESS_PORT ? Number(process.env.PILOT_HARNESS_PORT) : 4173
server.listen(PORT, () => {
  console.log(`[pilot-harness] listening on http://localhost:${PORT} (dist: ${DIST_DIR})`)
})

export { server }
