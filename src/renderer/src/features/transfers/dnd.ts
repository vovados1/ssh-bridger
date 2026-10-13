import type { MachineId } from '@shared/fs-types'

/** Marks a drag that started on one of our file rows. */
export const ITEMS_MIME = 'application/x-sshbridger-items'
/** Marks a drag of a whole column header, for reordering. */
export const COLUMN_MIME = 'application/x-sshbridger-column'

/** The part of the browser's DataTransfer we use, so this module also runs under plain Node in tests. */
export interface DragData {
  readonly types: readonly string[]
  getData(type: string): string
  setData(type: string, value: string): void
  effectAllowed: string
}

export interface DragPayload {
  machineId: MachineId
  paths: string[]
  /** The column the drag started in. */
  columnId: string
}

/**
 * The drag in progress inside this window. `dataTransfer` contents can't be read while the
 * pointer is still moving (only on drop), but the cursor must show copy/move/not-allowed as it
 * hovers, so the payload is also kept here.
 */
let current: DragPayload | null = null

export function beginDrag(dt: DragData, payload: DragPayload): void {
  current = payload
  dt.setData(ITEMS_MIME, JSON.stringify(payload))
  dt.setData('text/plain', payload.paths.join('\n'))
  dt.effectAllowed = 'copyMove'
}

export function endDrag(): void {
  current = null
}

export type DragInfo =
  | { kind: 'internal'; payload: DragPayload }
  /** Files dragged in from the desktop. */
  | { kind: 'os' }

/** What is being dragged over us, or null if it is not something we accept. */
export function describeDrag(dt: DragData | null): DragInfo | null {
  if (!dt) return null
  if (current && dt.types.includes(ITEMS_MIME)) return { kind: 'internal', payload: current }
  if (dt.types.includes('Files')) return { kind: 'os' }
  return null
}

/** The payload of a completed drop (read from the event, not from module state). */
export function readPayload(dt: DragData): DragPayload | null {
  try {
    const raw = dt.getData(ITEMS_MIME)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DragPayload>
    if (
      typeof parsed.machineId !== 'string' ||
      !Array.isArray(parsed.paths) ||
      typeof parsed.columnId !== 'string'
    ) {
      return null
    }
    return {
      machineId: parsed.machineId as MachineId,
      paths: parsed.paths.map(String),
      columnId: parsed.columnId
    }
  } catch {
    return null
  }
}

export type DropMode = 'copy' | 'move'

/**
 * Within one machine dropping moves (like a file manager); between machines it copies.
 * Ctrl forces a copy and Shift forces a move. Files from the desktop are always copied.
 */
export function chooseMode(
  info: DragInfo,
  destMachineId: MachineId,
  keys: { ctrlKey: boolean; shiftKey: boolean }
): DropMode {
  if (info.kind === 'os') return 'copy'
  if (keys.ctrlKey) return 'copy'
  if (keys.shiftKey) return 'move'
  return info.payload.machineId === destMachineId ? 'move' : 'copy'
}

/** Whether dropping `info` into `destDir` could do anything useful. */
export function canDrop(
  info: DragInfo,
  destMachineId: MachineId,
  destDir: string,
  mode: DropMode
): boolean {
  if (info.kind === 'os') return true
  const { payload } = info
  if (payload.machineId !== destMachineId) return true
  for (const path of payload.paths) {
    // A folder cannot go into itself or something inside it.
    if (destDir === path || destDir.startsWith(path + '/')) return false
  }
  // Moving things to the folder they are already in does nothing.
  if (
    mode === 'move' &&
    payload.paths.every(
      (p) =>
        p.slice(0, p.lastIndexOf('/')) === destDir || (p.lastIndexOf('/') === 0 && destDir === '/')
    )
  ) {
    return false
  }
  return true
}
