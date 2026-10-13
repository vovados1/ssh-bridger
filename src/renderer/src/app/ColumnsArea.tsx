import {
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent
} from 'react'
import { MIN_COLUMN_WIDTH } from '@shared/layout'
import { Column } from '../features/column/Column'
import type { ColumnTransfer } from '../features/column/columnTransfer'
import { COLUMN_MIME } from '../features/transfers/dnd'
import { fsClient, transfersClient } from '../lib/api'
import { notify } from '../lib/toasts'
import {
  transfersStore,
  useConnections,
  useTransfers,
  useWorkspace,
  workspaceStore
} from './stores'
import type { WorkspaceColumn } from './workspaceStore'
import styles from './ColumnsArea.module.css'

const NO_PATHS: ReadonlySet<string> = new Set()

/** Where a dragged column would land: before or after the column with this id. */
interface DropSpot {
  id: string
  after: boolean
}

/** The side-by-side columns. Each has its own width; drag a header to reorder, a divider to resize. */
export function ColumnsArea() {
  const columns = useWorkspace((s) => s.columns)
  const [dragging, setDragging] = useState<string | null>(null)
  const [spot, setSpot] = useState<DropSpot | null>(null)

  const isColumnDrag = (e: DragEvent): boolean => e.dataTransfer.types.includes(COLUMN_MIME)

  const onDragStart = (e: DragEvent): void => {
    // Rows start drags too; only a column header reorders columns.
    const id = (e.target as HTMLElement).dataset['columnHeader']
    if (!id) return
    e.dataTransfer.setData(COLUMN_MIME, id)
    e.dataTransfer.effectAllowed = 'move'
    setDragging(id)
  }

  const onDragOver = (e: DragEvent): void => {
    if (!isColumnDrag(e)) return
    const slot = (e.target as HTMLElement).closest<HTMLElement>('[data-slot]')
    if (!slot) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = slot.getBoundingClientRect()
    setSpot({ id: slot.dataset['slot']!, after: e.clientX > rect.left + rect.width / 2 })
  }

  const onDrop = (e: DragEvent): void => {
    if (!isColumnDrag(e)) return
    e.preventDefault()
    const dragId = e.dataTransfer.getData(COLUMN_MIME)
    if (spot && dragId) {
      const ids = columns.map((c) => c.id)
      let to = ids.indexOf(spot.id) + (spot.after ? 1 : 0)
      if (ids.indexOf(dragId) < to) to-- // removing the dragged column shifts everything after it
      workspaceStore.getState().moveColumn(dragId, to)
    }
    setDragging(null)
    setSpot(null)
  }

  return (
    <div
      className={styles.area}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={() => {
        setDragging(null)
        setSpot(null)
      }}
    >
      {columns.map((c, i) => (
        <ColumnSlot
          key={c.id}
          column={c}
          last={i === columns.length - 1}
          dragging={dragging === c.id}
          dropSide={
            spot?.id === c.id && dragging !== c.id ? (spot.after ? 'after' : 'before') : undefined
          }
        />
      ))}
    </div>
  )
}

function ColumnSlot({
  column: c,
  last,
  dragging,
  dropSide
}: {
  column: WorkspaceColumn
  last: boolean
  dragging: boolean
  dropSide: 'before' | 'after' | undefined
}) {
  const states = useConnections((s) => s.states)
  const clipboard = useTransfers((s) => s.clipboard)
  const profileId = c.profileId

  // Items cut on this column's machine are dimmed here; elsewhere a cut means nothing.
  const cutPaths = useMemo(
    () =>
      clipboard?.mode === 'cut' && clipboard.machineId === c.machineId
        ? new Set(clipboard.paths)
        : NO_PATHS,
    [clipboard, c.machineId]
  )
  const canPaste = clipboard !== null
  const transfer = useMemo<ColumnTransfer>(() => {
    const t = transfersStore.getState()
    return {
      cutPaths,
      canPaste,
      copy: t.copy,
      cut: t.cut,
      paste: (dest) => void transfersStore.getState().paste(dest),
      cancelCut: () => {
        if (transfersStore.getState().clipboard?.mode === 'cut')
          transfersStore.getState().clearClipboard()
      },
      start: (request) => void transfersStore.getState().start(request),
      pathsForFiles: transfersClient.pathsForFiles
    }
  }, [cutPaths, canPaste])

  return (
    <>
      <div
        className={styles.slot}
        data-slot={c.id}
        data-dragging={dragging}
        data-drop-side={dropSide}
        style={{ flex: last ? `1 0 ${c.width}px` : `0 0 ${c.width}px` }}
      >
        <Column
          id={c.id}
          machineId={c.machineId}
          title={c.title}
          fs={fsClient}
          notify={notify}
          canTrash={profileId === undefined}
          transfer={transfer}
          {...(c.color ? { color: c.color } : {})}
          {...(c.initial ? { initial: c.initial } : {})}
          onViewChange={(view) => workspaceStore.getState().updateColumnView(c.id, view)}
          {...(profileId === undefined
            ? {}
            : {
                connection: {
                  state: states[profileId],
                  reconnect: () => void workspaceStore.getState().reconnect(profileId)
                }
              })}
          onClose={() => workspaceStore.getState().closeColumn(c.id)}
        />
      </div>
      {!last && (
        <Splitter
          width={c.width}
          onResize={(w) => workspaceStore.getState().setColumnWidth(c.id, w)}
        />
      )}
    </>
  )
}

/** The divider after a column: drag it (or use the arrow keys) to change that column's width. */
function Splitter({ width, onResize }: { width: number; onResize(width: number): void }) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  const down = (e: PointerEvent<HTMLDivElement>): void => {
    drag.current = { startX: e.clientX, startWidth: width }
    try {
      // Keep receiving moves when the pointer leaves the thin divider.
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* some synthetic pointers can't be captured; dragging still works while over the divider */
    }
  }
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    if (drag.current) onResize(drag.current.startWidth + (e.clientX - drag.current.startX))
  }
  const up = (e: PointerEvent<HTMLDivElement>): void => {
    drag.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* not captured */
    }
  }
  const key = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 64 : 16
    if (e.key === 'ArrowLeft') onResize(width - step)
    else if (e.key === 'ArrowRight') onResize(width + step)
    else return
    e.preventDefault()
  }

  return (
    <div
      className={styles.splitter}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      aria-valuenow={width}
      aria-valuemin={MIN_COLUMN_WIDTH}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
    />
  )
}
