export type StaticMapOptions = {
  lat: number
  lng: number
  zoom?: number
  width?: number
  height?: number
  scale?: number
  key: string
}

const STATIC_MAP_ENDPOINT = 'https://maps.googleapis.com/maps/api/staticmap'

export function buildStaticMapUrl(opts: StaticMapOptions): string {
  const zoom = opts.zoom ?? 15
  const width = opts.width ?? 640
  const height = opts.height ?? 320
  const scale = opts.scale ?? 2
  const center = `${opts.lat},${opts.lng}`
  const params = new URLSearchParams({
    center,
    zoom: String(zoom),
    size: `${width}x${height}`,
    scale: String(scale),
    markers: `color:red|${center}`,
    key: opts.key,
  })
  return `${STATIC_MAP_ENDPOINT}?${params.toString()}`
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export async function fetchStaticMapDataUrl(
  opts: StaticMapOptions,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | null> {
  if (!opts.key) return null
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? 8000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(buildStaticMapUrl(opts), { signal: controller.signal })
    if (!res.ok) return null
    const buffer = await res.arrayBuffer()
    return `data:image/png;base64,${toBase64(new Uint8Array(buffer))}`
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
