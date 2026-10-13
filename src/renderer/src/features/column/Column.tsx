import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { MachineId } from '@shared/fs-types'
import type { FsClient } from '../../lib/fs-client'
import { ColumnContext, useColumn, useColumnStore } from './ColumnContext'
import { createColumnStore } from './columnStore'
import { FileList } from './FileList'
import { PathBar, type PathBarHandle } from './PathBar'
import styles from './Column.module.css'

export function Column({
  machineId,
  title,
  fs
}: {
  machineId: MachineId
  title: string
  fs: FsClient
}) {
  const [store] = useState(() => createColumnStore({ machineId, fs }))

  useEffect(() => {
    void store.getState().init()
  }, [store])

  return (
    <ColumnContext.Provider value={store}>
      <ColumnView title={title} />
    </ColumnContext.Provider>
  )
}

function ColumnView({ title }: { title: string }) {
  const pathBar = useRef<PathBarHandle | null>(null)
  const pageSize = useRef(10)
  const store = useColumnStore()
  const error = useColumn((s) => s.error)
  const count = useColumn((s) => s.visible.length)
  const selectedCount = useColumn((s) => s.selected.size)

  const onKeyDown = (e: KeyboardEvent) => {
    // Typing in the path bar must not trigger list shortcuts.
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const s = store.getState()
    const mod = e.ctrlKey || e.metaKey
    const handled = (() => {
      switch (e.key) {
        case 'ArrowDown':
          s.moveCursor(1, e.shiftKey)
          return true
        case 'ArrowUp':
          s.moveCursor(-1, e.shiftKey)
          return true
        case 'PageDown':
          s.moveCursor(pageSize.current, e.shiftKey)
          return true
        case 'PageUp':
          s.moveCursor(-pageSize.current, e.shiftKey)
          return true
        case 'Home':
          s.cursorTo('first', e.shiftKey)
          return true
        case 'End':
          s.cursorTo('last', e.shiftKey)
          return true
        case 'Enter':
          void s.openCursor()
          return true
        case 'Backspace':
          void s.up()
          return true
        case 'ArrowLeft':
          if (!e.altKey) return false
          void s.back()
          return true
        case 'ArrowRight':
          if (!e.altKey) return false
          void s.forward()
          return true
        case 'F5':
          void s.refresh()
          return true
        case 'Escape':
          s.clearSelection()
          return true
        case 'a':
          if (!mod) return false
          s.selectAll()
          return true
        case 'h':
          if (!mod) return false
          s.toggleHidden()
          return true
        case 'l':
          if (!mod) return false
          pathBar.current?.focus()
          return true
        default:
          return false
      }
    })()
    if (handled) e.preventDefault()
  }

  return (
    <section className={styles.column} tabIndex={0} onKeyDown={onKeyDown} aria-label={title}>
      <header className={styles.title}>{title}</header>
      <PathBar handleRef={pathBar} />
      {error && (
        <div className={styles.error} role="alert">
          <span>{error.message}</span>
          <button onClick={() => store.getState().clearError()} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      <FileList pageSizeRef={pageSize} />
      <footer className={styles.status}>
        {count} {count === 1 ? 'item' : 'items'}
        {selectedCount > 0 && ` · ${selectedCount} selected`}
      </footer>
    </section>
  )
}
