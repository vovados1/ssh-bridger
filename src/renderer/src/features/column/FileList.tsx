import { memo, useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { isDirLike, type Entry } from '@shared/fs-types'
import { useColumn, useColumnStore } from './ColumnContext'
import { formatDate, formatMode, formatSize } from './format'
import { EntryIcon } from './icons'
import { RenameInput } from './RenameInput'
import type { ColumnDnd } from './useColumnDnd'
import type { SortKey } from './sort'
import styles from './FileList.module.css'

export const ROW_HEIGHT = 28

const HEADERS: { key: SortKey; label: string; className: string }[] = [
  { key: 'name', label: 'Name', className: styles.colName! },
  { key: 'size', label: 'Size', className: styles.colSize! },
  { key: 'mtime', label: 'Modified', className: styles.colDate! },
  { key: 'mode', label: 'Permissions', className: styles.colMode! }
]

interface RowProps {
  entry: Entry
  top: number
  selected: boolean
  cursor: boolean
  renaming: boolean
  /** Cut and waiting to be pasted. */
  cut: boolean
  /** A drag is hovering over this folder and would drop into it. */
  dropTarget: boolean
  onDragStart(e: DragEvent, entry: Entry): void
  onDragEnd(): void
  onDragOverFolder(e: DragEvent, entry: Entry): void
  onDragLeaveFolder(e: DragEvent, entry: Entry): void
  onDropOnFolder(e: DragEvent, entry: Entry): void
  onClick(e: MouseEvent, entry: Entry): void
  onOpen(entry: Entry): void
  onContextMenu(e: MouseEvent, entry: Entry): void
  onRenameCommit(name: string): Promise<boolean>
  onRenameCancel(): void
}

const Row = memo(function Row({
  entry,
  top,
  selected,
  cursor,
  renaming,
  cut,
  dropTarget,
  onDragStart,
  onDragEnd,
  onDragOverFolder,
  onDragLeaveFolder,
  onDropOnFolder,
  onClick,
  onOpen,
  onContextMenu,
  onRenameCommit,
  onRenameCancel
}: RowProps) {
  const dir = isDirLike(entry)
  const broken = entry.type === 'symlink' && entry.linkTargetType === 'broken'
  return (
    <div
      role="option"
      id={rowId(entry.path)}
      aria-selected={selected}
      className={styles.row}
      data-selected={selected}
      data-cursor={cursor}
      data-dir={dir}
      data-broken={broken}
      data-cut={cut}
      data-drop={dropTarget}
      draggable={!renaming}
      onDragStart={(e) => onDragStart(e, entry)}
      onDragEnd={onDragEnd}
      onDragOver={dir ? (e) => onDragOverFolder(e, entry) : undefined}
      onDragLeave={dir ? (e) => onDragLeaveFolder(e, entry) : undefined}
      onDrop={dir ? (e) => onDropOnFolder(e, entry) : undefined}
      style={{ height: ROW_HEIGHT, transform: `translateY(${top}px)` }}
      onClick={(e) => onClick(e, entry)}
      onDoubleClick={() => onOpen(entry)}
      onContextMenu={(e) => {
        e.stopPropagation() // otherwise the list would also open its background menu
        onContextMenu(e, entry)
      }}
    >
      <span className={`${styles.cell} ${styles.colName}`}>
        <span className={styles.icon}>
          <EntryIcon entry={entry} />
        </span>
        {renaming ? (
          <RenameInput
            initial={entry.name}
            isDir={isDirLike(entry)}
            onCommit={onRenameCommit}
            onCancel={onRenameCancel}
          />
        ) : (
          <span className={styles.name} title={entry.name}>
            {entry.name}
          </span>
        )}
        {entry.type === 'symlink' && !renaming && (
          <span className={styles.link} title={entry.linkTarget}>
            → {entry.linkTarget ?? '?'}
            {broken && ' (broken)'}
          </span>
        )}
      </span>
      <span className={`${styles.cell} ${styles.colSize}`}>
        {entry.type === 'file' ? formatSize(entry.size) : ''}
      </span>
      <span className={`${styles.cell} ${styles.colDate}`}>{formatDate(entry.mtime)}</span>
      <span className={`${styles.cell} ${styles.colMode}`}>
        {formatMode(entry.type, entry.mode)}
      </span>
    </div>
  )
})

export function rowId(path: string): string {
  return 'row-' + encodeURIComponent(path)
}

interface FileListProps {
  pageSizeRef: { current: number }
  /** Right-click on a row (`entry`) or on empty space (`null`). */
  onContextMenu(e: MouseEvent, entry: Entry | null): void
  dnd: ColumnDnd
  /** Paths waiting to be pasted after a cut. */
  cutPaths: ReadonlySet<string>
}

export function FileList({ pageSizeRef, onContextMenu, dnd, cutPaths }: FileListProps) {
  const store = useColumnStore()
  const visible = useColumn((s) => s.visible)
  const selected = useColumn((s) => s.selected)
  const cursor = useColumn((s) => s.cursor)
  const sortKey = useColumn((s) => s.sortKey)
  const sortDir = useColumn((s) => s.sortDir)
  const cwd = useColumn((s) => s.cwd)
  const renaming = useColumn((s) => s.renaming)

  const scrollRef = useRef<HTMLDivElement>(null)
  // React Compiler is not used here, so its warning about TanStack Virtual's unmemoizable API is moot.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (i) => visible[i]?.path ?? i,
    // The sticky header sits above the rows inside the scroller.
    scrollPaddingStart: ROW_HEIGHT
  })

  // Keyboard paging needs to know how many rows fit; re-measured whenever the list re-renders.
  useEffect(() => {
    const viewportHeight = scrollRef.current?.clientHeight ?? 0
    pageSizeRef.current = Math.max(1, Math.floor((viewportHeight - ROW_HEIGHT) / ROW_HEIGHT) - 1)
  })

  // New folder: start at the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [cwd])

  // Keep the keyboard cursor on screen.
  useEffect(() => {
    if (cursor === null) return
    const index = store.getState().visible.findIndex((e) => e.path === cursor)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' })
  }, [cursor, store, virtualizer])

  const onClick = (e: MouseEvent, entry: Entry) => {
    const s = store.getState()
    if (e.shiftKey) s.selectRange(entry.path)
    else if (e.ctrlKey || e.metaKey) s.toggleSelect(entry.path)
    else s.selectOnly(entry.path)
  }
  const onOpen = (entry: Entry) => void store.getState().open(entry)
  const onRenameCommit = (name: string) => store.getState().commitRename(name)
  const onRenameCancel = () => store.getState().cancelRename()

  // Drag and drop: `dropOn` is the folder row (by path) or `'cwd'` for the empty area, while hovering.
  const [dropOn, setDropOn] = useState<string | null>(null)
  const onDragOverFolder = (e: DragEvent, entry: Entry) => {
    if (dnd.onDragOver(e, entry.path)) {
      e.stopPropagation() // a folder row wins over the list behind it
      setDropOn(entry.path)
    }
  }
  const onDragLeaveFolder = (e: DragEvent, entry: Entry) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) {
      setDropOn((cur) => (cur === entry.path ? null : cur))
    }
  }
  const onDropOnFolder = (e: DragEvent, entry: Entry) => {
    setDropOn(null)
    dnd.onDrop(e, entry.path)
  }

  return (
    <div
      ref={scrollRef}
      className={styles.scroller}
      role="listbox"
      aria-multiselectable
      aria-label="Files"
      aria-activedescendant={cursor ? rowId(cursor) : undefined}
      onClick={(e) => {
        if (e.target === e.currentTarget) store.getState().clearSelection()
      }}
      onContextMenu={(e) => onContextMenu(e, null)}
      data-drop={dropOn === 'cwd'}
      onDragOver={(e) => {
        if (cwd !== null && dnd.onDragOver(e, cwd)) setDropOn('cwd')
        else setDropOn(null)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn(null)
      }}
      onDrop={(e) => {
        setDropOn(null)
        if (cwd !== null) dnd.onDrop(e, cwd)
      }}
    >
      <div className={styles.header} role="presentation">
        {HEADERS.map((h) => (
          <button
            key={h.key}
            className={`${styles.headerCell} ${h.className}`}
            onClick={() => store.getState().setSort(h.key)}
          >
            {h.label}
            {sortKey === h.key && (
              <span className={styles.sortMark}>{sortDir === 'asc' ? '▲' : '▼'}</span>
            )}
          </button>
        ))}
      </div>
      <div className={styles.rows} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const entry = visible[item.index]
          if (!entry) return null
          return (
            <Row
              key={entry.path}
              entry={entry}
              top={item.start}
              selected={selected.has(entry.path)}
              cursor={cursor === entry.path}
              renaming={renaming === entry.path}
              cut={cutPaths.has(entry.path)}
              dropTarget={dropOn === entry.path}
              onDragStart={dnd.onDragStart}
              onDragEnd={dnd.onDragEnd}
              onDragOverFolder={onDragOverFolder}
              onDragLeaveFolder={onDragLeaveFolder}
              onDropOnFolder={onDropOnFolder}
              onClick={onClick}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
            />
          )
        })}
      </div>
      {visible.length === 0 && cwd !== null && (
        <div className={styles.empty}>This folder is empty</div>
      )}
    </div>
  )
}
