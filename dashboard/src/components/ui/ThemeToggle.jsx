import { useTheme } from '../../hooks/useTheme.js'

const OPTIONS = [
  { id: 'light', label: 'Light', icon: (
    <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
      <path d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 9a1 1 0 100 2h1a1 1 0 100-2h-1zM2 9a1 1 0 000 2h1a1 1 0 100-2H2zm2.343-5.657a1 1 0 011.414 0l.707.707A1 1 0 115.05 5.464l-.707-.707a1 1 0 010-1.414zm.707 10.607a1 1 0 00-1.414 1.414l.707.707a1 1 0 001.414-1.414l-.707-.707zM10 16a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1z"/>
    </svg>
  )},
  { id: 'dark', label: 'Dark', icon: (
    <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
      <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z"/>
    </svg>
  )},
  { id: 'system', label: 'Auto', icon: (
    <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
      <path fillRule="evenodd" d="M2 4a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2h-4l1 2H7l1-2H4a2 2 0 01-2-2V4zm2 0h12v8H4V4z" clipRule="evenodd"/>
    </svg>
  )},
]

// Three-way Light/Dark/Auto control. "Auto" follows the OS setting live
// (see useTheme.js); Light/Dark pin it explicitly either way.
export default function ThemeToggle({ compact = false }) {
  const { preference, setTheme } = useTheme()

  return (
    <div className={`inline-flex gap-1 p-1 rounded-xl ${compact ? '' : 'w-fit'}`}
         style={{ background: 'var(--color-surface-2)' }}>
      {OPTIONS.map(o => (
        <button
          key={o.id}
          onClick={() => setTheme(o.id)}
          aria-pressed={preference === o.id}
          title={o.label}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all"
          style={preference === o.id
            ? { background: 'var(--color-surface)', color: 'var(--color-text-1)', boxShadow: 'var(--shadow-sm)' }
            : { color: 'var(--color-text-2)' }}
        >
          {o.icon}
          {!compact && o.label}
        </button>
      ))}
    </div>
  )
}
