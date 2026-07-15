import Button from './Button.jsx'

// Shared "couldn't load this" card -- same layout/spacing as EmptyState so
// the two read as a matched pair, just with a danger accent and an optional
// retry action (pass a react-query `refetch` for onRetry).
export default function ErrorState({ title = "Couldn't load this", body, onRetry }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
           style={{ background: 'var(--color-danger-bg, rgba(220,38,38,0.08))' }}>
        <span className="text-2xl">⚠️</span>
      </div>
      <p className="font-semibold text-sm mb-1" style={{ color: 'var(--color-text-1)' }}>{title}</p>
      <p className="text-sm max-w-xs" style={{ color: 'var(--color-text-2)' }}>
        {body || 'Something went wrong loading this data. Try again in a moment.'}
      </p>
      {onRetry && (
        <div className="mt-4">
          <Button variant="secondary" onClick={onRetry}>Try again</Button>
        </div>
      )}
    </div>
  )
}
