import type { Layout } from '@shared/layout'
import type {
  ConflictAnswer,
  ConflictPrompt,
  JobSnapshot,
  TransferRequest
} from '@shared/transfers'

/** What the renderer needs from main for transfers and the saved layout. Faked in tests. */
export interface TransfersClient {
  start(request: TransferRequest): Promise<string>
  cancel(jobId: string): Promise<void>
  resolve(conflictId: string, answer: ConflictAnswer): Promise<void>
  retry(jobId: string): Promise<string>
  clear(jobId?: string): Promise<void>
  list(): Promise<JobSnapshot[]>
  /** Real paths of files dragged in from the desktop. */
  pathsForFiles(files: File[]): string[]

  onUpdate(listener: (jobs: JobSnapshot[]) => void): () => void
  onConflict(listener: (prompt: ConflictPrompt) => void): () => void
  onConflictCancel(listener: (conflictId: string) => void): () => void

  loadLayout(): Promise<Layout | null>
  saveLayout(layout: Layout): Promise<void>
}
