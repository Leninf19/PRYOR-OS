export default function Settings() {
  const PLANNED = [
    { title: 'Notification Preferences',  desc: 'Choose which alerts to receive and how often.' },
    { title: 'Alert Thresholds',          desc: 'Set the rating drop or backlog size that triggers an alert.' },
    { title: 'Scraper Schedule',          desc: 'Configure how often locations are scraped.' },
    { title: 'Team Members',              desc: 'Add managers and control access per location.' },
    { title: 'Export Settings',           desc: 'Default format and delivery for executive reports.' },
    { title: 'AI Configuration',          desc: 'Manage the ANTHROPIC_API_KEY and AI feature toggles.' },
  ]

  return (
    <div className="space-y-6 max-w-[720px]">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Settings</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Configuration for Future Insights
        </p>
      </div>

      <div className="rounded-2xl border p-6"
           style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
        <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
             style={{ background: 'var(--color-surface-2)' }}>
          <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor"
               style={{ color: 'var(--color-text-3)' }}>
            <path d="M5 4a1 1 0 00-2 0v7.268a2 2 0 000 3.464V16a1 1 0 102 0v-1.268a2 2 0 000-3.464V4zM11 4a1 1 0 10-2 0v1.268a2 2 0 000 3.464V16a1 1 0 102 0V8.732a2 2 0 000-3.464V4zM16 3a1 1 0 011 1v7.268a2 2 0 010 3.464V16a1 1 0 11-2 0v-1.268a2 2 0 010-3.464V4a1 1 0 011-1z"/>
          </svg>
        </div>
        <p className="text-base font-bold mb-1" style={{ color: 'var(--color-text-1)' }}>
          Settings coming soon
        </p>
        <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-2)', lineHeight: 1.7 }}>
          Dashboard configuration will be available here. For now, pipeline settings
          live in the GitHub Actions workflow and scraper configuration files.
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-[10px] font-bold uppercase tracking-widest"
           style={{ color: 'var(--color-text-3)' }}>
          Planned settings
        </p>
        <div className="rounded-2xl border overflow-hidden"
             style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
          {PLANNED.map((item, i) => (
            <div key={i} className="px-5 py-4 border-b last:border-0 flex items-start gap-4"
                 style={{ borderColor: 'var(--color-border)' }}>
              <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0"
                   style={{ background: 'var(--color-border)' }} />
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--color-text-2)' }}>{item.title}</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
