import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { FsError, type Entry } from '@shared/fs-types'
import { joinPath, parentOf } from '@shared/posix-path'
import {
  PART_SUFFIX,
  type ConflictAnswer,
  type ConflictPrompt,
  type ConflictResolution,
  type ConflictSide,
  type JobError,
  type JobSnapshot,
  type JobStatus,
  type TransferRequest
} from '@shared/transfers'
import { toFsError } from '../fs/errors'
import type { MachineRegistry } from '../fs/registry'
import type { FileSystemProvider } from '../fs/provider'
import { uniqueCopyName } from './copy-name'
import { Semaphore } from './semaphore'
import { SpeedMeter } from './speed-meter'

export interface TransferDeps {
  machines: Pick<MachineRegistry, 'get'>
  emitUpdate(jobs: JobSnapshot[]): void
  emitConflict(prompt: ConflictPrompt): void
  emitConflictCancel(id: string): void
  now?: () => number
  /** Files copied at once within one job. */
  perJobConcurrency?: number
  /** Files copied at once across all jobs, so a pile of jobs can't saturate a connection. */
  globalConcurrency?: number
  /** Jobs running at once; the rest wait in the queue. */
  maxRunningJobs?: number
  /** Progress events are batched to at most one per this many ms. */
  flushMs?: number
  /** Keep permissions and modification times on copies. */
  preserveAttributes?: boolean
}

const MAX_REPORTED_ERRORS = 50
/** Files this close in modification time count as the same version (SFTP times are whole seconds). */
const SAME_TIME_TOLERANCE_MS = 2000

interface PendingConflict {
  prompt: ConflictPrompt
  resolve(answer: ConflictAnswer): void
  reject(reason: unknown): void
}

class Job {
  status: JobStatus = 'queued'
  readonly controller = new AbortController()
  filesTotal = 0
  filesDone = 0
  bytesTotal = 0
  bytesDone = 0
  skipped = 0
  errors: JobError[] = []
  errorCount = 0
  readonly current = new Set<string>()
  /** "Apply to all" answer, used for every later conflict in this job. */
  policy: ConflictResolution | undefined
  readonly conflicts = new Map<string, PendingConflict>()
  readonly speed = new SpeedMeter()
  readonly startedAt: number
  finishedAt: number | undefined
  /** Per source path: how much there is under it, for crediting a whole-folder rename at once. */
  readonly subtree = new Map<string, { files: number; bytes: number }>()

  constructor(
    readonly id: string,
    readonly request: TransferRequest,
    readonly autoSkipIdentical: boolean,
    now: number
  ) {
    this.startedAt = now
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  fail(path: string, err: unknown): void {
    this.errorCount++
    if (this.errors.length < MAX_REPORTED_ERRORS) {
      this.errors.push({ path, message: toFsError(err, path).message })
    }
  }
}

interface Ctx {
  job: Job
  src: FileSystemProvider
  dst: FileSystemProvider
  /** Source and destination are the same machine, so renames are possible. */
  same: boolean
  move: boolean
  pool: TaskPool
  /** Folders to give their permissions and times once their contents are in place. */
  finalizers: { path: string; mode: number; mtime: number }[]
  /** Source folders to remove after a move, deepest first. */
  emptied: string[]
}

/** Runs file copies with a per-job and a global limit, without blocking the folder walk more than needed. */
class TaskPool {
  private readonly local: Semaphore
  private readonly running = new Set<Promise<void>>()

  constructor(
    limit: number,
    private readonly global: Semaphore,
    private readonly signal: AbortSignal
  ) {
    this.local = new Semaphore(limit)
  }

  /** Resolves when a slot is free and `fn` has been started; `fn` keeps running in the background. */
  async start(fn: () => Promise<void>): Promise<void> {
    await this.local.acquire(this.signal)
    try {
      await this.global.acquire(this.signal)
    } catch (err) {
      this.local.release()
      throw err
    }
    const task = fn()
      .catch(() => {})
      .finally(() => {
        this.global.release()
        this.local.release()
        this.running.delete(task)
      })
    this.running.add(task)
  }

  async drain(): Promise<void> {
    await Promise.all([...this.running])
  }
}

const aborted = (job: Job): boolean => job.signal.aborted

/**
 * Copies and moves files between any two machines.
 *
 * A job is one drop or paste. It first scans the sources to know the totals, then walks them
 * folder by folder, copying files in parallel. Every file is written to a temporary
 * `.sshbridger-part` name, checked, given its permissions and times, and only then renamed
 * into place, so a cancelled or crashed transfer never leaves a half-written file under the
 * real name. A move across machines deletes each source file only after its copy is verified.
 */
export class TransferManager {
  private readonly jobs = new Map<string, Job>()
  private readonly dirty = new Set<Job>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private readonly global: Semaphore
  private runningJobs = 0
  private readonly queue: Job[] = []
  private readonly now: () => number

  constructor(private readonly deps: TransferDeps) {
    this.global = new Semaphore(deps.globalConcurrency ?? 6)
    this.now = deps.now ?? Date.now
  }

  // ---- public API --------------------------------------------------------------------------

  /** Queue a job. Rejects if either machine is unavailable or the destination is not a folder. */
  async start(
    request: TransferRequest,
    options: { autoSkipIdentical?: boolean } = {}
  ): Promise<string> {
    this.deps.machines.get(request.source.machineId) // fail now if the source is not connected
    const dst = this.deps.machines.get(request.dest.machineId)
    const dest = await dst.stat(request.dest.dir)
    if (dest.type !== 'dir' && !(dest.type === 'symlink' && dest.linkTargetType === 'dir')) {
      throw new FsError({
        code: 'ENOTDIR',
        path: request.dest.dir,
        message: `"${request.dest.dir}" is not a folder`
      })
    }
    const job = new Job(randomUUID(), request, options.autoSkipIdentical ?? false, this.now())
    this.jobs.set(job.id, job)
    this.queue.push(job)
    this.markDirty(job)
    this.pump()
    return job.id
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job || this.isFinished(job)) return
    job.controller.abort(new Error('Cancelled'))
    // A job waiting on a question would otherwise wait forever: nobody will answer it now.
    this.rejectConflicts(job)
    // A queued job never reaches `run`, so finish it here.
    const queued = this.queue.indexOf(job)
    if (queued >= 0) {
      this.queue.splice(queued, 1)
      this.finish(job)
    }
  }

  resolveConflict(conflictId: string, requested: ConflictAnswer): void {
    let answer = requested
    for (const job of this.jobs.values()) {
      const pending = job.conflicts.get(conflictId)
      if (!pending) continue
      job.conflicts.delete(conflictId)
      // A file can never replace a folder (or the reverse), whatever the renderer sends.
      if (
        pending.prompt.kind === 'type-mismatch' &&
        (answer.resolution === 'overwrite' || answer.resolution === 'overwriteIfNewer')
      ) {
        answer = { resolution: 'skip', applyToAll: false }
      }
      if (answer.applyToAll) {
        job.policy = answer.resolution
        // Anything else waiting on a question this answer settles is moot now.
        for (const [id, other] of [...job.conflicts]) {
          if (other.prompt.kind === 'file') {
            job.conflicts.delete(id)
            this.deps.emitConflictCancel(id)
            other.resolve(answer)
          }
        }
      }
      if (job.conflicts.size === 0 && job.status === 'waiting') this.setStatus(job, 'running')
      pending.resolve(answer)
      return
    }
  }

  /** Run a finished job again; files that are already up to date are skipped. */
  async retry(jobId: string): Promise<string> {
    const old = this.jobs.get(jobId)
    if (!old) throw new FsError({ code: 'EUNKNOWN', message: 'That transfer is no longer listed' })
    this.jobs.delete(jobId)
    this.deps.emitUpdate([
      { ...this.snapshot(old), status: old.status, removed: true } as JobSnapshot
    ])
    return this.start(old.request, { autoSkipIdentical: true })
  }

  /** Forget finished jobs (one, or all of them). */
  clear(jobId?: string): void {
    for (const job of [...this.jobs.values()]) {
      if ((jobId === undefined || job.id === jobId) && this.isFinished(job))
        this.jobs.delete(job.id)
    }
  }

  list(): JobSnapshot[] {
    return [...this.jobs.values()].map((j) => this.snapshot(j))
  }

  /** Cancel everything, e.g. when the app quits. */
  shutdown(): void {
    for (const job of this.jobs.values()) this.cancel(job.id)
  }

  // ---- scheduling --------------------------------------------------------------------------

  private pump(): void {
    const limit = this.deps.maxRunningJobs ?? 2
    while (this.runningJobs < limit && this.queue.length > 0) {
      const job = this.queue.shift()!
      if (aborted(job)) continue
      this.runningJobs++
      void this.run(job).finally(() => {
        this.runningJobs--
        this.pump()
      })
    }
  }

  private async run(job: Job): Promise<void> {
    const { request } = job
    const src = this.deps.machines.get(request.source.machineId)
    const dst = this.deps.machines.get(request.dest.machineId)
    const ctx: Ctx = {
      job,
      src,
      dst,
      same: request.source.machineId === request.dest.machineId,
      move: request.mode === 'move',
      pool: new TaskPool(this.deps.perJobConcurrency ?? 3, this.global, job.signal),
      finalizers: [],
      emptied: []
    }

    try {
      this.setStatus(job, 'scanning')
      const roots: Entry[] = []
      for (const path of request.source.paths) {
        try {
          roots.push(await src.stat(path))
        } catch (err) {
          job.fail(path, err)
        }
      }
      for (const root of roots) await this.scan(ctx, root)
      job.speed.reset()
      this.setStatus(job, 'running')

      for (const root of roots) {
        if (aborted(job)) break
        try {
          if (ctx.move && ctx.same) await this.moveSame(ctx, root, request.dest.dir)
          else await this.transfer(ctx, root, request.dest.dir)
        } catch (err) {
          if (aborted(job)) break
          job.fail(root.path, err)
        }
      }
      await ctx.pool.drain()
      if (!aborted(job)) await this.finalizeDirectories(ctx)
    } catch (err) {
      if (!aborted(job)) job.fail(request.source.paths[0] ?? '', err)
    } finally {
      await ctx.pool.drain().catch(() => {})
      this.rejectConflicts(job)
      this.finish(job)
    }
  }

  private finish(job: Job): void {
    job.current.clear()
    job.finishedAt = this.now()
    this.setStatus(job, aborted(job) ? 'cancelled' : job.errorCount > 0 ? 'error' : 'done', true)
  }

  // ---- scanning ------------------------------------------------------------------------------

  /** Count files and bytes under `entry` so progress has a denominator. */
  private async scan(ctx: Ctx, entry: Entry): Promise<{ files: number; bytes: number }> {
    if (aborted(ctx.job)) return { files: 0, bytes: 0 }
    let total = { files: 0, bytes: 0 }
    if (entry.type === 'dir') {
      try {
        for (const child of await ctx.src.list(entry.path)) {
          const sub = await this.scan(ctx, child)
          total = { files: total.files + sub.files, bytes: total.bytes + sub.bytes }
        }
      } catch (err) {
        if (!aborted(ctx.job)) ctx.job.fail(entry.path, err)
      }
    } else if (entry.type === 'file' || entry.type === 'symlink') {
      total = { files: 1, bytes: entry.type === 'file' ? entry.size : 0 }
    }
    ctx.job.subtree.set(entry.path, total)
    // Only the roots count toward the totals; nested folders are summed through them.
    if (ctx.job.request.source.paths.includes(entry.path)) {
      ctx.job.filesTotal += total.files
      ctx.job.bytesTotal += total.bytes
      this.markDirty(ctx.job)
    }
    return total
  }

  // ---- copying -------------------------------------------------------------------------------

  /** Copy (or cross-machine move) `entry` into `dstDir`, recursing into folders. */
  private async transfer(ctx: Ctx, entry: Entry, dstDir: string): Promise<void> {
    const { job } = ctx
    if (aborted(job)) return

    if (entry.type === 'other') {
      this.credit(ctx, entry, 'skip')
      job.fail(entry.path, new Error(`"${entry.name}" is a special file and was not copied`))
      return
    }
    if (
      ctx.same &&
      entry.type === 'dir' &&
      (dstDir === entry.path || dstDir.startsWith(entry.path + '/'))
    ) {
      this.credit(ctx, entry, 'skip')
      job.fail(
        entry.path,
        new Error(`Cannot ${ctx.move ? 'move' : 'copy'} "${entry.name}" into itself`)
      )
      return
    }

    const target = await this.chooseTarget(ctx, entry, dstDir)
    if (target.action === 'skip') {
      this.credit(ctx, entry, 'skip')
      return
    }

    if (entry.type === 'dir') {
      await this.ensureDir(ctx, target.path, target.existed)
      let children: Entry[]
      try {
        children = (await ctx.src.list(entry.path)).sort((a, b) => a.name.localeCompare(b.name))
      } catch (err) {
        job.fail(entry.path, err)
        return
      }
      for (const child of children) await this.transfer(ctx, child, target.path)
      if (this.preserve())
        ctx.finalizers.push({ path: target.path, mode: entry.mode, mtime: entry.mtime })
      if (ctx.move) ctx.emptied.push(entry.path)
      return
    }

    // Files and symlinks run in the pool so several copy at once while the walk continues.
    await ctx.pool.start(() =>
      this.copyLeaf(ctx, entry, target.path, target.action === 'overwrite')
    )
  }

  /** Copy one file or recreate one symlink, then (for moves) delete the source. */
  private async copyLeaf(
    ctx: Ctx,
    entry: Entry,
    dstPath: string,
    overwrite: boolean
  ): Promise<void> {
    const { job, src, dst } = ctx
    if (aborted(job)) return
    job.current.add(entry.name)
    this.markDirty(job)
    let counted = 0
    try {
      if (entry.type === 'symlink') {
        if (overwrite)
          await dst.remove(dstPath, { recursive: false, toTrash: false }).catch(() => {})
        await dst.symlink(entry.linkTarget ?? '', dstPath)
      } else {
        counted = await this.copyFileData(ctx, entry, dstPath, overwrite, (n) => {
          job.bytesDone += n
          job.speed.record(job.bytesDone, this.now())
          this.markDirty(job)
        })
      }
      if (ctx.move) await src.remove(entry.path, { recursive: false, toTrash: false })
      job.filesDone++
    } catch (err) {
      if (!aborted(job)) {
        // The partial bytes no longer count toward the total; the file simply failed.
        job.bytesDone -= counted
        job.bytesTotal -= entry.size
        job.filesTotal--
        job.fail(entry.path, err)
      }
    } finally {
      job.current.delete(entry.name)
      this.markDirty(job)
    }
  }

  /** The safe write: temp name, verify, attributes, atomic rename. Returns bytes copied. */
  private async copyFileData(
    ctx: Ctx,
    entry: Entry,
    dstPath: string,
    overwrite: boolean,
    onBytes: (n: number) => void
  ): Promise<number> {
    const { src, dst, job } = ctx
    const part = dstPath + PART_SUFFIX
    let copied = 0
    let wrote = false
    try {
      const input = await src.openRead(entry.path)
      let output
      try {
        output = await dst.openWrite(part, { mode: 0o600 })
      } catch (err) {
        input.destroy()
        throw err
      }
      wrote = true
      input.on('data', (chunk: Buffer) => {
        copied += chunk.length
        onBytes(chunk.length)
      })
      await pipeline(input, output, { signal: job.signal })

      const written = await dst.stat(part)
      if (written.size !== copied) {
        throw new Error(
          `Size mismatch after copying "${entry.name}": expected ${copied} bytes, found ${written.size}`
        )
      }
      if (this.preserve()) {
        // Best effort: a server may refuse to set these, and the data is what matters.
        await dst.chmod(part, entry.mode & 0o7777).catch(() => {})
        await dst.setTimes(part, entry.mtime).catch(() => {})
      } else {
        await dst.chmod(part, 0o644).catch(() => {})
      }
      await dst.rename(part, dstPath, { overwrite })
      return copied
    } catch (err) {
      if (wrote) await dst.remove(part, { recursive: false, toTrash: false }).catch(() => {})
      throw hideTempName(err, part, dstPath)
    }
  }

  private async ensureDir(ctx: Ctx, path: string, existed: boolean): Promise<void> {
    if (existed) return
    try {
      await ctx.dst.mkdir(path)
    } catch (err) {
      if (err instanceof FsError && err.code === 'EEXIST') {
        const st = await ctx.dst.stat(path)
        if (st.type === 'dir') return
      }
      throw err
    }
  }

  /** After the walk: give copied folders their permissions and times, and clear emptied sources. */
  private async finalizeDirectories(ctx: Ctx): Promise<void> {
    // Both lists were built children-first, which is the order to work in: a folder can only
    // be removed once it is empty, and made read-only once everything below it is done.
    for (const f of ctx.finalizers) {
      await ctx.dst.chmod(f.path, f.mode & 0o7777).catch(() => {})
      await ctx.dst.setTimes(f.path, f.mtime).catch(() => {})
    }
    for (const dir of ctx.emptied) {
      // Only if everything in it moved: a folder with skipped or failed items stays.
      await ctx.src.remove(dir, { recursive: false, toTrash: false }).catch(() => {})
    }
  }

  // ---- moving within one machine ---------------------------------------------------------------

  private async moveSame(ctx: Ctx, entry: Entry, dstDir: string): Promise<void> {
    const { job, src } = ctx
    if (aborted(job)) return

    if (parentOf(entry.path) === dstDir) {
      this.credit(ctx, entry, 'skip') // already where it is going
      return
    }
    if (entry.type === 'dir' && (dstDir === entry.path || dstDir.startsWith(entry.path + '/'))) {
      this.credit(ctx, entry, 'skip')
      job.fail(entry.path, new Error(`Cannot move "${entry.name}" into itself`))
      return
    }

    const target = await this.chooseTarget(ctx, entry, dstDir)
    if (target.action === 'skip') {
      this.credit(ctx, entry, 'skip')
      return
    }

    // Merging into an existing folder: move the children one by one.
    if (entry.type === 'dir' && target.existed) {
      for (const child of (await src.list(entry.path)).sort((a, b) =>
        a.name.localeCompare(b.name)
      )) {
        await this.moveSame(ctx, child, target.path)
      }
      await src.remove(entry.path, { recursive: false, toTrash: false }).catch(() => {})
      return
    }

    try {
      await src.rename(entry.path, target.path, { overwrite: target.action === 'overwrite' })
      this.credit(ctx, entry, 'done')
    } catch (err) {
      const code = err instanceof FsError ? err.code : 'EUNKNOWN'
      if (code === 'EEXIST' || code === 'ENOENT' || code === 'EACCES') throw err
      // Probably another filesystem on the same machine: fall back to copy and delete.
      await this.transfer(ctx, entry, dstDir)
    }
  }

  // ---- conflicts -------------------------------------------------------------------------------

  /** Decide where `entry` goes inside `dstDir`, asking the user if the name is taken. */
  private async chooseTarget(
    ctx: Ctx,
    entry: Entry,
    dstDir: string
  ): Promise<{ action: 'create' | 'overwrite' | 'skip'; path: string; existed: boolean }> {
    const { dst } = ctx
    const path = joinPath(dstDir, entry.name)
    const existing = await dst.stat(path).catch((err: unknown) => {
      if (err instanceof FsError && err.code === 'ENOENT') return null
      throw err
    })
    if (!existing) return { action: 'create', path, existed: false }
    // Folder onto folder is a merge, not a conflict; the files inside are checked one by one.
    if (entry.type === 'dir' && existing.type === 'dir')
      return { action: 'create', path, existed: true }

    const kind: ConflictPrompt['kind'] =
      entry.type === 'dir' || existing.type === 'dir' ? 'type-mismatch' : 'file'

    // Copying something onto itself must never overwrite it; make a second copy instead.
    const resolution: ConflictResolution =
      ctx.same && path === entry.path ? 'keepBoth' : await this.decide(ctx, entry, existing, kind)

    switch (resolution) {
      case 'skip':
        return { action: 'skip', path, existed: true }
      case 'keepBoth': {
        const name = await uniqueCopyName(
          entry.name,
          entry.type === 'dir',
          async (candidate) =>
            (await dst.stat(joinPath(dstDir, candidate)).catch(() => null)) !== null
        )
        return { action: 'create', path: joinPath(dstDir, name), existed: false }
      }
      default:
        return { action: 'overwrite', path, existed: true }
    }
  }

  private async decide(
    ctx: Ctx,
    entry: Entry,
    existing: Entry,
    kind: ConflictPrompt['kind']
  ): Promise<ConflictResolution> {
    const { job } = ctx
    // A retry should not ask about what a previous run already copied.
    if (
      job.autoSkipIdentical &&
      kind === 'file' &&
      existing.size === entry.size &&
      Math.abs(existing.mtime - entry.mtime) <= SAME_TIME_TOLERANCE_MS
    ) {
      return 'skip'
    }

    let resolution = job.policy
    // A "replace" answer can't apply when a file would have to replace a folder or vice versa.
    if (
      resolution &&
      kind === 'type-mismatch' &&
      resolution !== 'skip' &&
      resolution !== 'keepBoth'
    ) {
      resolution = undefined
    }
    resolution ??= (await this.ask(ctx, entry, existing, kind)).resolution

    if (resolution === 'overwriteIfNewer')
      return entry.mtime > existing.mtime ? 'overwrite' : 'skip'
    return resolution
  }

  private ask(
    ctx: Ctx,
    entry: Entry,
    existing: Entry,
    kind: ConflictPrompt['kind']
  ): Promise<ConflictAnswer> {
    const { job } = ctx
    const side = (e: Entry): ConflictSide => ({
      path: e.path,
      type: e.type,
      size: e.size,
      mtime: e.mtime
    })
    const prompt: ConflictPrompt = {
      id: randomUUID(),
      jobId: job.id,
      kind,
      name: entry.name,
      destMachineId: job.request.dest.machineId,
      src: side(entry),
      dst: side(existing)
    }
    return new Promise<ConflictAnswer>((resolve, reject) => {
      job.conflicts.set(prompt.id, { prompt, resolve, reject })
      this.setStatus(job, 'waiting')
      this.deps.emitConflict(prompt)
    })
  }

  private rejectConflicts(job: Job): void {
    for (const [id, pending] of job.conflicts) {
      this.deps.emitConflictCancel(id)
      pending.reject(job.signal.reason)
    }
    job.conflicts.clear()
  }

  // ---- bookkeeping -----------------------------------------------------------------------------

  /** Account for an item (and everything under it) that was skipped or handled in one step. */
  private credit(ctx: Ctx, entry: Entry, how: 'skip' | 'done'): void {
    const { job } = ctx
    const sub = job.subtree.get(entry.path) ?? { files: 1, bytes: entry.size }
    if (how === 'done') {
      job.filesDone += sub.files
      job.bytesDone += sub.bytes
      job.speed.record(job.bytesDone, this.now())
    } else {
      job.filesTotal -= sub.files
      job.bytesTotal -= sub.bytes
      job.skipped += Math.max(1, sub.files)
    }
    this.markDirty(job)
  }

  private preserve(): boolean {
    return this.deps.preserveAttributes ?? true
  }

  private isFinished(job: Job): boolean {
    return job.status === 'done' || job.status === 'error' || job.status === 'cancelled'
  }

  private setStatus(job: Job, status: JobStatus, immediate = false): void {
    job.status = status
    this.markDirty(job, immediate)
  }

  private snapshot(job: Job): JobSnapshot {
    const now = this.now()
    const speed = job.status === 'running' ? job.speed.speed(now) : 0
    const remaining = Math.max(0, job.bytesTotal - job.bytesDone)
    return {
      id: job.id,
      mode: job.request.mode,
      status: job.status,
      source: job.request.source,
      dest: job.request.dest,
      filesTotal: job.filesTotal,
      filesDone: job.filesDone,
      bytesTotal: job.bytesTotal,
      bytesDone: job.bytesDone,
      skipped: job.skipped,
      speed,
      etaSeconds: speed > 0 && remaining > 0 ? Math.ceil(remaining / speed) : null,
      current: [...job.current].slice(0, 5),
      errors: job.errors,
      errorCount: job.errorCount,
      startedAt: job.startedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt })
    }
  }

  /** Batch progress so a fast transfer doesn't flood the renderer. Final states go out at once. */
  private markDirty(job: Job, immediate = false): void {
    this.dirty.add(job)
    if (immediate) return this.flush()
    this.flushTimer ??= setTimeout(() => this.flush(), this.deps.flushMs ?? 100)
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    if (this.dirty.size === 0) return
    const jobs = [...this.dirty].filter((j) => this.jobs.has(j.id)).map((j) => this.snapshot(j))
    this.dirty.clear()
    if (jobs.length > 0) this.deps.emitUpdate(jobs)
  }
}

/** Errors should name the file the user is copying to, not our temporary stand-in for it. */
function hideTempName(err: unknown, part: string, finalPath: string): unknown {
  if (!(err instanceof FsError) || !err.message.includes(part)) return err
  return new FsError({
    code: err.code,
    path: finalPath,
    message: err.message.split(part).join(finalPath)
  })
}
