import { useState, useEffect, useRef, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import logo from '../assets/landrecon-logo.webp'
import './HomePage.css'

declare const __BUILD_VERSION__: string

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
  const navigate = useNavigate()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

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
    const trimmed = address.trim()
    if (!trimmed) return
    setShowSuggestions(false)
    navigate(`/map?address=${encodeURIComponent(trimmed)}`)
  }

  return (
    <div className="home">
      <div className="home-content">
        <div className="home-icon">
          <img src={logo} alt="Land Recon" width="480" height="102" />
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
              placeholder="e.g. 6001 S Stony Island Ave, Chicago, IL 60637"
              value={address}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              autoComplete="off"
            />
            {showSuggestions && (
              <ul className="suggestions-list">
                {suggestions.map((s, i) => (
                  <li
                    key={s.id}
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
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </form>
        <footer className="home-footer">
          <button className="home-about-link" onClick={() => setShowAbout(true)}>About LandRecon</button>
        </footer>
      </div>

      {showAbout && (
        <div className="about-overlay" onClick={() => setShowAbout(false)}>
          <div className="about-modal" onClick={(e) => e.stopPropagation()}>
            <div className="about-header">
              <h2>About LandRecon</h2>
              <button className="about-close" onClick={() => setShowAbout(false)}>×</button>
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
