export interface RecentSearch {
  address: string
  timestamp: number
  grade?: string
  gradeColor?: string
}

export interface SavedAnalysisSnippet {
  address: string
  grade: string
  gradeColor: string
  date?: string
}

const RECENT_KEY = 'lr_recent_searches'
const SAVED_KEY = 'lr_saved_analyses'
const RECENT_MAX = 5

export function loadRecentSearches(): RecentSearch[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const cleaned = parsed
      .filter(
        (r): r is RecentSearch =>
          r && typeof r.address === 'string' && typeof r.timestamp === 'number',
      )
      .map((r) => ({
        address: r.address,
        timestamp: r.timestamp,
        grade: typeof r.grade === 'string' ? r.grade : undefined,
        gradeColor: typeof r.gradeColor === 'string' ? r.gradeColor : undefined,
      }))
    // Collapse duplicates from any older storage where dedup wasn't enforced.
    // Newest occurrence wins (input is ordered newest-first), but if an older
    // copy carries a grade the newer entry is missing, promote that.
    const seen = new Map<string, RecentSearch>()
    for (const r of cleaned) {
      const key = r.address.toLowerCase()
      const existing = seen.get(key)
      if (!existing) {
        seen.set(key, r)
      } else {
        if (!existing.grade && r.grade) {
          existing.grade = r.grade
          existing.gradeColor = r.gradeColor
        }
      }
    }
    return Array.from(seen.values()).slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

export function pushRecentSearch(address: string): RecentSearch[] {
  const norm = (address || '').trim()
  if (!norm) return loadRecentSearches()
  const existing = loadRecentSearches()
  const prev = existing.find((r) => r.address.toLowerCase() === norm.toLowerCase())
  const filtered = existing.filter((r) => r.address.toLowerCase() !== norm.toLowerCase())
  const next: RecentSearch[] = [
    { address: norm, timestamp: Date.now(), grade: prev?.grade, gradeColor: prev?.gradeColor },
    ...filtered,
  ].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* storage may be full or disabled */
  }
  return next
}

export function updateRecentSearchGrade(
  address: string,
  grade: string,
  gradeColor: string,
): RecentSearch[] {
  const norm = (address || '').trim()
  if (!norm) return loadRecentSearches()
  const existing = loadRecentSearches()
  let changed = false
  const next = existing.map((r) => {
    if (r.address.toLowerCase() !== norm.toLowerCase()) return r
    if (r.grade === grade && r.gradeColor === gradeColor) return r
    changed = true
    return { ...r, grade, gradeColor }
  })
  if (!changed) return existing
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
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
