import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import { AuthProvider } from './auth/AuthProvider'
import App from './App.tsx'
import { initAnalytics } from './utils/analytics'
import { scrubMapAddressBeforeAnalytics } from './utils/mapAddressState'

scrubMapAddressBeforeAnalytics()
initAnalytics()

// Register the auto-update service worker. Workbox precaches the app shell
// and runtime-caches map tiles + GIS responses (see vite.config.ts). No
// prompt — silent updates on the next navigation.
if (import.meta.env.PROD) {
  registerSW({ immediate: true })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
