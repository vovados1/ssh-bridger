import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { MachineId } from '@shared/fs-types'
import type {
  ConflictAnswer,
  ConflictPrompt,
  JobSnapshot,
  TransferRequest
} from '@shared/transfers'
import { LocalProvider } from '../../src/main/fs/local-provider'
import type { FileSystemProvider } from '../../src/main/fs/provider'
import {
  DEFAULT_LIMITS,
  TransferManager,
  type TransferDeps,
  type TransferLimits
} from '../../src/main/transfer/transfer-manager'

/** A second "machine" that is really the local disk, so every cross-machine code path runs. */
export class FakeRemote extends LocalProvider {
  override readonly id: MachineId = 'ssh:fake'
}

export const FINISHED = ['done', 'error', 'cancelled']

export interface Harness {
  root: string
  mgr: TransferManager
  updates: JobSnapshot[][]
  conflicts: ConflictPrompt[]
  cancelledConflicts: string[]
  providers: Record<string, FileSystemProvider>
  /** Start a job and wait for it to finish. */
  run(request: TransferRequest, ms?: number): Promise<JobSnapshot>
  /** Wait until a job reaches a status (or any finished one). */
  waitFor(jobId: string, predicate: (j: JobSnapshot) => boolean, ms?: number): Promise<JobSnapshot>
  /** Answer the next conflict(s) as they arrive. */
  autoAnswer(answers: ConflictAnswer[]): void
  /** Live limits; change them and call `mgr.limitsChanged()`. */
  limits: TransferLimits
  cleanup(): Promise<void>
}

export interface HarnessOptions
  extends Partial<Omit<TransferDeps, 'machines' | 'limits'>>, Partial<TransferLimits> {
  /** Replace the providers, e.g. with wrappers that misbehave. */
  wrap?(local: LocalProvider, remote: FakeRemote): Record<string, FileSystemProvider>
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'bridger-xfer-'))
  const local = new LocalProvider()
  const remote = new FakeRemote()
  const providers = options.wrap ? options.wrap(local, remote) : { local, 'ssh:fake': remote }

  const updates: JobSnapshot[][] = []
  const conflicts: ConflictPrompt[] = []
  const cancelledConflicts: string[] = []
  let answers: ConflictAnswer[] = []

  const limits: TransferLimits = { ...DEFAULT_LIMITS }
  const deps: Record<string, unknown> = { ...options }
  delete deps['wrap']
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof TransferLimits)[]) {
    if (key in deps) {
      ;(limits as unknown as Record<string, unknown>)[key] = deps[key]
      delete deps[key]
    }
  }
  const mgr: TransferManager = new TransferManager({
    machines: {
      get(id) {
        const p = providers[id]
        if (!p) throw new Error(`no machine ${id}`)
        return p
      }
    },
    emitUpdate: (jobs) => updates.push(jobs),
    emitConflict: (prompt) => {
      conflicts.push(prompt)
      const answer = answers.shift()
      if (answer) setTimeout(() => mgr.resolveConflict(prompt.id, answer), 0)
    },
    emitConflictCancel: (id) => cancelledConflicts.push(id),
    flushMs: 20,
    limits: () => limits,
    ...deps
  })

  const waitFor: Harness['waitFor'] = async (jobId, predicate, ms = 8000) => {
    const end = Date.now() + ms
    for (;;) {
      const job = mgr.list().find((j) => j.id === jobId)
      if (job && predicate(job)) return job
      if (Date.now() > end) throw new Error(`timed out; job is ${JSON.stringify(job)}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  return {
    root,
    mgr,
    limits,
    updates,
    conflicts,
    cancelledConflicts,
    providers,
    waitFor,
    run: async (request, ms) =>
      waitFor(await mgr.start(request), (j) => FINISHED.includes(j.status), ms),
    autoAnswer: (list) => {
      answers = [...list]
    },
    cleanup: async () => {
      mgr.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  }
}

/** Create a tree of files under `base`: `{ 'a/b.txt': 'content', 'dir/': null }`. */
export async function makeTree(base: string, tree: Record<string, string | null>): Promise<void> {
  for (const [path, content] of Object.entries(tree)) {
    const full = join(base, path)
    if (content === null) await mkdir(full, { recursive: true })
    else {
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, content)
    }
  }
}

/** All files and folders under `dir` as sorted relative paths (folders end in /). */
export async function listTree(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      out.push(`${prefix}${e.name}/`, ...(await listTree(join(dir, e.name), `${prefix}${e.name}/`)))
    } else out.push(`${prefix}${e.name}`)
  }
  return out.sort()
}

export const read = (path: string): Promise<string> => readFile(path, 'utf8')
export { mkdir, symlink, utimes, writeFile }

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Wrap a provider so reads are slow, to make transfers long enough to cancel or observe. */
export function slowReads<T extends FileSystemProvider>(inner: T, chunkDelayMs: number): T {
  const proxy = Object.create(inner) as T
  proxy.openRead = async (path, opts) => {
    const source = await inner.openRead(path, opts)
    const { Readable } = await import('node:stream')
    return Readable.from(
      (async function* () {
        for await (const chunk of source) {
          await delay(chunkDelayMs)
          yield chunk
        }
      })()
    ) as Readable
  }
  return proxy
}

/** Track how many writes are open at once. */
export function trackWrites<T extends FileSystemProvider>(
  inner: T,
  stats: { open: number; max: number }
): T {
  const proxy = Object.create(inner) as T
  proxy.openWrite = async (path, opts) => {
    const out: Writable = await inner.openWrite(path, opts)
    stats.open++
    stats.max = Math.max(stats.max, stats.open)
    // Hold each file open a moment so overlapping copies are visible.
    const finalOriginal = out.end.bind(out)
    out.end = ((...args: unknown[]) => {
      setTimeout(() => (finalOriginal as (...a: unknown[]) => unknown)(...args), 30)
      return out
    }) as typeof out.end
    out.once('close', () => stats.open--)
    return out
  }
  return proxy
}
