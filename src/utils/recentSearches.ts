export interface RecentSearch {
  address: string
  timestamp: number
}

export interface SavedAnalysisSnippet {
  address: string
  grade: string
  gradeColor: string
  date?: string
}

const RECENT_KEY = 'lr_recent_searches'
const SAVED_KEY = 'lr_saved_analyses'
const RECENT_MAX = 10

export function loadRecentSearches(): RecentSearch[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r): r is RecentSearch =>
        r && typeof r.address === 'string' && typeof r.timestamp === 'number',
    )
  } catch {
    return []
  }
}

export function pushRecentSearch(address: string): RecentSearch[] {
  const norm = (address || '').trim()
  if (!norm) return loadRecentSearches()
  const existing = loadRecentSearches().filter(
    (r) => r.address.toLowerCase() !== norm.toLowerCase(),
  )
  const next = [{ address: norm, timestamp: Date.now() }, ...existing].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* storage may be full or disabled */
  }
  return next
}

export function removeRecentSearch(address: string): RecentSearch[] {
  const next = loadRecentSearches().filter(
    (r) => r.address.toLowerCase() !== address.toLowerCase(),
  )
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  return next
}

export function clearRecentSearches(): void {
  try {
    localStorage.removeItem(RECENT_KEY)
  } catch {
    /* ignore */
  }
}

export function loadSavedAnalysisSnippets(): SavedAnalysisSnippet[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (r) =>
          r &&
          typeof r.address === 'string' &&
          typeof r.grade === 'string' &&
          typeof r.gradeColor === 'string',
      )
      .map((r) => ({
        address: r.address,
        grade: r.grade,
        gradeColor: r.gradeColor,
        date: typeof r.date === 'string' ? r.date : undefined,
      }))
  } catch {
    return []
  }
}

export function removeSavedAnalysisSnippet(address: string): SavedAnalysisSnippet[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const next = parsed.filter(
      (r) =>
        r &&
        typeof r.address === 'string' &&
        r.address.toLowerCase() !== address.toLowerCase(),
    )
    localStorage.setItem(SAVED_KEY, JSON.stringify(next))
    return next.map((r) => ({
      address: r.address,
      grade: r.grade,
      gradeColor: r.gradeColor,
      date: typeof r.date === 'string' ? r.date : undefined,
    }))
  } catch {
    return []
  }
}

export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000))
  if (diffSec < 45) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return diffDay === 1 ? 'yesterday' : `${diffDay}d ago`
  const diffMo = Math.floor(diffDay / 30)
  if (diffMo < 12) return `${diffMo}mo ago`
  const diffYr = Math.floor(diffMo / 12)
  return `${diffYr}y ago`
}
