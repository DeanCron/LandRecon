import { Component, useEffect, useMemo, type ReactNode } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import ReportView from '../components/ReportView'
import { readAnalysisCache } from '../map/analysisCache'
import { REPORT_DISCLAIMER, dataVintages } from '../map/reportCopy'
import { computeLocationGrade } from '../map/scoring'
import { REPORT_SECTIONS, analysisResultsFromCache } from '../map/reportFromCache'
import { loadSavedAnalyses, savedAnalysisState } from '../map/savedAnalyses'
import { gpsTargetFromParams, gpsTargetLabel, locationIdentity } from '../utils/locationTarget'
import { rememberMapAddress, rememberMapGps, resolveMapAddress, resolveMapGps } from '../utils/mapAddressState'
import { lookupGeocode } from '../utils/geocodeCache'
import './MapPage.css'
import './ReportPage.css'

const noop = () => {}

class SectionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed
      ? <p className="report-page-empty" role="alert">This section could not be displayed from the cached data. Re-run the analysis on the map.</p>
      : this.props.children
  }
}

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
  // Never geocode here: an anonymous /report?address=... link must not drive
  // paid TomTom usage. Coordinates come from GPS params or from a geocode the
  // map page already performed for this address.
  const coords = useMemo(
    () => (gpsTarget ? { lat: gpsTarget.lat, lng: gpsTarget.lng } : address ? lookupGeocode(address) : null),
    [gpsTarget, address],
  )
  const analysisResults = useMemo(() => {
    const cached = coords ? readAnalysisCache(coords.lat, coords.lng) : null
    if (!cached) return null
    try {
      const results = analysisResultsFromCache(cached)
      computeLocationGrade(results)
      return results
    } catch {
      return null
    }
  }, [coords])
  const grade = useMemo(() => (analysisResults ? computeLocationGrade(analysisResults) : null), [analysisResults])
  const vintages = useMemo(() => (grade ? dataVintages(grade) : []), [grade])
  const mapState = gpsTarget ? rememberMapGps(gpsTarget) : rememberMapAddress(address)

  useEffect(() => {
    document.body.classList.add('report-print')
    return () => document.body.classList.remove('report-print')
  }, [])

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
  } else if (!analysisResults || !grade) {
    body = (
      <div className="report-page-empty">
        <p>No recent analysis found for this location. Run this address on the map first, then return here to print the report.</p>
        <p><Link to="/map" state={mapState}>Analyze this location on the map</Link></p>
      </div>
    )
  } else {
    body = (
      <>
        {REPORT_SECTIONS.map(({ detail, title }) => (
          <section key={detail} className="report-page-section">
            <h2>{title}</h2>
            <SectionBoundary>
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
            </SectionBoundary>
          </section>
        ))}
        {vintages.length > 0 && (
          <section className="report-page-section report-page-vintages">
            <h2>Data vintages</h2>
            <ul>
              {vintages.map((v) => (
                <li key={v.label}>{v.label}: {v.source} — {v.freshness}</li>
              ))}
            </ul>
          </section>
        )}
        <p className="report-page-disclaimer">{REPORT_DISCLAIMER}</p>
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
