import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent
} from 'react'
import { isDirLike, type Entry, type MachineId } from '@shared/fs-types'
import type { ConnectionState } from '@shared/connections'
import { StatusDot } from '../../components/StatusDot'
import type { FsClient } from '../../lib/fs-client'
import { copyText } from '../../lib/api'
import type { Notify } from '../../lib/toasts'
import { ColumnContext, useColumn, useColumnStore } from './ColumnContext'
import { createColumnStore, type ColumnInitial } from './columnStore'
import { registerColumn } from './columnRegistry'
import { NO_TRANSFER, type ColumnTransfer } from './columnTransfer'
import { createColumnDnd } from './useColumnDnd'
import type { SortDir, SortKey } from './sort'
import { ContextMenu, type MenuItem } from '../../components/ContextMenu'
import { ConfirmDeleteDialog } from './dialogs/ConfirmDeleteDialog'
import { PermissionsDialog } from './dialogs/PermissionsDialog'
import { PropertiesDialog } from './dialogs/PropertiesDialog'
import { FileList, rowId } from './FileList'
import { PathBar, type PathBarHandle } from './PathBar'
import styles from './Column.module.css'

/** The part of a column's state worth remembering between runs. */
export interface ColumnViewState {
  cwd: string | null
  showHidden: boolean
  sortKey: SortKey
  sortDir: SortDir
}

export interface ColumnProps {
  /** Stable id of this column in the workspace. */
  id: string
  machineId: MachineId
  title: string
  fs: FsClient
  notify: Notify
  /** Only the local machine has a Trash; deleting elsewhere is permanent and always asks first. */
  canTrash?: boolean
  /** Accent color for the header. */
  color?: string
  /** Remote columns: the connection this column lives on. */
  connection?: { state: ConnectionState | undefined; reconnect(): void }
  onClose?: () => void
  /** Folder and view settings restored from the saved layout. */
  initial?: ColumnInitial
  /** Called when the folder or view settings change, so they can be saved. */
  onViewChange?: (view: ColumnViewState) => void
  /** Clipboard and transfer actions. */
  transfer?: ColumnTransfer
  /** Re-read the folder this often (seconds) when the machine can't announce changes. 0: never. */
  pollSeconds?: number
}

export function Column({
  id,
  machineId,
  title,
  fs,
  notify,
  canTrash = true,
  color,
  connection,
  onClose,
  initial,
  onViewChange,
  transfer = NO_TRANSFER,
  pollSeconds = 0
}: ColumnProps) {
  const [store] = useState(() =>
    createColumnStore({
      machineId,
      fs,
      notify,
      watchKey: crypto.randomUUID(),
      ...(initial ? { initial } : {})
    })
  )

  // A remote column can exist before its connection does (restored from the saved layout): it
  // starts listing once connected, and picks up again, in the same folder, after a reconnect.
  const ready = !connection || connection.state?.status === 'connected'
  useEffect(() => {
    if (!ready) return
    void store.getState().init()
    return () => store.getState().dispose()
  }, [store, ready])

  useEffect(() => registerColumn(id, machineId, store), [id, machineId, store])

  // SSH servers can't push changes, so re-read the folder now and then while the window is in use.
  const polled = connection !== undefined && ready
  useEffect(() => {
    if (!polled || pollSeconds <= 0) return
    const poll = (): void => {
      if (!document.hidden) void store.getState().poll()
    }
    const timer = setInterval(poll, pollSeconds * 1000)
    document.addEventListener('visibilitychange', poll) // catch up when coming back to the window
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [store, polled, pollSeconds])

  // Report folder and view changes so the layout can be saved.
  const viewChange = useRef(onViewChange)
  useEffect(() => {
    viewChange.current = onViewChange
  })
  useEffect(() => {
    let last = ''
    return store.subscribe((s) => {
      const key = `${s.cwd}|${s.showHidden}|${s.sortKey}|${s.sortDir}`
      if (key === last) return
      last = key
      viewChange.current?.({
        cwd: s.cwd,
        showHidden: s.showHidden,
        sortKey: s.sortKey,
        sortDir: s.sortDir
      })
    })
  }, [store])

  return (
    <ColumnContext.Provider value={store}>
      <ColumnView
        id={id}
        machineId={machineId}
        title={title}
        notify={notify}
        canTrash={canTrash}
        color={color}
        connection={connection}
        onClose={onClose}
        transfer={transfer}
      />
    </ColumnContext.Provider>
  )
}

type Overlay =
  | { kind: 'menu'; x: number; y: number; items: MenuItem[] }
  | { kind: 'confirmDelete'; entries: Entry[] }
  | { kind: 'permissions'; entries: Entry[] }
  | { kind: 'properties'; paths: string[]; entries: Entry[] }

function ColumnView({
  id,
  machineId,
  title,
  notify,
  canTrash,
  color,
  connection,
  onClose,
  transfer
}: {
  id: string
  machineId: MachineId
  title: string
  notify: Notify
  canTrash: boolean
  color: string | undefined
  connection: ColumnProps['connection']
  onClose: (() => void) | undefined
  transfer: ColumnTransfer
}) {
  const store = useColumnStore()
  const pathBar = useRef<PathBarHandle | null>(null)
  const pageSize = useRef(10)
  const rootRef = useRef<HTMLElement>(null)
  const [overlay, setOverlay] = useState<Overlay | null>(null)

  const error = useColumn((s) => s.error)
  const loading = useColumn((s) => s.loading)
  const listed = useColumn((s) => s.cwd !== null)
  const count = useColumn((s) => s.visible.length)
  const selectedCount = useColumn((s) => s.selected.size)
  const renaming = useColumn((s) => s.renaming)

  const dnd = useMemo(
    () => createColumnDnd(store, id, machineId, transfer),
    [store, id, machineId, transfer]
  )

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
    // No Trash here: Delete means delete, so confirm like Shift+Delete does.
    if (!canTrash) return deletePermanently()
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

  const selectedPaths = (): string[] =>
    store
      .getState()
      .selectedEntries()
      .map((e) => e.path)
  const copySelection = () => transfer.copy(machineId, selectedPaths())
  const cutSelection = () => transfer.cut(machineId, selectedPaths())
  /** Paste into the current folder, or into the folder the menu was opened on. */
  const pasteInto = (dir?: string) => {
    const target = dir ?? store.getState().cwd
    if (target !== null) transfer.paste({ machineId, dir: target })
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
        {
          label: 'Paste',
          shortcut: 'Ctrl+V',
          disabled: !transfer.canPaste,
          onSelect: () => pasteInto()
        },
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
      { label: 'Cut', shortcut: 'Ctrl+X', onSelect: cutSelection },
      { label: 'Copy', shortcut: 'Ctrl+C', onSelect: copySelection },
      {
        label: one && isDirLike(one) ? 'Paste Into Folder' : 'Paste',
        shortcut: 'Ctrl+V',
        disabled: !transfer.canPaste,
        onSelect: () => pasteInto(one && isDirLike(one) ? one.path : undefined)
      },
      { separator: true },
      { label: 'Rename', shortcut: 'F2', disabled: !one, onSelect: () => s.startRename(one?.path) },
      ...(canTrash
        ? [
            {
              label: items ? `Move ${items} to Trash` : 'Move to Trash',
              shortcut: 'Del',
              onSelect: trash
            } satisfies MenuItem
          ]
        : []),
      {
        label: items ? `Delete ${items}…` : 'Delete…',
        shortcut: canTrash ? 'Shift+Del' : 'Del',
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
          transfer.cancelCut()
          return true
        case 'c':
          if (!mod) return false
          copySelection()
          return true
        case 'x':
          if (!mod) return false
          cutSelection()
          return true
        case 'v':
          if (!mod) return false
          pasteInto()
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
      <header
        className={styles.title}
        data-column-header={id}
        draggable
        title="Drag to reorder"
        style={color ? { boxShadow: `inset 0 3px 0 ${color}` } : undefined}
      >
        {connection && <StatusDot status={connection.state?.status} />}
        <span className={styles.titleText}>{title}</span>
        {onClose && (
          <button
            className={styles.close}
            onClick={onClose}
            aria-label={`Close ${title}`}
            title="Close column"
          >
            ×
          </button>
        )}
      </header>
      {connection &&
        connection.state?.status !== 'connected' &&
        connection.state?.status !== 'connecting' && (
          <ConnectionBanner state={connection.state} onReconnect={connection.reconnect} />
        )}
      <PathBar handleRef={pathBar} />
      <div className={styles.progress} data-busy={loading} role="presentation" />
      {error && (
        <div className={styles.error} role="alert">
          <span>{error.message}</span>
          <span className={styles.errorActions}>
            <button
              onClick={() => {
                const s = store.getState()
                s.clearError()
                void (listed ? s.refresh() : s.init())
              }}
            >
              Retry
            </button>
            <button onClick={() => store.getState().clearError()} aria-label="Dismiss">
              ×
            </button>
          </span>
        </div>
      )}
      <FileList
        pageSizeRef={pageSize}
        onContextMenu={onContextMenu}
        dnd={dnd}
        cutPaths={transfer.cutPaths}
      />
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
          {...(canTrash ? {} : { machineName: title })}
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

function ConnectionBanner({
  state,
  onReconnect
}: {
  state: ConnectionState | undefined
  onReconnect(): void
}) {
  const reconnecting = state?.status === 'reconnecting'
  return (
    <div className={styles.banner} role="status">
      <span>
        {reconnecting
          ? `Connection lost. Reconnecting${state?.attempt ? ` (attempt ${state.attempt})` : ''}…`
          : `Disconnected${state?.error ? `: ${state.error}` : ''}`}
      </span>
      {!reconnecting && <button onClick={onReconnect}>Reconnect</button>}
    </div>
  )
}
