import { useState } from 'react'
import Badge from './Badge.jsx'
import { isValidEmailFormat } from '../../utils/emailValidation.js'

// Small reusable add/remove chip-input for a list of email addresses
// (Phase 8, Milestone 8.4) -- first used for Restaurant Contacts' CC
// recipients, written generically enough to reuse for a future
// Notification Rules editor or similar.
//
// `emails`: string[]. `onChange(nextEmails)`: called with the full updated
// array on every add/remove. Each entered value is validated on submit
// (Enter or the Add button) -- an invalid entry is never added silently;
// it stays in the input with an inline error instead.
export default function EmailFieldList({ emails, onChange, label, placeholder = 'name@example.com' }) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(null)

  function addDraft() {
    const value = draft.trim()
    if (!value) return
    if (!isValidEmailFormat(value)) {
      setError(`"${value}" is not a valid email address.`)
      return
    }
    if (emails.some(e => e.toLowerCase() === value.toLowerCase())) {
      setError(`${value} is already in the list.`)
      return
    }
    onChange([...emails, value])
    setDraft('')
    setError(null)
  }

  function removeAt(index) {
    onChange(emails.filter((_, i) => i !== index))
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      addDraft()
    }
  }

  return (
    <div>
      {label && (
        <label className="text-[10px] font-bold uppercase tracking-wider mb-1 block" style={{ color: 'var(--color-text-3)' }}>
          {label}
        </label>
      )}
      {emails.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {emails.map((email, i) => (
            <Badge key={email} variant="neutral" className="inline-flex items-center gap-1.5">
              {email}
              <button
                type="button"
                onClick={() => removeAt(i)}
                aria-label={`Remove ${email}`}
                className="hover:opacity-70"
                style={{ color: 'var(--color-text-3)' }}
              >
                ✕
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          type="email"
          value={draft}
          onChange={e => { setDraft(e.target.value); setError(null) }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label={label || 'Add email address'}
          className="flex-1 text-xs px-2.5 py-2 rounded-lg border focus:outline-none"
          style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}
        />
        <button
          type="button"
          onClick={addDraft}
          className="text-xs font-semibold px-3 py-2 rounded-lg border transition-colors"
          style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }}
        >
          Add
        </button>
      </div>
      {error && <p className="text-[11px] mt-1" style={{ color: 'var(--color-danger)' }}>{error}</p>}
    </div>
  )
}
