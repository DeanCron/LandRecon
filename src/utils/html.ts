// Leaflet tooltips and popups render string content via innerHTML, so any
// third-party value (OSM tags, Google Places, EPA/FEMA/HIFLD fields)
// interpolated into one must go through these helpers.
export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

// Returns an attribute-safe href for http(s) URLs, or null for anything else
// (javascript:, data:, relative junk, unparsable input).
export function safeHttpUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return escapeHtml(parsed.href)
  } catch {
    return null
  }
}
