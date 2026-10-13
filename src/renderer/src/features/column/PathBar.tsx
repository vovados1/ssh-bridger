import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { breadcrumbs } from '@shared/posix-path'
import { useColumn, useColumnStore } from './ColumnContext'
import { BackIcon, EyeIcon, ForwardIcon, RefreshIcon, UpIcon } from './icons'
import styles from './PathBar.module.css'

export interface PathBarHandle {
  focus(): void
}

export function PathBar({ handleRef }: { handleRef: { current: PathBarHandle | null } }) {
  const store = useColumnStore()
  const cwd = useColumn((s) => s.cwd)
  const canBack = useColumn((s) => s.historyIndex > 0)
  const canForward = useColumn((s) => s.historyIndex < s.history.length - 1)
  const showHidden = useColumn((s) => s.showHidden)
  const loading = useColumn((s) => s.loading)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const startEditing = () => {
    setDraft(cwd ?? '')
    setEditing(true)
  }

  useEffect(() => {
    handleRef.current = { focus: startEditing }
    return () => {
      handleRef.current = null
    }
  })

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commit = async () => {
    const ok = await store.getState().navigate(draft)
    if (ok) setEditing(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void commit()
    else if (e.key === 'Escape') setEditing(false)
  }

  const { back, forward, up, refresh, toggleHidden } = store.getState()

  return (
    <div className={styles.bar}>
      <button title="Back (Alt+←)" disabled={!canBack} onClick={() => void back()}>
        <BackIcon />
      </button>
      <button title="Forward (Alt+→)" disabled={!canForward} onClick={() => void forward()}>
        <ForwardIcon />
      </button>
      <button
        title="Up (Backspace)"
        disabled={cwd === null || cwd === '/'}
        onClick={() => void up()}
      >
        <UpIcon />
      </button>

      {editing ? (
        <input
          ref={inputRef}
          className={styles.input}
          value={draft}
          spellCheck={false}
          autoFocus
          aria-label="Path"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => setEditing(false)}
        />
      ) : (
        <div
          className={styles.crumbs}
          onClick={startEditing}
          title="Click or Ctrl+L to type a path"
        >
          {cwd !== null &&
            breadcrumbs(cwd).map((crumb, i, all) => (
              <span key={crumb.path} className={styles.crumbItem}>
                <button
                  className={styles.crumb}
                  onClick={(e) => {
                    e.stopPropagation()
                    void store.getState().navigate(crumb.path)
                  }}
                >
                  {crumb.name}
                </button>
                {i > 0 && i < all.length - 1 && <span className={styles.sep}>/</span>}
              </span>
            ))}
        </div>
      )}

      <button title="Refresh (F5)" onClick={() => void refresh()} data-spinning={loading}>
        <RefreshIcon />
      </button>
      <button
        title={showHidden ? 'Hide hidden files (Ctrl+H)' : 'Show hidden files (Ctrl+H)'}
        aria-pressed={showHidden}
        onClick={toggleHidden}
      >
        <EyeIcon off={!showHidden} />
      </button>
    </div>
  )
}
