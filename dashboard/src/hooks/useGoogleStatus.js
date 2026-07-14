import { useState, useEffect } from 'react'

// Google Business Profile connection status -- shared by Settings (setup
// flow), Alerts (disconnected warning), and ScraperStatus/Data Health
// (connection signal alongside pipeline freshness).
export function useGoogleStatus() {
  const [status, setStatus] = useState({ loading: true })
  useEffect(() => {
    fetch('/api/google/status')
      .then(r => r.json())
      .then(d => setStatus({ loading: false, ...d }))
      .catch(() => setStatus({ loading: false, connected: false, state: 'error' }))
  }, [])
  return status
}
