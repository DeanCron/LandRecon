import { useCallback, useEffect, useRef, useState } from 'react'
import { dbg } from '../utils/debug'

const TOMTOM_API_KEY = import.meta.env.VITE_TOMTOM_API_KEY || ''

export interface TomTomSuggestion {
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
  position?: { lat: number; lon: number }
}

export function formatTomTomAddress(s: TomTomSuggestion): string {
  const a = s.address
  if (!a) return ''
  const street = [a.streetNumber, a.streetName].filter(Boolean).join(' ')
  const parts = [street, a.municipality, a.countrySubdivision].filter(Boolean)
  if (a.postalCode) parts.push(a.postalCode)
  return parts.join(', ') || a.freeformAddress || ''
}

// Debounced TomTom typeahead. Superseded requests are aborted so a slower,
// older response can never overwrite the suggestions for a newer query.
export function useAddressSuggestions() {
  const [suggestions, setSuggestions] = useState<TomTomSuggestion[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const cancelPending = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    abortRef.current?.abort()
  }, [])

  const clearSuggestions = useCallback(() => {
    setSuggestions([])
    setShowSuggestions(false)
    setActiveIndex(-1)
    cancelPending()
  }, [cancelPending])

  const fetchSuggestions = useCallback((query: string) => {
    cancelPending()
    if (query.length < 3) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController()
      abortRef.current = controller
      dbg('geocode', 'Fetching suggestions for:', query)
      try {
        const url = `https://api.tomtom.com/search/2/search/${encodeURIComponent(query)}.json?key=${TOMTOM_API_KEY}&countrySet=US&typeahead=true&limit=5&language=en-US`
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok) throw new Error(`Suggestions failed: ${res.status}`)
        const data = await res.json()
        if (controller.signal.aborted) return
        const results: TomTomSuggestion[] = data.results || []
        dbg('geocode', `Got ${results.length} suggestions`)
        setSuggestions(results)
        setShowSuggestions(results.length > 0)
        setActiveIndex(-1)
      } catch {
        if (controller.signal.aborted) return
        setSuggestions([])
        setShowSuggestions(false)
      }
    }, 300)
  }, [cancelPending])

  useEffect(() => cancelPending, [cancelPending])

  return {
    suggestions,
    showSuggestions,
    setShowSuggestions,
    activeIndex,
    setActiveIndex,
    fetchSuggestions,
    clearSuggestions,
  }
}
