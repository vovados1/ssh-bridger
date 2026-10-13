import type { MachineId } from './fs-types'

/** The columns on screen, saved so the next launch looks the same. */
export interface LayoutColumn {
  id: string
  machineId: MachineId
  /** Set for SSH columns; they come back disconnected until you reconnect. */
  profileId?: string
  /** Last folder shown. */
  cwd?: string
  /** Width in CSS pixels. */
  width?: number
  showHidden?: boolean
  sortKey?: 'name' | 'size' | 'mtime' | 'mode'
  sortDir?: 'asc' | 'desc'
}

export interface Layout {
  columns: LayoutColumn[]
}

export const DEFAULT_COLUMN_WIDTH = 420
export const MIN_COLUMN_WIDTH = 260
