export type GpsTarget = {
  kind: 'gps'
  lat: number
  lng: number
  accuracy: number
  capturedAt: number
  label?: string
}

export const GPS_QUERY_KEYS = ['lat', 'lng', 'accuracy', 'capturedAt', 'locationLabel'] as const

export function parseGpsTarget(value: unknown): GpsTarget | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.kind !== 'gps'
    || typeof v.lat !== 'number' || !Number.isFinite(v.lat) || Math.abs(v.lat) > 90
    || typeof v.lng !== 'number' || !Number.isFinite(v.lng) || Math.abs(v.lng) > 180
    || typeof v.accuracy !== 'number' || !Number.isFinite(v.accuracy) || v.accuracy < 0
    || typeof v.capturedAt !== 'number' || !Number.isFinite(v.capturedAt)
    || v.capturedAt <= 0 || v.capturedAt > 8.64e15
    || (v.label !== undefined && typeof v.label !== 'string')) return null
  const label = typeof v.label === 'string' ? v.label.trim().slice(0, 300) : ''
  return { kind: 'gps', lat: v.lat, lng: v.lng, accuracy: v.accuracy, capturedAt: v.capturedAt, ...(label ? { label } : {}) }
}

export function gpsTargetLabel(target: GpsTarget): string {
  const point = `${target.lat.toFixed(5)}, ${target.lng.toFixed(5)}`
  return target.label ? `GPS location near ${target.label} (${point})` : `GPS location (${point})`
}

export function gpsAccuracyText(target: GpsTarget): string {
  return `Approximate location: accuracy radius ${Math.ceil(target.accuracy)} m. Not a verified property boundary.`
}

export function locationIdentity(address: string, gps?: GpsTarget | null): string {
  return gps ? `gps:${gps.lat},${gps.lng}` : `address:${address}`
}

export function gpsTargetFromParams(params: URLSearchParams): GpsTarget | null {
  const number = (key: string) => {
    const text = params.get(key)
    return text?.trim() ? Number(text) : NaN
  }
  return parseGpsTarget({
    kind: 'gps', lat: number('lat'), lng: number('lng'),
    accuracy: number('accuracy'), capturedAt: number('capturedAt'),
    label: params.get('locationLabel') ?? undefined,
  })
}

export function setGpsTargetParams(params: URLSearchParams, target: GpsTarget): void {
  params.delete('address')
  for (const key of GPS_QUERY_KEYS) params.delete(key)
  for (const key of ['lat', 'lng', 'accuracy', 'capturedAt'] as const) {
    params.set(key, String(target[key]))
  }
  if (target.label) params.set('locationLabel', target.label)
}
