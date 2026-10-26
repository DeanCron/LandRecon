import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import ReportView from '../components/ReportView'
import { readAnalysisCache } from '../map/analysisCache'
import { computeLocationGrade } from '../map/scoring'
import { REPORT_SECTIONS, analysisResultsFromCache } from '../map/reportFromCache'
import { loadSavedAnalyses, savedAnalysisState } from '../map/savedAnalyses'
import { gpsTargetFromParams, gpsTargetLabel, locationIdentity } from '../utils/locationTarget'
import { rememberMapAddress, rememberMapGps, resolveMapAddress, resolveMapGps } from '../utils/mapAddressState'
import { resolveLocation } from '../utils/resolveLocation'
import './MapPage.css'
import './ReportPage.css'

const TOMTOM_API_KEY = import.meta.env.VITE_TOMTOM_API_KEY || ''
const noop = () => {}

type Resolution = { key: string; coords: { lat: number; lng: number } | null; error: string }

export default function ReportPage() {
  const routeLocation = useLocation()
  const [searchParams] = useSearchParams()
  const gpsTarget = useMemo(
    () => resolveMapGps(routeLocation.state) ?? gpsTargetFromParams(searchParams),
    [routeLocation.state, searchParams],
  )
  const address = gpsTarget
    ? gpsTargetLabel(gpsTarget)
    : resolveMapAddress(routeLocation.state) || searchParams.get('address')?.trim() || ''
  const locationKey = address || gpsTarget ? locationIdentity(address, gpsTarget) : ''
  const [resolution, setResolution] = useState<Resolution | null>(null)

  useEffect(() => {
    if (!locationKey || gpsTarget) return
    const controller = new AbortController()
    resolveLocation(address, null, TOMTOM_API_KEY, controller.signal)
      .then((coords) => setResolution({ key: locationKey, coords, error: '' }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setResolution({ key: locationKey, coords: null, error: err instanceof Error ? err.message : 'Address lookup failed.' })
      })
    return () => controller.abort()
  }, [address, gpsTarget, locationKey])

  const resolvedCoords = resolution?.key === locationKey ? resolution.coords : null
  const coords = useMemo(
    () => (gpsTarget ? { lat: gpsTarget.lat, lng: gpsTarget.lng } : resolvedCoords),
    [gpsTarget, resolvedCoords],
  )
  const lookupError = !gpsTarget && resolution?.key === locationKey ? resolution.error : ''
  const lookingUp = !!locationKey && !coords && !lookupError
  const cached = useMemo(() => (coords ? readAnalysisCache(coords.lat, coords.lng) : null), [coords])
  const analysisResults = useMemo(() => (cached ? analysisResultsFromCache(cached) : null), [cached])
  const grade = useMemo(() => (analysisResults ? computeLocationGrade(analysisResults) : null), [analysisResults])
  const mapState = gpsTarget ? rememberMapGps(gpsTarget) : rememberMapAddress(address)

  useEffect(() => {
    const previous = document.title
    document.title = address ? `Recon Report — ${address}` : 'Recon Report — LandRecon'
    return () => { document.title = previous }
  }, [address])

  let body
  if (!locationKey) {
    const saved = loadSavedAnalyses().filter((s) => !s.locationError)
    body = (
      <div className="report-page-empty">
        <p>Choose a property to see its printable report.</p>
        {saved.length > 0 && (
          <ul className="report-page-saved">
            {saved.map((s) => (
              <li key={`${s.address}|${s.gps?.lat ?? ''},${s.gps?.lng ?? ''}`}>
                <Link to="/report" state={savedAnalysisState(s)}>{s.address}</Link>
              </li>
            ))}
          </ul>
        )}
        <p><Link to="/">Search for an address</Link></p>
      </div>
    )
  } else if (lookingUp) {
    body = <p className="report-page-empty" role="status">Looking up address…</p>
  } else if (lookupError) {
    body = <p className="report-page-empty" role="alert">{lookupError}</p>
  } else if (!analysisResults || !grade) {
    body = (
      <div className="report-page-empty">
        <p>No recent analysis found for this location. Run the analysis on the map first, then return here to print the report.</p>
        <p><Link to="/map" state={mapState}>Analyze this location on the map</Link></p>
      </div>
    )
  } else {
    body = (
      <>
        {REPORT_SECTIONS.map(({ detail, title }) => (
          <section key={detail} className="report-page-section">
            <h2>{title}</h2>
            <ReportView
              analysisDetail={detail}
              analysisResults={analysisResults}
              address={address}
              workAddress={null}
              workAddressEditing={false}
              workAddressDraft=""
              workAddressSaving={false}
              workAddressInputError={null}
              commuteLoading={false}
              commuteResult={null}
              setWorkAddressDraft={noop}
              setWorkAddressInputError={noop}
              setWorkAddressEditing={noop}
              submitWorkAddress={noop}
              removeWorkAddress={noop}
              retryCostco={noop}
            />
          </section>
        ))}
        <p className="report-page-disclaimer">
          Informational only. This report is not a verified property boundary and is not a substitute for a
          professional inspection, survey, or an official FEMA flood determination. Data is drawn from public
          sources and may be out of date.
        </p>
      </>
    )
  }

  return (
    <main className="report-page">
      <header className="report-page-header">
        <h1>LandRecon — Recon Report</h1>
        {address && <p className="report-page-address">{address}</p>}
        {grade && <p className="report-page-grade">Overall grade: {grade.letter} ({Math.round(grade.pct * 100)}%)</p>}
        <p className="report-page-date">{new Date().toLocaleDateString()}</p>
        <div className="report-page-actions">
          <button type="button" className="report-page-print" onClick={() => window.print()} disabled={!analysisResults}>Print</button>
          {locationKey && <Link to="/map" state={mapState}>Open on map</Link>}
          <Link to="/">Home</Link>
        </div>
      </header>
      {body}
    </main>
  )
}
