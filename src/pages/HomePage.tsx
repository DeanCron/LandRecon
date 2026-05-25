import { useState, useEffect, useRef, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import logo from '../assets/landrecon.webp'
import './HomePage.css'

interface Suggestion {
  place_id: number
  display_name: string
  address?: {
    house_number?: string
    road?: string
    city?: string
    town?: string
    village?: string
    state?: string
    postcode?: string
    county?: string
    country?: string
  }
}

function formatAddress(s: Suggestion): string {
  const a = s.address
  if (!a) return s.display_name
  const street = [a.house_number, a.road].filter(Boolean).join(' ')
  const city = a.city || a.town || a.village || ''
  const parts = [street, city, a.state].filter(Boolean)
  if (a.postcode) parts.push(a.postcode)
  return parts.join(', ') || s.display_name
}

function HomePage() {
  const [address, setAddress] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
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
    if (query.length < 3) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=5&countrycodes=us`
        const res = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'LandRecon/1.0' } })
        const data: Suggestion[] = await res.json()
        setSuggestions(data)
        setShowSuggestions(data.length > 0)
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
    setAddress(formatAddress(suggestion))
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
          <img src={logo} alt="Land Recon" width="320" height="320" />
        </div>
        <p className="home-subtitle">
          Enter a U.S. street address to explore land data and map layers.
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
              placeholder="e.g. 1600 Pennsylvania Ave NW, Washington, DC 20500"
              value={address}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              autoFocus
              autoComplete="off"
            />
            {showSuggestions && (
              <ul className="suggestions-list">
                {suggestions.map((s, i) => (
                  <li
                    key={s.place_id}
                    className={`suggestion-item ${i === activeIndex ? 'active' : ''}`}
                    onMouseDown={() => selectSuggestion(s)}
                    onMouseEnter={() => setActiveIndex(i)}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                      <circle cx="12" cy="10" r="3" />
                    </svg>
                    {formatAddress(s)}
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
      </div>
    </div>
  )
}

export default HomePage
