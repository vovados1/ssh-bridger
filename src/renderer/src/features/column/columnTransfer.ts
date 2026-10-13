import type { MachineId } from '@shared/fs-types'
import type { TransferRequest } from '@shared/transfers'

/**
 * What a column needs from the transfer system: the clipboard and a way to start copies and
 * moves. Injected so the column does not depend on global stores.
 */
export interface ColumnTransfer {
  /** Paths on this column's machine that are cut and waiting to be pasted (shown dimmed). */
  cutPaths: ReadonlySet<string>
  canPaste: boolean
  copy(machineId: MachineId, paths: string[]): void
  cut(machineId: MachineId, paths: string[]): void
  paste(dest: { machineId: MachineId; dir: string }): void
  /** Forget a pending cut (Escape). */
  cancelCut(): void
  start(request: TransferRequest): void
  /** Real paths of files dropped from the desktop. */
  pathsForFiles(files: File[]): string[]
}

export const NO_TRANSFER: ColumnTransfer = {
  cutPaths: new Set(),
  canPaste: false,
  copy: () => {},
  cut: () => {},
  paste: () => {},
  cancelCut: () => {},
  start: () => {},
  pathsForFiles: () => []
}
