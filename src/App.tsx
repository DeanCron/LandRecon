import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useSearchParams } from 'react-router-dom'
import HomePage from './pages/HomePage'

const MapPage = lazy(() => import('./pages/MapPage'))

function KeyedMapPage() {
  const [searchParams] = useSearchParams()
  const address = searchParams.get('address') || ''
  return <MapPage key={address} />
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route
        path="/map"
        element={
          <Suspense fallback={<div style={{ color: '#fff', padding: '2rem' }}>Loading map…</div>}>
            <KeyedMapPage />
          </Suspense>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
