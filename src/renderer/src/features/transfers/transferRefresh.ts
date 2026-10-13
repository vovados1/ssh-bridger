import type { JobSnapshot } from '@shared/transfers'
import { parentOf } from '@shared/posix-path'
import type { MachineId } from '@shared/fs-types'

/** Which folders a job changes: where files land and, for moves, where they came from. */
export function foldersTouched(job: JobSnapshot): { machineId: MachineId; dir: string }[] {
  const out = [{ machineId: job.dest.machineId, dir: job.dest.dir }]
  if (job.mode === 'move') {
    for (const path of job.source.paths)
      out.push({ machineId: job.source.machineId, dir: parentOf(path) })
  }
  return out
}

/**
 * Decides when columns should reload because of transfer progress: now and then while files
 * land, and always once a job finishes. Remote folders can't report changes themselves.
 */
export class TransferRefresher {
  private lastProgress = new Map<string, { files: number; at: number }>()
  private finished = new Set<string>()

  constructor(
    private readonly refresh: (machineId: MachineId, dir: string) => void,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = 1500
  ) {}

  update(jobs: readonly JobSnapshot[]): void {
    for (const job of jobs) {
      const done = job.status === 'done' || job.status === 'error' || job.status === 'cancelled'
      if (done) {
        if (this.finished.has(job.id)) continue
        this.finished.add(job.id)
        this.lastProgress.delete(job.id)
        this.touch(job)
        continue
      }
      const last = this.lastProgress.get(job.id)
      const moved = job.filesDone + job.skipped
      if (moved > (last?.files ?? 0) && (!last || this.now() - last.at >= this.intervalMs)) {
        this.lastProgress.set(job.id, { files: moved, at: this.now() })
        this.touch(job)
      }
    }
  }

  private touch(job: JobSnapshot): void {
    for (const f of foldersTouched(job)) this.refresh(f.machineId, f.dir)
  }
}
