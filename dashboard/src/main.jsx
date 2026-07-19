import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from './components/ui/Toast.jsx'
import AuthGate from './components/AuthGate.jsx'
import { applyInitialTheme } from './hooks/useTheme.js'
import App from './App.jsx'
import './index.css'

// Set data-theme before the first paint so there's no flash of the wrong
// theme while React boots.
applyInitialTheme()

const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <AuthGate>
            <App />
          </AuthGate>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
)
