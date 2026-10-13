import type { DragEvent } from 'react'
import type { Entry, MachineId } from '@shared/fs-types'
import {
  beginDrag,
  canDrop,
  chooseMode,
  describeDrag,
  endDrag,
  readPayload
} from '../transfers/dnd'
import type { ColumnStore } from './columnStore'
import type { ColumnTransfer } from './columnTransfer'

export interface ColumnDnd {
  onDragStart(e: DragEvent, entry: Entry): void
  onDragEnd(): void
  /** Called while hovering a drop target. Returns true (and shows the right cursor) if a drop would be accepted. */
  onDragOver(e: DragEvent, destDir: string): boolean
  onDrop(e: DragEvent, destDir: string): void
}

/** Drag items out of this column and drop items (or desktop files) into it. */
export function createColumnDnd(
  store: ColumnStore,
  columnId: string,
  machineId: MachineId,
  transfer: ColumnTransfer
): ColumnDnd {
  return {
    onDragStart(e, entry) {
      const s = store.getState()
      // Dragging an unselected row drags just that row; dragging a selected one drags the whole selection.
      if (!s.selected.has(entry.path)) s.selectOnly(entry.path)
      const paths = store
        .getState()
        .selectedEntries()
        .map((x) => x.path)
      beginDrag(e.dataTransfer, { machineId, paths, columnId })
    },

    onDragEnd() {
      endDrag()
    },

    onDragOver(e, destDir) {
      const info = describeDrag(e.dataTransfer)
      if (!info) return false
      const mode = chooseMode(info, machineId, e)
      if (!canDrop(info, machineId, destDir, mode)) return false
      e.preventDefault()
      e.dataTransfer.dropEffect = mode
      return true
    },

    onDrop(e, destDir) {
      const info = describeDrag(e.dataTransfer)
      endDrag()
      if (!info) return
      const mode = chooseMode(info, machineId, e)
      if (!canDrop(info, machineId, destDir, mode)) return
      e.preventDefault()
      e.stopPropagation()

      if (info.kind === 'os') {
        const paths = transfer.pathsForFiles(Array.from(e.dataTransfer.files))
        if (paths.length > 0) {
          transfer.start({
            source: { machineId: 'local', paths },
            dest: { machineId, dir: destDir },
            mode: 'copy'
          })
        }
        return
      }
      const payload = readPayload(e.dataTransfer) ?? info.payload
      transfer.start({
        source: { machineId: payload.machineId, paths: payload.paths },
        dest: { machineId, dir: destDir },
        mode
      })
    }
  }
}
