import type { Layout } from '@shared/layout'
import type {
  ConflictAnswer,
  ConflictPrompt,
  JobSnapshot,
  TransferRequest
} from '@shared/transfers'
import type { TransfersClient } from '../../src/renderer/src/lib/transfers-client'

export interface FakeTransfers extends TransfersClient {
  started: TransferRequest[]
  cancelled: string[]
  resolved: { id: string; answer: ConflictAnswer }[]
  cleared: (string | undefined)[]
  retried: string[]
  jobs: JobSnapshot[]
  layout: Layout | null
  saved: Layout[]
  startResult: () => Promise<string>
  emitUpdate(jobs: JobSnapshot[]): void
  emitConflict(c: ConflictPrompt): void
  emitConflictCancel(id: string): void
}

export const job = (over: Partial<JobSnapshot> = {}): JobSnapshot => ({
  id: 'j1',
  mode: 'copy',
  status: 'running',
  source: { machineId: 'local', paths: ['/src/a.txt'] },
  dest: { machineId: 'ssh:s', dir: '/dst' },
  filesTotal: 1,
  filesDone: 0,
  bytesTotal: 100,
  bytesDone: 0,
  skipped: 0,
  speed: 0,
  etaSeconds: null,
  current: [],
  errors: [],
  errorCount: 0,
  startedAt: 1,
  ...over
})

export function fakeTransfers(): FakeTransfers {
  const update = new Set<(jobs: JobSnapshot[]) => void>()
  const conflict = new Set<(c: ConflictPrompt) => void>()
  const cancel = new Set<(id: string) => void>()
  let n = 0
  const fake: FakeTransfers = {
    started: [],
    cancelled: [],
    resolved: [],
    cleared: [],
    retried: [],
    jobs: [],
    layout: null,
    saved: [],
    startResult: async () => `job-${++n}`,
    start: async (r) => {
      const id = await fake.startResult()
      fake.started.push(r)
      return id
    },
    cancel: async (id) => void fake.cancelled.push(id),
    resolve: async (id, answer) => void fake.resolved.push({ id, answer }),
    retry: async (id) => {
      fake.retried.push(id)
      return `retry-${id}`
    },
    clear: async (id) => void fake.cleared.push(id),
    list: async () => fake.jobs,
    pathsForFiles: (files) => files.map((f) => `/os/${f.name}`),
    onUpdate: (l) => (update.add(l), () => update.delete(l)),
    onConflict: (l) => (conflict.add(l), () => conflict.delete(l)),
    onConflictCancel: (l) => (cancel.add(l), () => cancel.delete(l)),
    loadLayout: async () => fake.layout,
    saveLayout: async (l) => void fake.saved.push(l),
    emitUpdate: (jobs) => update.forEach((l) => l(jobs)),
    emitConflict: (c) => conflict.forEach((l) => l(c)),
    emitConflictCancel: (id) => cancel.forEach((l) => l(id))
  }
  return fake
}
