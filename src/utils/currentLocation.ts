import { parseGpsTarget, type GpsTarget } from './locationTarget'

export function requestGpsPosition(signal: AbortSignal): Promise<GpsTarget> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Your browser does not support geolocation. Enter an address instead.'))
      return
    }
    if (signal.aborted) { reject(signal.reason); return }
    let settled = false
    const finish = (error?: Error, target?: GpsTarget) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(target!)
    }
    const abort = () => finish(new DOMException('Location request cancelled.', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('Location request timed out. Try again outdoors or enter an address.')), 15000)
    signal.addEventListener('abort', abort, { once: true })
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const target = parseGpsTarget({
          kind: 'gps', lat: position.coords.latitude, lng: position.coords.longitude,
          accuracy: position.coords.accuracy, capturedAt: position.timestamp,
        })
        if (!target) finish(new Error('Your device returned an invalid location. Retry or enter an address.'))
        else finish(undefined, target)
      },
      (error) => finish(new Error(error.code === 1
        ? 'Location access was blocked. Enable it in your browser, then retry, or enter an address.'
        : error.code === 3 ? 'Location request timed out. Try again outdoors or enter an address.'
          : 'Your location is unavailable. Try again outdoors or enter an address.')),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    )
  })
}

export async function confirmUsGpsTarget(target: GpsTarget, apiKey: string, signal: AbortSignal): Promise<GpsTarget> {
  if (!parseGpsTarget(target)) throw new Error('This GPS location is invalid. Enter an address or try again.')
  if (!apiKey) throw new Error('Location lookup is unavailable. Try entering an address.')
  signal.throwIfAborted()
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, 10000)
  try {
    const response = await fetch(
      `https://api.tomtom.com/search/2/reverseGeocode/${target.lat},${target.lng}.json?key=${encodeURIComponent(apiKey)}&radius=100`,
      { signal: controller.signal },
    )
    if (!response.ok) throw new Error('Could not confirm location coverage. Retry or enter an address.')
    const data = await response.json()
    signal.throwIfAborted()
    const address = data?.addresses?.[0]?.address
    if (!address?.countryCode) throw new Error('Could not confirm US coverage for this location. Retry or enter an address.')
    if (address.countryCode !== 'US') throw new Error('Land Recon currently supports US locations only. Enter a US address.')
    const label = typeof address.freeformAddress === 'string' ? address.freeformAddress.trim().slice(0, 300) : ''
    return {
      kind: 'gps', lat: target.lat, lng: target.lng, accuracy: target.accuracy, capturedAt: target.capturedAt,
      ...(label ? { label } : {}),
    }
  } catch (error) {
    signal.throwIfAborted()
    if (timedOut) throw new Error('Location lookup timed out. Retry or enter an address.')
    if (error instanceof TypeError || error instanceof SyntaxError) {
      throw new Error('Could not confirm location coverage. Check your connection and retry, or enter an address.', { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
