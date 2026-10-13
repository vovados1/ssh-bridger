import type { MachineId } from './fs-types'

/**
 * Types for copying and moving files between machines. Plain types only (no zod) so the
 * renderer can import them freely; the validation schemas live in transfer-schemas.ts.
 */

export type TransferMode = 'copy' | 'move'

export interface TransferRequest {
  /** Everything comes from one machine, as dragged out of one column. */
  source: { machineId: MachineId; paths: string[] }
  dest: { machineId: MachineId; dir: string }
  mode: TransferMode
}

/** What to do when the destination already has an item of that name. */
export type ConflictResolution = 'overwrite' | 'skip' | 'keepBoth' | 'overwriteIfNewer'

export type JobStatus =
  /** Waiting for a free slot. */
  | 'queued'
  /** Walking the source to count what there is to copy. */
  | 'scanning'
  | 'running'
  /** Paused on a question for the user. */
  | 'waiting'
  | 'done'
  /** Finished, but some items failed. */
  | 'error'
  | 'cancelled'

export const ACTIVE_STATUSES: readonly JobStatus[] = ['queued', 'scanning', 'running', 'waiting']

export interface JobError {
  /** Source path of the item that failed. */
  path: string
  message: string
}

export interface JobSnapshot {
  id: string
  mode: TransferMode
  status: JobStatus
  source: { machineId: MachineId; paths: string[] }
  dest: { machineId: MachineId; dir: string }
  filesTotal: number
  filesDone: number
  bytesTotal: number
  bytesDone: number
  /** Items the user chose to skip, or that were already up to date. */
  skipped: number
  /** Bytes per second, averaged over the last few seconds. */
  speed: number
  /** Seconds left at the current speed; null until it can be estimated. */
  etaSeconds: number | null
  /** File names being copied right now. */
  current: string[]
  /** The first failures (capped); `errorCount` has the real total. */
  errors: JobError[]
  errorCount: number
  startedAt: number
  finishedAt?: number
}

/** A question raised when a name is already taken at the destination. */
export interface ConflictPrompt {
  id: string
  jobId: string
  /** `type-mismatch`: a file would replace a folder or the other way round. */
  kind: 'file' | 'type-mismatch'
  name: string
  destMachineId: MachineId
  src: ConflictSide
  dst: ConflictSide
}

export interface ConflictSide {
  path: string
  type: 'file' | 'dir' | 'symlink' | 'other'
  size: number
  mtime: number
}

export interface ConflictAnswer {
  resolution: ConflictResolution
  /** Use this answer for the rest of the job's conflicts too. */
  applyToAll: boolean
}

/** Suffix of the temporary file a transfer writes before renaming it into place. */
export const PART_SUFFIX = '.sshbridger-part'
