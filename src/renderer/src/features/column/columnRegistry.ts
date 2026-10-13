import type { MachineId } from '@shared/fs-types'
import type { ColumnStore } from './columnStore'

/**
 * Every mounted column, so something outside (a finished transfer) can ask the columns showing
 * a folder to reload it.
 */
const columns = new Map<string, { machineId: MachineId; store: ColumnStore }>()

export function registerColumn(id: string, machineId: MachineId, store: ColumnStore): () => void {
  columns.set(id, { machineId, store })
  return () => {
    if (columns.get(id)?.store === store) columns.delete(id)
  }
}

/** Reload every column showing `dir` on `machineId`. Returns how many were asked. */
export function refreshColumnsShowing(machineId: MachineId, dir: string): number {
  let asked = 0
  for (const c of columns.values()) {
    if (c.machineId === machineId && c.store.getState().cwd === dir) {
      void c.store.getState().refresh()
      asked++
    }
  }
  return asked
}
