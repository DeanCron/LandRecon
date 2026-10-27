// Runtime-neutral configuration. In the browser, values come from the public
// VITE_* build-time env. In Node (server/background jobs) they come from
// process.env using unprefixed, server-only names, so keys are never bundled.
type Env = Record<string, string | undefined>

function nodeEnv(): Env {
  return (globalThis as unknown as { process?: { env?: Env } }).process?.env ?? {}
}

export function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined'
}

export function getGoogleMapsKey(): string {
  // Literal import.meta.env access is required for Vite's static replacement.
  return import.meta.env?.VITE_GOOGLE_MAPS_KEY || nodeEnv().GOOGLE_MAPS_API_KEY || ''
}

// Same-origin nginx proxies in the browser; public mirrors elsewhere.
export function getOverpassEndpoints(): string[] {
  const configured = nodeEnv().OVERPASS_ENDPOINTS
  if (configured) return configured.split(',').map((s) => s.trim()).filter(Boolean)
  if (isBrowserRuntime()) return ['/overpass', '/overpass2']
  return [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ]
}

// Prefix for same-origin API paths such as /api/broadband (empty in browser).
export function getApiBaseUrl(): string {
  if (isBrowserRuntime()) return ''
  return (nodeEnv().LANDRECON_API_BASE_URL || '').replace(/\/+$/, '')
}
