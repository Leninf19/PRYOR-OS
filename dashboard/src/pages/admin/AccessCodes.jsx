import { useEffect, useState } from 'react'

// Multi-Tenant Phase 4Q.1 -- platform-admin Access Codes page.
// GET/POST /api/admin?action=... (isSuperAdmin-only server-side). The raw
// code is shown exactly once, right after creation, in a dismissible
// banner -- never persisted client-side (no localStorage, no re-fetch ever
// returns it) and never shown again once this component unmounts/re-fetches.
export default function AccessCodes() {
  const [codes, setCodes] = useState(null)
  const [error, setError] = useState(null)
  const [justCreated, setJustCreated] = useState(null) // { rawCode, code }
  const [form, setForm] = useState({
    prefix: '', plan: 'core', discountPercent: '', discountFixedCents: '', trialDays: '',
    paymentRequired: true, expiresAt: '', maxRedemptions: 1, allowedEmail: '', allowedEmailDomain: '', clientLabel: '',
  })
  const [creating, setCreating] = useState(false)

  async function refresh() {
    setError(null)
    try {
      const res = await fetch('/api/admin?action=list-access-codes')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.message || 'Could not load access codes.')
        return
      }
      setCodes(data.codes)
    } catch {
      setError('Could not reach the server.')
    }
  }

  useEffect(() => { refresh() }, [])

  function setField(field) {
    return e => setForm(f => ({ ...f, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  }

  async function handleCreate(e) {
    e.preventDefault()
    setError(null)
    setCreating(true)
    try {
      const payload = {
        prefix: form.prefix.trim().toUpperCase(),
        plan: form.plan,
        discountPercent: form.discountPercent ? Number(form.discountPercent) : null,
        discountFixedCents: form.discountFixedCents ? Number(form.discountFixedCents) : null,
        trialDays: form.trialDays ? Number(form.trialDays) : null,
        paymentRequired: form.paymentRequired,
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
        maxRedemptions: Number(form.maxRedemptions) || 1,
        allowedEmail: form.allowedEmail.trim() || null,
        allowedEmailDomain: form.allowedEmailDomain.trim() || null,
        clientLabel: form.clientLabel.trim() || null,
      }
      const res = await fetch('/api/admin?action=create-access-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.message || 'Could not create access code.')
        return
      }
      setJustCreated(data)
      setForm(f => ({ ...f, prefix: '', allowedEmail: '', allowedEmailDomain: '', clientLabel: '' }))
      await refresh()
    } catch {
      setError('Could not reach the server.')
    } finally {
      setCreating(false)
    }
  }

  async function handleRevoke(codeHash) {
    setError(null)
    try {
      const res = await fetch('/api/admin?action=revoke-access-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ codeHash }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.message || 'Could not revoke access code.')
        return
      }
      await refresh()
    } catch {
      setError('Could not reach the server.')
    }
  }

  return (
    <div className="min-h-screen p-8" style={{ background: 'var(--color-bg)' }}>
      <div className="max-w-4xl mx-auto space-y-8">
        <h1 className="font-serif text-2xl" style={{ color: 'var(--color-text-1)' }}>Access Codes</h1>

        {error && (
          <div className="rounded-lg border px-3.5 py-2.5 text-xs font-medium"
               style={{ background: 'var(--color-danger-bg)', borderColor: 'var(--color-danger-border)', color: 'var(--color-danger)' }}>
            {error}
          </div>
        )}

        {justCreated && (
          <div className="rounded-lg border px-4 py-3 text-sm"
               style={{ background: 'var(--color-accent-lt)', borderColor: 'var(--color-accent)', color: 'var(--color-text-1)' }}>
            <div className="font-semibold mb-1">Code created — copy it now, it will not be shown again:</div>
            <code className="font-mono text-base tracking-wide">{justCreated.rawCode}</code>
            <button type="button" onClick={() => setJustCreated(null)} className="block text-xs mt-2 underline" style={{ color: 'var(--color-text-2)' }}>Dismiss</button>
          </div>
        )}

        <form onSubmit={handleCreate} className="rounded-xl border p-5 grid sm:grid-cols-2 gap-4"
              style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
          <label className="text-xs font-semibold" style={{ color: 'var(--color-text-2)' }}>
            Prefix
            <input required value={form.prefix} onChange={setField('prefix')} placeholder="LTA-ENT"
                   className="w-full mt-1 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
          </label>
          <label className="text-xs font-semibold" style={{ color: 'var(--color-text-2)' }}>
            Plan
            <select value={form.plan} onChange={setField('plan')}
                    className="w-full mt-1 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }}>
              <option value="core">Core</option>
              <option value="growth">Growth</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </label>
          <label className="text-xs font-semibold" style={{ color: 'var(--color-text-2)' }}>
            Discount % (optional)
            <input type="number" min="0" max="100" value={form.discountPercent} onChange={setField('discountPercent')}
                   className="w-full mt-1 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
          </label>
          <label className="text-xs font-semibold" style={{ color: 'var(--color-text-2)' }}>
            Fixed discount, cents (optional)
            <input type="number" min="0" value={form.discountFixedCents} onChange={setField('discountFixedCents')}
                   className="w-full mt-1 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
          </label>
          <label className="text-xs font-semibold" style={{ color: 'var(--color-text-2)' }}>
            Trial days (optional)
            <input type="number" min="0" value={form.trialDays} onChange={setField('trialDays')}
                   className="w-full mt-1 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
          </label>
          <label className="text-xs font-semibold flex items-center gap-2 mt-5" style={{ color: 'var(--color-text-2)' }}>
            <input type="checkbox" checked={form.paymentRequired} onChange={setField('paymentRequired')} />
            Payment required
          </label>
          <label className="text-xs font-semibold" style={{ color: 'var(--color-text-2)' }}>
            Expires (optional)
            <input type="date" value={form.expiresAt} onChange={setField('expiresAt')}
                   className="w-full mt-1 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
          </label>
          <label className="text-xs font-semibold" style={{ color: 'var(--color-text-2)' }}>
            Max redemptions
            <input type="number" min="1" value={form.maxRedemptions} onChange={setField('maxRedemptions')}
                   className="w-full mt-1 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
          </label>
          <label className="text-xs font-semibold" style={{ color: 'var(--color-text-2)' }}>
            Restrict to email (optional)
            <input type="email" value={form.allowedEmail} onChange={setField('allowedEmail')}
                   className="w-full mt-1 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
          </label>
          <label className="text-xs font-semibold" style={{ color: 'var(--color-text-2)' }}>
            Restrict to domain (optional)
            <input value={form.allowedEmailDomain} onChange={setField('allowedEmailDomain')} placeholder="example.com"
                   className="w-full mt-1 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
          </label>
          <label className="text-xs font-semibold sm:col-span-2" style={{ color: 'var(--color-text-2)' }}>
            Client / company label (optional, admin display only)
            <input value={form.clientLabel} onChange={setField('clientLabel')}
                   className="w-full mt-1 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
          </label>
          <button type="submit" disabled={creating}
                  className="sm:col-span-2 rounded-lg py-2.5 text-sm font-semibold"
                  style={{ background: 'var(--color-text-1)', color: 'var(--color-bg)', opacity: creating ? 0.7 : 1 }}>
            {creating ? 'Creating…' : 'Create code'}
          </button>
        </form>

        <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--color-border)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--color-surface-2)' }}>
                {['Prefix', 'Plan', 'Client', 'Redemptions', 'Status', 'Redeemed by', ''].map(h => (
                  <th key={h} className="text-left px-4 py-2 text-xs font-semibold" style={{ color: 'var(--color-text-2)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(codes ?? []).map(c => (
                <tr key={c.codeHash} className="border-t" style={{ borderColor: 'var(--color-border)' }}>
                  <td className="px-4 py-2" style={{ color: 'var(--color-text-1)' }}>{c.prefix}</td>
                  <td className="px-4 py-2" style={{ color: 'var(--color-text-1)' }}>{c.plan}</td>
                  <td className="px-4 py-2" style={{ color: 'var(--color-text-2)' }}>{c.clientLabel || '—'}</td>
                  <td className="px-4 py-2" style={{ color: 'var(--color-text-1)' }}>{c.redemptionCount} / {c.maxRedemptions}</td>
                  <td className="px-4 py-2" style={{ color: 'var(--color-text-1)' }}>{c.status}</td>
                  <td className="px-4 py-2" style={{ color: 'var(--color-text-2)' }}>
                    {(c.redemptions || []).map(r => r.tenantId).join(', ') || '—'}
                  </td>
                  <td className="px-4 py-2">
                    {c.status === 'active' && (
                      <button type="button" onClick={() => handleRevoke(c.codeHash)} className="text-xs font-semibold" style={{ color: 'var(--color-danger)' }}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
