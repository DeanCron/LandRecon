import { useEffect, useRef, useState, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './MapPage.css'

const NOISE_TILE_URL = '/tiles/airport-noise/{z}/{x}/{y}.png'

const SUPERFUND_API =
  'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/FAC_Superfund_Site_Boundaries_EPA_Public/FeatureServer/0/query'

const SUPERFUND_FIELDS = [
  'SITE_NAME', 'EPA_ID', 'NPL_STATUS_CODE', 'CITY_NAME',
  'STATE_CODE', 'SITE_FEATURE_TYPE', 'URL_ALIAS_TXT',
].join(',')

const LEGEND_STOPS = [
  { db: 45, color: 'rgb(34, 139, 34)' },
  { db: 50, color: 'rgb(124, 179, 66)' },
  { db: 55, color: 'rgb(255, 235, 59)' },
  { db: 60, color: 'rgb(255, 152, 0)' },
  { db: 65, color: 'rgb(244, 67, 54)' },
  { db: 70, color: 'rgb(136, 14, 79)' },
]

const SUPERFUND_STYLE: L.PathOptions = {
  color: '#d500f9',
  weight: 3,
  opacity: 1,
  fillColor: '#aa00ff',
  fillOpacity: 0.25,
  dashArray: '6, 4',
}

const SUPERFUND_HOVER_STYLE: L.PathOptions = {
  weight: 5,
  fillOpacity: 0.45,
  color: '#ff6eff',
}

async function fetchSuperfundFeatures(bounds: L.LatLngBounds): Promise<GeoJSON.FeatureCollection> {
  const bbox = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`
  const params = new URLSearchParams({
    where: '1=1',
    outFields: SUPERFUND_FIELDS,
    geometry: bbox,
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: '500',
  })
  const res = await fetch(`${SUPERFUND_API}?${params}`)
  return res.json()
}

const NPL_STATUS_INFO: Record<string, { label: string; desc: string }> = {
  F: { label: 'Final', desc: 'Officially listed on the NPL as a priority cleanup site' },
  P: { label: 'Proposed', desc: 'Proposed for NPL listing; under public comment review' },
  D: { label: 'Deleted', desc: 'Removed from NPL after cleanup goals were met' },
}

function superfundPopup(props: Record<string, string | null>): string {
  const name = props.SITE_NAME || 'Unknown Site'
  const city = [props.CITY_NAME, props.STATE_CODE].filter(Boolean).join(', ')
  const status = props.NPL_STATUS_CODE || ''
  const npl = NPL_STATUS_INFO[status]
  const epaId = props.EPA_ID || ''
  const url = props.URL_ALIAS_TXT
  const link = url
    ? `<a href="${url}" target="_blank" rel="noopener">View EPA Site Profile →</a>`
    : ''
  const statusHtml = npl
    ? `<div class="popup-row">
         <span class="popup-label">NPL Status</span>
         <span class="popup-badge">${npl.label}</span>
       </div>
       <div class="popup-npl-desc">${npl.desc}</div>`
    : status
      ? `<div class="popup-row"><span class="popup-label">NPL Status</span><span class="popup-badge">${status}</span></div>`
      : ''
  return `
    <div class="superfund-popup">
      <div class="popup-header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7b1fa2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <strong>${name}</strong>
      </div>
      <div class="popup-body">
        ${city ? `<div class="popup-row"><span class="popup-label">Location</span><span>${city}</span></div>` : ''}
        ${epaId ? `<div class="popup-row"><span class="popup-label">EPA ID</span><span class="popup-mono">${epaId}</span></div>` : ''}
        ${statusHtml}
      </div>
      ${link ? `<div class="popup-footer">${link}</div>` : ''}
    </div>
  `
}

function MapPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const address = searchParams.get('address') || ''
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const noiseLayerRef = useRef<L.TileLayer | null>(null)
  const superfundLayerRef = useRef<L.GeoJSON | null>(null)
  const superfundLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [noiseVisible, setNoiseVisible] = useState(false)
  const [superfundVisible, setSuperfundVisible] = useState(false)
  const [superfundLoading, setSuperfundLoading] = useState(false)

  const loadSuperfundData = useCallback(async (map: L.Map, layer: L.GeoJSON) => {
    const bounds = map.getBounds()

    // Skip if we already loaded data covering the current view
    const loaded = superfundLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) return

    setSuperfundLoading(true)
    try {
      // Fetch a padded area so small pans don't trigger new requests
      const padded = bounds.pad(0.5)
      const geojson = await fetchSuperfundFeatures(padded)
      layer.clearLayers()
      layer.addData(geojson)
      superfundLoadedBoundsRef.current = padded
    } catch (err) {
      console.error('Failed to load Superfund data:', err)
    } finally {
      setSuperfundLoading(false)
    }
  }, [])

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

        // Create noise layer (not added to map until toggled on)
        noiseLayerRef.current = L.tileLayer(NOISE_TILE_URL, {
          opacity: 0.7,
          maxZoom: 19,
          attribution: 'Noise: FAA/BTS Aviation Noise 2020',
          errorTileUrl: '',
        })

        // Create Superfund layer (not added to map until toggled on)
        superfundLayerRef.current = L.geoJSON(undefined, {
          style: () => SUPERFUND_STYLE,
          onEachFeature: (_feature, layer) => {
            const props = (_feature as GeoJSON.Feature).properties || {}
            layer.bindPopup(superfundPopup(props), { maxWidth: 280 })
            layer.on('mouseover', (e) => {
              (e.target as L.Path).setStyle(SUPERFUND_HOVER_STYLE)
            })
            layer.on('mouseout', (e) => {
              superfundLayerRef.current?.resetStyle(e.target as L.Path)
            })
          },
        })

        mapRef.current = map
        setStatus('ready')

        setTimeout(() => map.invalidateSize(), 0)
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setStatus('error')
        setErrorMsg('Failed to geocode the address.')
      })

    return () => {
      abortController.abort()
      noiseLayerRef.current = null
      superfundLayerRef.current = null
      superfundLoadedBoundsRef.current = null
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [address, navigate])

  const toggleNoise = () => {
    const map = mapRef.current
    const layer = noiseLayerRef.current
    if (!map || !layer) return

    if (noiseVisible) {
      map.removeLayer(layer)
    } else {
      layer.addTo(map)
    }
    setNoiseVisible(!noiseVisible)
  }

  const toggleSuperfund = () => {
    const map = mapRef.current
    const layer = superfundLayerRef.current
    if (!map || !layer) return

    if (superfundVisible) {
      map.removeLayer(layer)
      map.off('moveend', handleSuperfundMove)
    } else {
      layer.addTo(map)
      superfundLoadedBoundsRef.current = null
      loadSuperfundData(map, layer)
      map.on('moveend', handleSuperfundMove)
    }
    setSuperfundVisible(!superfundVisible)
  }

  const handleSuperfundMove = useCallback(() => {
    const map = mapRef.current
    const layer = superfundLayerRef.current
    if (map && layer) {
      loadSuperfundData(map, layer)
    }
  }, [loadSuperfundData])

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

        <label className="layer-toggle">
          <input
            type="checkbox"
            checked={noiseVisible}
            onChange={toggleNoise}
            disabled={status !== 'ready'}
          />
          <span className="layer-label">Airport Noise</span>
        </label>
        {noiseVisible && (
          <div className="noise-legend">
            <div className="legend-bar">
              {LEGEND_STOPS.map((stop, i) => (
                <div
                  key={i}
                  className="legend-segment"
                  style={{ background: stop.color }}
                />
              ))}
            </div>
            <div className="legend-labels">
              <span>{LEGEND_STOPS[0].db} dB</span>
              <span>{LEGEND_STOPS[LEGEND_STOPS.length - 1].db} dB</span>
            </div>
          </div>
        )}

        <label className="layer-toggle">
          <input
            type="checkbox"
            checked={superfundVisible}
            onChange={toggleSuperfund}
            disabled={status !== 'ready'}
          />
          <span className="layer-label">
            Superfund Sites
            {superfundLoading && <span className="layer-loading"> ⏳</span>}
          </span>
        </label>
        {superfundVisible && (
          <div className="superfund-legend">
            <div className="legend-swatch-row">
              <span className="legend-swatch" />
              <span>NPL Site Boundary</span>
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}

export default MapPage
