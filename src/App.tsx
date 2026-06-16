import { lazy, Suspense, useEffect } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import HomePage from './pages/HomePage'
import MapPageSkeleton from './components/MapPageSkeleton'
import { trackPageView } from './utils/analytics'

const MapPage = lazy(() => import('./pages/MapPage'))
const ComparePage = lazy(() => import('./pages/ComparePage'))

// Fires a GA4 page_view on every React Router navigation. We strip query
// params because address strings can be PII; the path alone (e.g. `/map`)
// is the meaningful dimension. Title is the current document.title which
// pages update via useEffect on mount.
function AnalyticsTracker() {
  const location = useLocation()
  useEffect(() => {
    trackPageView(location.pathname)
  }, [location.pathname])
  return null
}

function App() {
  return (
    <>
      <AnalyticsTracker />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route
          path="/map"
          element={
            <Suspense fallback={<MapPageSkeleton />}>
              <MapPage />
            </Suspense>
          }
        />
        <Route
          path="/compare"
          element={
            <Suspense fallback={null}>
              <ComparePage />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}

export default App
