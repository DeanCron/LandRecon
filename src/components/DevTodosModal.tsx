import { memo, useState } from 'react'
import type { DevTodo } from '../map/devTodos'
import type { DevTodoSync } from '../hooks/useDevTodos'

type Props = {
  items: DevTodo[]
  checks: Record<string, boolean>
  sync: DevTodoSync
  remaining: number
  onToggle: (id: string) => void
  onAdd: (text: string) => void
  onDelete: (id: string) => void
  onClose: () => void
}

function DevTodosModalImpl({ items, checks, sync, remaining, onToggle, onAdd, onDelete, onClose }: Props) {
  // Typing state is local so keystrokes don't re-render the whole map page.
  const [newText, setNewText] = useState('')

  return (
    <div className="analysis-detail-overlay" onClick={onClose}>
      <div className="analysis-detail-popup dev-todos-popup" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="dev-todos-title">
        <button className="analysis-detail-close" onClick={onClose} aria-label="Close">×</button>
        <h3 id="dev-todos-title">📋 To Do</h3>
        <p className="dev-todos-summary">
          {items.length === 0
            ? 'No items yet — add one below.'
            : remaining === 0
            ? 'All caught up — nice.'
            : `${remaining} of ${items.length} remaining`}
        </p>
        <ul className="dev-todos-list">
          {items.map((t) => {
            const done = !!checks[t.id]
            return (
              <li key={t.id} className={`dev-todo-item${done ? ' done' : ''}`}>
                <label>
                  <input type="checkbox" checked={done} onChange={() => onToggle(t.id)} />
                  <span className="dev-todo-label">{t.label}</span>
                </label>
                {t.note && <div className="dev-todo-note">{t.note}</div>}
                <button
                  type="button"
                  className="dev-todo-delete"
                  onClick={() => onDelete(t.id)}
                  aria-label={`Delete "${t.label}"`}
                  title="Delete"
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
        <form
          className="dev-todos-add"
          onSubmit={(e) => { e.preventDefault(); onAdd(newText); setNewText('') }}
        >
          <input
            type="text"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            placeholder="Add a new todo…"
            aria-label="New todo text"
            maxLength={200}
          />
          <button type="submit" disabled={!newText.trim()}>Add</button>
        </form>
        <div className="dev-todos-hint">
          {sync === 'loading' && 'Loading from server…'}
          {sync === 'saving' && 'Saving…'}
          {sync === 'offline' && 'Server unreachable — saved to this browser only.'}
        </div>
      </div>
    </div>
  )
}

export const DevTodosModal = memo(DevTodosModalImpl)
