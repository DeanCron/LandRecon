import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type DevTodo,
  DEV_TODOS,
  readDevTodoItems,
  writeDevTodoItems,
  readDevTodoChecks,
  writeDevTodoChecks,
  fetchDevTodosFromServer,
  saveDevTodosToServer,
} from '../map/devTodos'
import { dbg } from '../utils/debug'

export type DevTodoSync = 'idle' | 'loading' | 'saving' | 'offline'

export function useDevTodos(open: boolean) {
  const [items, setItems] = useState<DevTodo[]>(() => readDevTodoItems())
  const [checks, setChecks] = useState<Record<string, boolean>>(() => readDevTodoChecks())
  const [sync, setSync] = useState<DevTodoSync>('idle')
  const saveTimer = useRef<number | null>(null)

  useEffect(() => () => {
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current)
  }, [])

  // Push the current items + checks to the server, debounced so a burst of
  // edits collapses into a single PUT. Falls back to localStorage-only mode
  // if the server can't be reached (e.g. running the SPA outside the
  // container, or sidecar down).
  const persist = useCallback((nextItems: DevTodo[], nextChecks: Record<string, boolean>) => {
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(async () => {
      setSync('saving')
      dbg('devtodos', `Saving to server: ${nextItems.length} item(s)…`)
      const ok = await saveDevTodosToServer({ items: nextItems, checks: nextChecks })
      dbg('devtodos', ok ? 'Server save OK' : 'Server save failed — falling back to localStorage-only')
      setSync(ok ? 'idle' : 'offline')
    }, 400)
  }, [])

  // When the modal opens, refresh from the server. If the server is
  // reachable, its data is the source of truth and we also mirror it to
  // localStorage for next-load speed + offline fallback.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    queueMicrotask(() => { if (!cancelled) setSync('loading') })
    dbg('devtodos', 'Modal opened — fetching from server…')
    fetchDevTodosFromServer().then((data) => {
      if (cancelled) return
      if (data) {
        dbg('devtodos', `Server returned ${data.items.length} item(s); using server as source of truth`)
        setItems(data.items.length > 0 ? data.items : DEV_TODOS)
        setChecks(data.checks)
        writeDevTodoItems(data.items.length > 0 ? data.items : DEV_TODOS)
        writeDevTodoChecks(data.checks)
        setSync('idle')
      } else {
        dbg('devtodos', 'Server unreachable or no token — staying in localStorage-only mode')
        setSync('offline')
      }
    })
    return () => { cancelled = true }
  }, [open])

  const toggle = (id: string) => {
    dbg('devtodos', `Toggle "${id}"`)
    setChecks((prev) => {
      const next = { ...prev, [id]: !prev[id] }
      writeDevTodoChecks(next)
      persist(items, next)
      return next
    })
  }
  const add = (text: string) => {
    const label = text.trim()
    if (!label) return
    const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    dbg('devtodos', `Add "${label}" (${id})`)
    setItems((prev) => {
      const next = [...prev, { id, label }]
      writeDevTodoItems(next)
      persist(next, checks)
      return next
    })
  }
  const remove = (id: string) => {
    dbg('devtodos', `Delete "${id}"`)
    const nextChecks = { ...checks }
    delete nextChecks[id]
    setItems((prev) => {
      const next = prev.filter((t) => t.id !== id)
      writeDevTodoItems(next)
      writeDevTodoChecks(nextChecks)
      persist(next, nextChecks)
      return next
    })
    setChecks(nextChecks)
  }
  const remaining = items.filter((t) => !checks[t.id]).length

  return { items, checks, sync, remaining, toggle, add, remove }
}
