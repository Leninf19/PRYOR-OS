import { Link } from 'react-router-dom'

// Design System Specification v1.0, Phase 7 -- the "Locations / Northville /
// Performance" pattern for nested workspace routes. Top-level pages (Today,
// Reviews, Actions, ...) show just their page title and never mount this at
// all. Not wired into Layout.jsx or any page yet (Execution Master Plan
// M2.2) -- the Location Workspace (M7) is the first real consumer.
//
// path: [{ label, to? }] -- the last entry is always the current page and
// is never a link, regardless of whether it has a `to`.
export default function Breadcrumb({ path = [] }) {
  if (path.length === 0) return null

  return (
    <nav aria-label="Breadcrumb" className="mb-2">
      <ol className="flex items-center gap-1.5 text-xs flex-wrap">
        {path.map((crumb, i) => {
          const isLast = i === path.length - 1
          return (
            <li key={i} className="flex items-center gap-1.5">
              {crumb.to && !isLast ? (
                <Link to={crumb.to} className="hover:underline" style={{ color: 'var(--color-text-2)' }}>
                  {crumb.label}
                </Link>
              ) : (
                <span style={{ color: isLast ? 'var(--color-text-1)' : 'var(--color-text-2)' }}
                      aria-current={isLast ? 'page' : undefined}>
                  {crumb.label}
                </span>
              )}
              {!isLast && <span aria-hidden="true" style={{ color: 'var(--color-text-3)' }}>/</span>}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
