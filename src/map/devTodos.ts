// Developer todo list, shown via the hidden Experimental menu. DEV_TODOS
// below is the initial seed used the first time the modal is opened; after
// that the canonical list lives in localStorage (under DEV_TODOS_ITEMS_KEY)
// so add/delete from the UI persists across sessions. Per-item checkbox
// state is stored separately under DEV_TODOS_CHECKS_KEY.
export interface DevTodo { id: string; label: string; note?: string }

export const DEV_TODOS: DevTodo[] = [
  { id: 'crowd-tune', label: 'Tune Crowd Magnets filters once we see more sample addresses' },
  { id: 'mobile-polish', label: 'Mobile: verify analysis panel + layer panel ergonomics on small screens' },
  { id: 'grade-rebalance', label: 'Revisit Location Grade weights now that Crowd Magnets is included' },
]

const DEV_TODOS_ITEMS_KEY = 'lr_dev_todos_items'
const DEV_TODOS_CHECKS_KEY = 'lr_dev_todos'
const DEV_TODOS_TOKEN_KEY = 'lr_dev_todos_token'
const DEV_TODOS_API = '/api/dev-todos'

// The server store is gated by a developer secret. It is read from
// localStorage (set once via the console: localStorage.setItem(
// 'lr_dev_todos_token', '<token>')) so it never ships in the public bundle.
// Without it, the modal stays in localStorage-only mode.
function devTodosToken(): string {
  try { return localStorage.getItem(DEV_TODOS_TOKEN_KEY) || '' } catch { return '' }
}
function devTodosAuthHeaders(): Record<string, string> {
  const token = devTodosToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export function readDevTodoItems(): DevTodo[] {
  try {
    const raw = localStorage.getItem(DEV_TODOS_ITEMS_KEY)
    if (!raw) return DEV_TODOS
    const parsed = JSON.parse(raw) as DevTodo[]
    if (!Array.isArray(parsed)) return DEV_TODOS
    return parsed.filter((t) => t && typeof t.id === 'string' && typeof t.label === 'string')
  } catch { return DEV_TODOS }
}
export function writeDevTodoItems(items: DevTodo[]) {
  try { localStorage.setItem(DEV_TODOS_ITEMS_KEY, JSON.stringify(items)) } catch { /* ignore */ }
}
export function readDevTodoChecks(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(DEV_TODOS_CHECKS_KEY)
    return raw ? JSON.parse(raw) as Record<string, boolean> : {}
  } catch { return {} }
}
export function writeDevTodoChecks(state: Record<string, boolean>) {
  try { localStorage.setItem(DEV_TODOS_CHECKS_KEY, JSON.stringify(state)) } catch { /* ignore */ }
}

export async function fetchDevTodosFromServer(signal?: AbortSignal): Promise<{ items: DevTodo[]; checks: Record<string, boolean> } | null> {
  if (!devTodosToken()) return null
  try {
    const res = await fetch(DEV_TODOS_API, { signal, cache: 'no-store', headers: devTodosAuthHeaders() })
    if (!res.ok) return null
    const data = await res.json()
    const items = Array.isArray(data?.items)
      ? data.items.filter((t: unknown): t is DevTodo =>
          !!t && typeof (t as DevTodo).id === 'string' && typeof (t as DevTodo).label === 'string')
      : []
    const checks = data?.checks && typeof data.checks === 'object' ? data.checks as Record<string, boolean> : {}
    return { items, checks }
  } catch { return null }
}
export async function saveDevTodosToServer(payload: { items: DevTodo[]; checks: Record<string, boolean> }): Promise<boolean> {
  if (!devTodosToken()) return false
  try {
    const res = await fetch(DEV_TODOS_API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...devTodosAuthHeaders() },
      body: JSON.stringify(payload),
    })
    return res.ok
  } catch { return false }
}
