import { useState, useEffect, useRef, useMemo, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import logo from '../assets/landrecon-logo.webp'
import {
  clearRecentSearches,
  loadRecentSearches,
  loadSavedAnalysisSnippets,
  pushRecentSearch,
  removeRecentSearch,
  removeSavedAnalysisSnippet,
  type RecentSearch,
  type SavedAnalysisSnippet,
} from '../utils/recentSearches'
import { trackEvent } from '../utils/analytics'
import './HomePage.css'

declare const __BUILD_VERSION__: string

// Debug logging — enable in console: localStorage.setItem('LR_DEBUG','1'); location.reload()
// Mirrors MapPage's pattern so flipping the flag once instruments both pages.
const LR_DEBUG = typeof localStorage !== 'undefined' && localStorage.getItem('LR_DEBUG') === '1'
function dbg(tag: string, ...args: unknown[]) { if (LR_DEBUG) console.debug(`[LR:${tag}]`, ...args) }

const TOMTOM_API_KEY = import.meta.env.VITE_TOMTOM_API_KEY || ''

interface TomTomResult {
  id: string
  type: string
  address: {
    streetNumber?: string
    streetName?: string
    municipality?: string
    countrySubdivision?: string
    postalCode?: string
    freeformAddress?: string
  }
}

interface Suggestion {
  id: string
  display: string
  raw: TomTomResult
}

function formatTomTomResult(r: TomTomResult): string {
  const a = r.address
  if (!a) return ''
  const street = [a.streetNumber, a.streetName].filter(Boolean).join(' ')
  const parts = [street, a.municipality, a.countrySubdivision].filter(Boolean)
  if (a.postalCode) parts.push(a.postalCode)
  return parts.join(', ') || a.freeformAddress || ''
}

function HomePage() {
  const [address, setAddress] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [showAbout, setShowAbout] = useState(false)
  const [recent, setRecent] = useState<RecentSearch[]>(() => loadRecentSearches())
  const [savedSnippets, setSavedSnippets] = useState<SavedAnalysisSnippet[]>(() => loadSavedAnalysisSnippets())
  const [locating, setLocating] = useState(false)
  const [locateError, setLocateError] = useState<string | null>(null)
  const [recentOpen, setRecentOpen] = useState(false)
  const navigate = useNavigate()

  const gradeByAddress = useMemo(() => {
    const m = new Map<string, { grade: string; gradeColor: string }>()
    for (const s of savedSnippets) {
      m.set(s.address.toLowerCase(), { grade: s.grade, gradeColor: s.gradeColor })
    }
    return m
  }, [savedSnippets])

  const visibleRecent = useMemo(() => {
    const savedSet = new Set(savedSnippets.map((s) => s.address.toLowerCase()))
    return recent.filter((r) => !savedSet.has(r.address.toLowerCase()))
  }, [recent, savedSnippets])

  useEffect(() => {
    if (!recentOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRecentOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [recentOpen])

  // Warm the MapPage + heavy noise chunk while the user is reading the home
  // screen, so clicking through feels instant. requestIdleCallback delays it
  // past first paint; the dynamic imports hit the SW precache on revisits
  // and pull from the network on first visits. Browsers without RIC fall
  // back to a 1.5s setTimeout.
  useEffect(() => {
    const prefetch = () => {
      import('./MapPage').catch(() => undefined)
      import('../noise/airportNoise').catch(() => undefined)
    }
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
    if (typeof ric === 'function') {
      const id = ric(prefetch, { timeout: 3000 })
      return () => {
        const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback
        if (typeof cic === 'function') cic(id)
      }
    }
    const id = window.setTimeout(prefetch, 1500)
    return () => window.clearTimeout(id)
  }, [])

  const goToAddress = (value: string, source: 'typed' | 'suggestion' | 'locate' | 'recent' | 'saved' = 'typed') => {
    const trimmed = value.trim()
    if (!trimmed) return
    setShowSuggestions(false)
    setRecentOpen(false)
    setRecent(pushRecentSearch(trimmed))
    trackEvent('address_search', { source })
    navigate(`/map?address=${encodeURIComponent(trimmed)}`)
  }

  const handleRemoveRecent = (e: React.MouseEvent, value: string) => {
    e.stopPropagation()
    setRecent(removeRecentSearch(value))
  }

  const handleClearRecent = () => {
    clearRecentSearches()
    setRecent([])
  }
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const recentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
      }
      if (recentRef.current && !recentRef.current.contains(e.target as Node)) {
        setRecentOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  useEffect(() => {
    if (!showAbout) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowAbout(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showAbout])

  const fetchSuggestions = (query: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (query.length < 3 || !TOMTOM_API_KEY) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const url = `https://api.tomtom.com/search/2/search/${encodeURIComponent(query)}.json?key=${TOMTOM_API_KEY}&countrySet=US&typeahead=true&limit=5&language=en-US`
        const res = await fetch(url)
        const data = await res.json()
        const results: TomTomResult[] = data.results || []
        const mapped: Suggestion[] = results.map((r) => ({
          id: r.id,
          display: formatTomTomResult(r),
          raw: r,
        }))
        setSuggestions(mapped)
        setShowSuggestions(mapped.length > 0)
        setActiveIndex(-1)
      } catch {
        setSuggestions([])
        setShowSuggestions(false)
      }
    }, 300)
  }

  const handleInputChange = (value: string) => {
    setAddress(value)
    fetchSuggestions(value)
  }

  const selectSuggestion = (suggestion: Suggestion) => {
    setAddress(suggestion.display)
    setShowSuggestions(false)
    setSuggestions([])
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1))
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      selectSuggestion(suggestions[activeIndex])
    } else if (e.key === 'Escape') {
      setShowSuggestions(false)
    }
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    goToAddress(address)
  }

  const handleUseMyLocation = () => {
    if (!('geolocation' in navigator)) {
      setLocateError('Your browser does not support geolocation.')
      return
    }
    setLocateError(null)
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords
          dbg('geocode', `useMyLocation: got coords ${latitude.toFixed(4)},${longitude.toFixed(4)}`)
          if (TOMTOM_API_KEY) {
            // countrySet=US makes TomTom return zero addresses for
            // coordinates outside the US so we can refuse fast with a
            // clear message instead of routing the user into a geocode
            // that will fail anyway.
            const url = `https://api.tomtom.com/search/2/reverseGeocode/${latitude},${longitude}.json?key=${TOMTOM_API_KEY}&radius=100&countrySet=US`
            const res = await fetch(url)
            const data = await res.json()
            const addr = data?.addresses?.[0]?.address?.freeformAddress
            dbg('geocode', `useMyLocation: reverseGeocode(US) ${addr ? 'resolved to "' + addr + '"' : 'returned no US address'}`)
            if (addr) {
              setLocating(false)
              goToAddress(addr, 'locate')
              return
            }
            setLocating(false)
            dbg('geocode', 'useMyLocation: refusing — no US address at those coords')
            setLocateError('Land Recon currently supports US addresses only.')
            return
          }
          setLocating(false)
          setLocateError('Could not look up your address. Try entering it manually.')
        } catch (err) {
          dbg('geocode', 'useMyLocation: reverseGeocode threw', err)
          setLocating(false)
          setLocateError('Could not look up your address. Try entering it manually.')
        }
      },
      (err) => {
        setLocating(false)
        if (err.code === err.PERMISSION_DENIED) {
          setLocateError('Location access was blocked. Enable it in your browser to use this feature.')
        } else {
          setLocateError('Could not get your location. Try entering an address manually.')
        }
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    )
  }

  return (
    <div className="home">
      <div className="home-content">
        <div className="home-icon">
          <img src={logo} alt="Land Recon" width="480" height="102" decoding="async" />
        </div>
        <p className="home-subtitle">
          Smart neighborhood insights for any U.S. address
        </p>
        <form className="home-form" onSubmit={handleSubmit}>
          <div className="input-wrapper" ref={wrapperRef}>
            <svg className="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              className="home-input"
              placeholder="Street address, city, state"
              value={address}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              autoComplete="off"
              aria-label="U.S. address to analyze"
              aria-autocomplete="list"
              aria-expanded={showSuggestions}
              aria-controls="home-suggestions"
            />
            <button
              type="button"
              className="home-input-locate"
              onClick={handleUseMyLocation}
              disabled={locating}
              aria-label="Use my current location"
              data-tooltip={locating ? 'Finding you…' : 'Use my current location'}
            >
              {locating ? (
                <span className="home-locate-spinner" aria-hidden="true" />
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <circle cx="12" cy="12" r="3" />
                  <line x1="12" y1="2" x2="12" y2="5" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                  <line x1="2" y1="12" x2="5" y2="12" />
                  <line x1="19" y1="12" x2="22" y2="12" />
                </svg>
              )}
            </button>
            {address.length > 0 && address.length < 3 && !showSuggestions && (
              <div className="home-input-hint" role="status">
                Keep typing — we'll suggest matches after 3 characters.
              </div>
            )}
            {showSuggestions && (
              <ul className="suggestions-list" id="home-suggestions" role="listbox">
                {suggestions.map((s, i) => (
                  <li
                    key={s.id}
                    role="option"
                    aria-selected={i === activeIndex}
                    className={`suggestion-item ${i === activeIndex ? 'active' : ''}`}
                    onMouseDown={() => selectSuggestion(s)}
                    onMouseEnter={() => setActiveIndex(i)}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                      <circle cx="12" cy="10" r="3" />
                    </svg>
                    {s.display}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button type="submit" className="home-button" disabled={!address.trim()}>
            Explore
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </form>
        {locateError && (
          <p className="home-locate-error" role="alert">{locateError}</p>
        )}
        {savedSnippets.length > 0 && (
          <section className="home-saved" aria-label="Saved analyses">
            <header className="home-recent-header">
              <span className="home-recent-title">Saved</span>
            </header>
            <ul className="home-saved-list">
              {savedSnippets.map((s) => (
                <li key={s.address} className="home-saved-item">
                  <button
                    type="button"
                    className="home-saved-go"
                    onClick={() => goToAddress(s.address, 'saved')}
                    title={s.address}
                  >
                    <span
                      className="home-saved-grade"
                      style={{ background: s.gradeColor }}
                      aria-label={`Grade ${s.grade}`}
                    >
                      {s.grade}
                    </span>
                    <span className="home-saved-address">{s.address}</span>
                    {s.date && <span className="home-saved-date">{s.date}</span>}
                  </button>
                  <button
                    type="button"
                    className="home-recent-remove"
                    onClick={(e) => {
                      e.stopPropagation()
                      setSavedSnippets(removeSavedAnalysisSnippet(s.address))
                    }}
                    aria-label={`Remove ${s.address} from saved analyses`}
                    title="Remove"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {visibleRecent.length > 0 && (
          <section className="home-recent" aria-label="Recent searches" ref={recentRef}>
            <button
              type="button"
              className="home-recent-trigger"
              aria-haspopup="listbox"
              aria-expanded={recentOpen}
              onClick={() => setRecentOpen((v) => !v)}
            >
              <svg
                className="home-recent-icon"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <polyline points="12 7 12 12 15 14" />
              </svg>
              <span className="home-recent-trigger-label">Recent searches</span>
              <span className="home-recent-count">{visibleRecent.length}</span>
              <svg
                className={`home-recent-chevron${recentOpen ? ' open' : ''}`}
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {recentOpen && (
              <div className="home-recent-panel" role="listbox">
                <ul className="home-recent-list">
                  {visibleRecent.slice(0, 5).map((item) => {
                    const saved = gradeByAddress.get(item.address.toLowerCase())
                    const grade = saved ?? (item.grade && item.gradeColor
                      ? { grade: item.grade, gradeColor: item.gradeColor }
                      : undefined)
                    return (
                      <li key={item.address} className="home-recent-item" role="option">
                        <button
                          type="button"
                          className="home-recent-go"
                          onClick={() => goToAddress(item.address, 'recent')}
                          title={item.address}
                        >
                          <span className="home-recent-address">{item.address}</span>
                          {grade && (
                            <span
                              className="home-recent-grade"
                              style={{ background: grade.gradeColor }}
                              aria-label={`Saved grade ${grade.grade}`}
                            >
                              {grade.grade}
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className="home-recent-remove"
                          onClick={(e) => handleRemoveRecent(e, item.address)}
                          aria-label={`Remove ${item.address} from recent searches`}
                          title="Remove"
                        >
                          ×
                        </button>
                      </li>
                    )
                  })}
                </ul>
                <footer className="home-recent-footer">
                  <button
                    type="button"
                    className="home-recent-clear"
                    onClick={handleClearRecent}
                  >
                    Clear all
                  </button>
                </footer>
              </div>
            )}
          </section>
        )}
        <footer className="home-footer">
          <button className="home-about-link" onClick={() => setShowAbout(true)}>What is LandRecon?</button>
        </footer>
      </div>

      {showAbout && (
        <div className="about-overlay" onClick={() => setShowAbout(false)}>
          <div className="about-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="about-modal-title">
            <div className="about-header">
              <h2 id="about-modal-title">About LandRecon</h2>
              <button className="about-close" onClick={() => setShowAbout(false)} aria-label="Close About">×</button>
            </div>
            <div className="about-body">
              <p>
                LandRecon helps homebuyers and curious neighbors understand what's really around a property.
                Enter any U.S. address and instantly see airport noise levels, EPA Superfund sites, nearby
                data centers, retail proximity, and more — all scored and visualized on an interactive map.
              </p>
              <p>
                Our goal is to surface the hidden factors that affect where you live and work — the kind of
                details that don't show up in a typical listing but can make all the difference.
              </p>
              <h3>What we analyze</h3>
              <ul>
                <li>✈️ <strong>Airport Noise</strong> — FAA noise contour data mapped to your address</li>
                <li>☢️ <strong>Superfund Sites</strong> — EPA hazardous waste sites within 5 miles</li>
                <li>🛒 <strong>Retail Proximity</strong> — Distance to the nearest Costco (a surprisingly strong quality-of-life indicator)</li>
                <li>🏢 <strong>Data Centers</strong> — Nearby facilities that may bring noise, traffic, or infrastructure strain</li>
                <li>🏥 <strong>Emergency Rooms</strong> — Distance to the nearest hospital emergency department</li>
              </ul>
              <h3>How scoring works</h3>
              <p>
                Each category is evaluated and assigned a concern level. These are combined into an overall
                letter grade (A through F) so you can compare locations at a glance. Click the score bar
                for a full breakdown of how each factor contributed.
              </p>
              <p className="about-disclaimer">
                LandRecon is provided for informational purposes only. Data may not be complete or current.
                Always verify important findings through official sources before making decisions.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default HomePage
