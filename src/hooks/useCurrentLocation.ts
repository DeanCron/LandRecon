import { useCallback, useEffect, useRef, useState } from 'react'
import { confirmUsGpsTarget, requestGpsPosition } from '../utils/currentLocation'

export function useCurrentLocation(apiKey: string) {
  const [locating, setLocating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = useRef<AbortController | null>(null)

  const cancel = useCallback(() => {
    active.current?.abort()
    active.current = null
    setLocating(false)
    setError(null)
  }, [])

  useEffect(() => () => {
    active.current?.abort()
    active.current = null
  }, [])

  const locate = useCallback(async () => {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setLocating(true)
    setError(null)
    try {
      const position = await requestGpsPosition(controller.signal)
      controller.signal.throwIfAborted()
      const target = await confirmUsGpsTarget(position, apiKey, controller.signal)
      return active.current === controller && !controller.signal.aborted ? target : null
    } catch (cause) {
      if (active.current === controller && !controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Could not determine your location. Retry or enter an address.')
      }
      return null
    } finally {
      if (active.current === controller) {
        active.current = null
        setLocating(false)
      }
    }
  }, [apiKey])

  return { locating, error, locate, cancel }
}
