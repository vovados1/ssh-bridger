import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent
} from 'react'
import { isDirLike, type Entry, type MachineId } from '@shared/fs-types'
import type { FsClient } from '../../lib/fs-client'
import { copyText } from '../../lib/api'
import type { Notify } from '../../lib/toasts'
import { ColumnContext, useColumn, useColumnStore } from './ColumnContext'
import { createColumnStore } from './columnStore'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { ConfirmDeleteDialog } from './dialogs/ConfirmDeleteDialog'
import { PermissionsDialog } from './dialogs/PermissionsDialog'
import { PropertiesDialog } from './dialogs/PropertiesDialog'
import { FileList, rowId } from './FileList'
import { PathBar, type PathBarHandle } from './PathBar'
import styles from './Column.module.css'

interface ColumnProps {
  machineId: MachineId
  title: string
  fs: FsClient
  notify: Notify
}

export function Column({ machineId, title, fs, notify }: ColumnProps) {
  const [store] = useState(() =>
    createColumnStore({ machineId, fs, notify, watchKey: crypto.randomUUID() })
  )

  useEffect(() => {
    void store.getState().init()
    return () => store.getState().dispose()
  }, [store])

  return (
    <ColumnContext.Provider value={store}>
      <ColumnView title={title} notify={notify} />
    </ColumnContext.Provider>
  )
}

type Overlay =
  | { kind: 'menu'; x: number; y: number; items: MenuItem[] }
  | { kind: 'confirmDelete'; entries: Entry[] }
  | { kind: 'permissions'; entries: Entry[] }
  | { kind: 'properties'; paths: string[]; entries: Entry[] }

function ColumnView({ title, notify }: { title: string; notify: Notify }) {
  const store = useColumnStore()
  const pathBar = useRef<PathBarHandle | null>(null)
  const pageSize = useRef(10)
  const rootRef = useRef<HTMLElement>(null)
  const [overlay, setOverlay] = useState<Overlay | null>(null)

  const error = useColumn((s) => s.error)
  const count = useColumn((s) => s.visible.length)
  const selectedCount = useColumn((s) => s.selected.size)
  const renaming = useColumn((s) => s.renaming)

  // Menus, dialogs and the rename field all leave focus on <body> when they go away; hand it
  // back to the list so shortcuts keep working. (Focusing earlier fails: a modal dialog makes
  // everything else inert until it is gone.)
  useEffect(() => {
    if (renaming === null && overlay === null && document.activeElement === document.body) {
      rootRef.current?.focus()
    }
  }, [renaming, overlay])

  const closeOverlay = useCallback(() => setOverlay(null), [])
  const loadDetails = useCallback((path: string) => store.getState().details(path), [store])

  // ---- actions shared by the keyboard and the context menu ----------------------------------

  const trash = () => {
    const targets = store.getState().selectedEntries()
    if (targets.length > 0)
      void store.getState().remove(
        targets.map((e) => e.path),
        { permanent: false }
      )
  }
  const deletePermanently = () => {
    const entries = store.getState().selectedEntries()
    if (entries.length > 0) setOverlay({ kind: 'confirmDelete', entries })
  }
  const editPermissions = () => {
    const entries = store.getState().selectedEntries()
    if (entries.length > 0) setOverlay({ kind: 'permissions', entries })
  }
  /** Properties of the selection, or of the current folder when nothing is selected. */
  const showProperties = () => {
    const { selectedEntries, cwd } = store.getState()
    const entries = selectedEntries()
    if (entries.length > 0)
      setOverlay({ kind: 'properties', paths: entries.map((e) => e.path), entries })
    else if (cwd !== null) setOverlay({ kind: 'properties', paths: [cwd], entries: [] })
  }
  const copyPaths = (paths: string[]) => {
    copyText(paths.join('\n')).catch(() => {
      notify({ kind: 'error', message: 'Could not copy to the clipboard' })
    })
  }

  // ---- context menu --------------------------------------------------------------------------

  const menuItems = (entry: Entry | null): MenuItem[] => {
    const s = store.getState()
    const targets = entry ? s.selectedEntries() : []
    const one = targets.length === 1 ? targets[0]! : null
    const items = targets.length > 1 ? `${targets.length} Items` : ''

    if (entry === null) {
      return [
        { label: 'New Folder', shortcut: 'Ctrl+Shift+N', onSelect: () => void s.create('folder') },
        { label: 'New File', shortcut: 'Ctrl+Alt+N', onSelect: () => void s.create('file') },
        { separator: true },
        { label: 'Refresh', shortcut: 'F5', onSelect: () => void s.refresh() },
        {
          label: 'Show Hidden Files',
          shortcut: 'Ctrl+H',
          checked: s.showHidden,
          onSelect: s.toggleHidden
        },
        { separator: true },
        {
          label: 'Copy Path',
          disabled: s.cwd === null,
          onSelect: () => s.cwd !== null && copyPaths([s.cwd])
        },
        { label: 'Properties', shortcut: 'Alt+Enter', onSelect: showProperties }
      ]
    }
    return [
      {
        label: 'Open',
        shortcut: 'Enter',
        disabled: !one || !isDirLike(one),
        onSelect: () => one && void s.open(one)
      },
      { separator: true },
      { label: 'Rename', shortcut: 'F2', disabled: !one, onSelect: () => s.startRename(one?.path) },
      {
        label: items ? `Move ${items} to Trash` : 'Move to Trash',
        shortcut: 'Del',
        onSelect: trash
      },
      {
        label: items ? `Delete ${items} Permanently…` : 'Delete Permanently…',
        shortcut: 'Shift+Del',
        danger: true,
        onSelect: deletePermanently
      },
      { separator: true },
      { label: 'Permissions…', onSelect: editPermissions },
      { label: 'Copy Path', onSelect: () => copyPaths(targets.map((e) => e.path)) },
      { label: 'Properties', shortcut: 'Alt+Enter', onSelect: showProperties }
    ]
  }

  const openMenu = (x: number, y: number, entry: Entry | null) => {
    const s = store.getState()
    if (entry && !s.selected.has(entry.path)) s.selectOnly(entry.path)
    if (entry === null) s.clearSelection()
    setOverlay({ kind: 'menu', x, y, items: menuItems(entry) })
  }

  const onContextMenu = (e: MouseEvent, entry: Entry | null) => {
    e.preventDefault()
    openMenu(e.clientX, e.clientY, entry)
  }

  // ---- keyboard ------------------------------------------------------------------------------

  const onKeyDown = (e: KeyboardEvent) => {
    // Typing in the path bar or renaming must not trigger list shortcuts.
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const s = store.getState()
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key

    const handled = (() => {
      switch (key) {
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
          if (e.altKey) showProperties()
          else void s.openCursor()
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
        case 'F2':
          s.startRename()
          return true
        case 'Delete':
          if (e.shiftKey) deletePermanently()
          else trash()
          return true
        case 'F5':
          void s.refresh()
          return true
        case 'F10':
        case 'ContextMenu': {
          if (key === 'F10' && !e.shiftKey) return false
          // Open at the cursor row, like a right-click on it.
          const rect = s.cursor
            ? document.getElementById(rowId(s.cursor))?.getBoundingClientRect()
            : null
          const entry = s.visible.find((v) => v.path === s.cursor) ?? null
          openMenu(rect ? rect.left + 24 : 80, rect ? rect.bottom : 120, entry)
          return true
        }
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
        case 'n':
          if (!mod) return false
          if (e.shiftKey) void s.create('folder')
          else if (e.altKey) void s.create('file')
          else return false
          return true
        default:
          return false
      }
    })()
    if (handled) e.preventDefault()
  }

  return (
    <section
      ref={rootRef}
      className={styles.column}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label={title}
    >
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
      <FileList pageSizeRef={pageSize} onContextMenu={onContextMenu} />
      <footer className={styles.status}>
        {count} {count === 1 ? 'item' : 'items'}
        {selectedCount > 0 && ` · ${selectedCount} selected`}
      </footer>

      {overlay?.kind === 'menu' && (
        <ContextMenu x={overlay.x} y={overlay.y} items={overlay.items} onClose={closeOverlay} />
      )}
      {overlay?.kind === 'confirmDelete' && (
        <ConfirmDeleteDialog
          names={overlay.entries.map((e) => e.name)}
          onConfirm={() =>
            void store.getState().remove(
              overlay.entries.map((e) => e.path),
              { permanent: true }
            )
          }
          onClose={closeOverlay}
        />
      )}
      {overlay?.kind === 'permissions' && (
        <PermissionsDialog
          entries={overlay.entries}
          onApply={(mode) =>
            void store.getState().chmod(
              overlay.entries.map((e) => e.path),
              mode
            )
          }
          onClose={closeOverlay}
        />
      )}
      {overlay?.kind === 'properties' && (
        <PropertiesDialog
          paths={overlay.paths}
          entries={overlay.entries}
          loadDetails={loadDetails}
          onClose={closeOverlay}
        />
      )}
    </section>
  )
}
