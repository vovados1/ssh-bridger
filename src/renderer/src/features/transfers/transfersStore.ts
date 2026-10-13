import { createStore, type StoreApi } from 'zustand/vanilla'
import { FsError, type MachineId } from '@shared/fs-types'
import {
  ACTIVE_STATUSES,
  type ConflictAnswer,
  type ConflictPrompt,
  type JobSnapshot
} from '@shared/transfers'
import type { TransfersClient } from '../../lib/transfers-client'
import type { Notify } from '../../lib/toasts'

export interface Clipboard {
  machineId: MachineId
  paths: string[]
  /** `cut` items are moved on paste and shown dimmed until then. */
  mode: 'copy' | 'cut'
}

export interface TransfersState {
  /** Oldest first. */
  jobs: JobSnapshot[]
  /** Questions waiting for the user, oldest first; the UI shows the first. */
  conflicts: ConflictPrompt[]
  panelOpen: boolean
  clipboard: Clipboard | null

  init(): Promise<void>
  dispose(): void
  /** Start copying or moving; failures to even start are reported as toasts. */
  start(request: {
    source: { machineId: MachineId; paths: string[] }
    dest: { machineId: MachineId; dir: string }
    mode: 'copy' | 'move'
  }): Promise<void>
  cancel(jobId: string): void
  retry(jobId: string): Promise<void>
  /** Remove finished jobs from the list (one, or all of them). */
  clear(jobId?: string): void
  resolveConflict(conflictId: string, answer: ConflictAnswer): void
  /** Cancel the job a question belongs to. */
  abandonConflict(conflictId: string): void
  setPanelOpen(open: boolean): void

  copy(machineId: MachineId, paths: string[]): void
  cut(machineId: MachineId, paths: string[]): void
  clearClipboard(): void
  /** Paste the clipboard into `dest`. Resolves false when there is nothing to paste. */
  paste(dest: { machineId: MachineId; dir: string }): Promise<boolean>
}

export type TransfersStore = StoreApi<TransfersState>

export const isActive = (job: JobSnapshot): boolean => ACTIVE_STATUSES.includes(job.status)

export function createTransfersStore(client: TransfersClient, notify: Notify): TransfersStore {
  let unsubscribers: (() => void)[] = []

  const report = (err: unknown): void => {
    notify({
      kind: 'error',
      message: err instanceof FsError || err instanceof Error ? err.message : String(err)
    })
  }

  return createStore<TransfersState>()((set, get) => ({
    jobs: [],
    conflicts: [],
    panelOpen: false,
    clipboard: null,

    async init() {
      get().dispose()
      unsubscribers = [
        client.onUpdate((updates) => {
          const known = new Map(get().jobs.map((j) => [j.id, j]))
          for (const u of updates) known.set(u.id, u)
          set({ jobs: [...known.values()].sort((a, b) => a.startedAt - b.startedAt) })
        }),
        client.onConflict((prompt) => set({ conflicts: [...get().conflicts, prompt] })),
        client.onConflictCancel((id) =>
          set({ conflicts: get().conflicts.filter((c) => c.id !== id) })
        )
      ]
      set({ jobs: (await client.list()).sort((a, b) => a.startedAt - b.startedAt) })
    },

    dispose() {
      for (const off of unsubscribers) off()
      unsubscribers = []
    },

    async start(request) {
      try {
        await client.start(request)
        set({ panelOpen: true })
      } catch (err) {
        report(err)
      }
    },

    cancel(jobId) {
      void client.cancel(jobId).catch(report)
    },

    async retry(jobId) {
      try {
        await client.retry(jobId)
        set({ jobs: get().jobs.filter((j) => j.id !== jobId), panelOpen: true })
      } catch (err) {
        report(err)
      }
    },

    clear(jobId) {
      set({
        jobs: get().jobs.filter((j) => isActive(j) || (jobId !== undefined && j.id !== jobId))
      })
      void client.clear(jobId).catch(report)
    },

    resolveConflict(conflictId, answer) {
      set({ conflicts: get().conflicts.filter((c) => c.id !== conflictId) })
      void client.resolve(conflictId, answer).catch(report)
    },

    abandonConflict(conflictId) {
      const conflict = get().conflicts.find((c) => c.id === conflictId)
      set({ conflicts: get().conflicts.filter((c) => c.id !== conflictId) })
      if (conflict) get().cancel(conflict.jobId)
    },

    setPanelOpen(open) {
      set({ panelOpen: open })
    },

    copy(machineId, paths) {
      set({ clipboard: paths.length > 0 ? { machineId, paths, mode: 'copy' } : null })
    },

    cut(machineId, paths) {
      set({ clipboard: paths.length > 0 ? { machineId, paths, mode: 'cut' } : null })
    },

    clearClipboard() {
      set({ clipboard: null })
    },

    async paste(dest) {
      const clip = get().clipboard
      if (!clip) return false
      // A cut is a one-shot: whatever happens next, the items are no longer "waiting to move".
      if (clip.mode === 'cut') set({ clipboard: null })
      await get().start({
        source: { machineId: clip.machineId, paths: clip.paths },
        dest,
        mode: clip.mode === 'cut' ? 'move' : 'copy'
      })
      return true
    }
  }))
}
