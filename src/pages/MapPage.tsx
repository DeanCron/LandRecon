import { useEffect, useRef, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './MapPage.css'

function MapPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const address = searchParams.get('address') || ''
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    if (!address) {
      navigate('/')
      return
    }

    if (!mapContainer.current) return

    const abortController = new AbortController()
    const geocodeUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=us`

    fetch(geocodeUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'LandRecon/1.0' },
      signal: abortController.signal,
    })
      .then((res) => res.json())
      .then((data) => {
        if (!data || data.length === 0) {
          setStatus('error')
          setErrorMsg('Address not found. Please try a different address.')
          return
        }

        const lat = parseFloat(data[0].lat)
        const lng = parseFloat(data[0].lon)

        const map = L.map(mapContainer.current!, {
          center: [lat, lng],
          zoom: 14,
          zoomControl: false,
        })

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          maxZoom: 19,
        }).addTo(map)

        L.control.zoom({ position: 'topright' }).addTo(map)

        L.marker([lat, lng]).addTo(map)

        mapRef.current = map
        setStatus('ready')

        // Force Leaflet to recalculate container size
        setTimeout(() => map.invalidateSize(), 0)
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setStatus('error')
        setErrorMsg('Failed to geocode the address.')
      })

    return () => {
      abortController.abort()
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [address, navigate])

  return (
    <div className="map-page">
      <header className="map-header">
        <button className="back-button" onClick={() => navigate('/')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          Back
        </button>
        <div className="header-address" title={address}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
          {address}
        </div>
      </header>

      <div className="map-area">
        <div className="map-container" ref={mapContainer} />
        {status === 'loading' && (
          <div className="map-overlay">
            <div className="spinner" />
            <p>Loading map…</p>
          </div>
        )}
        {status === 'error' && (
          <div className="map-overlay error">
            <p>{errorMsg}</p>
            <button className="retry-button" onClick={() => navigate('/')}>
              Try another address
            </button>
          </div>
        )}
      </div>

      <aside className="layer-panel">
        <h2 className="panel-title">Layers</h2>
        <p className="panel-placeholder">Layer controls coming soon.</p>
      </aside>
    </div>
  )
}

export default MapPage
