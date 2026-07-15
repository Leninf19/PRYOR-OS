// Minimal cookie helpers -- this project has no cookie/session middleware
// anywhere (Vercel Node functions get raw req/res), and pulling in a
// dependency for two small cookie operations isn't worth it.

export function parseCookies(req) {
  const header = req.headers.cookie
  if (!header) return {}
  return Object.fromEntries(
    header.split(';').map(p => {
      const idx = p.indexOf('=')
      if (idx === -1) return [p.trim(), '']
      return [p.slice(0, idx).trim(), decodeURIComponent(p.slice(idx + 1).trim())]
    })
  )
}

// Appends a Set-Cookie header without clobbering any already set on `res`.
export function appendSetCookie(res, cookieString) {
  const existing = res.getHeader('Set-Cookie')
  if (!existing) {
    res.setHeader('Set-Cookie', cookieString)
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieString])
  } else {
    res.setHeader('Set-Cookie', [existing, cookieString])
  }
}

export function setCookie(res, name, value, { maxAgeSeconds } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']
  if (maxAgeSeconds != null) parts.push(`Max-Age=${maxAgeSeconds}`)
  appendSetCookie(res, parts.join('; '))
}

export function clearCookie(res, name) {
  appendSetCookie(res, `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`)
}
