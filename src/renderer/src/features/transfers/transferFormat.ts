import type { MachineId } from '@shared/fs-types'
import { baseName } from '@shared/posix-path'
import { ACTIVE_STATUSES, type JobSnapshot } from '@shared/transfers'
import { formatSize } from '../column/format'

export const formatSpeed = (bytesPerSecond: number): string =>
  `${formatSize(Math.round(bytesPerSecond))}/s`

/** `45 s`, `3 min`, `1 h 20 min` */
export function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`
}

/** 0..1; a job with nothing to copy yet counts as 0, and an empty finished job as 1. */
export function jobProgress(job: JobSnapshot): number {
  if (job.status === 'done') return 1
  if (job.bytesTotal > 0) return Math.min(1, job.bytesDone / job.bytesTotal)
  if (job.filesTotal > 0) return Math.min(1, job.filesDone / job.filesTotal)
  return 0
}

const noun = (n: number): string => (n === 1 ? '1 item' : `${n} items`)

/** "Copying 3 items to prod-1:/var/www" in the right tense for the job's state. */
export function jobTitle(job: JobSnapshot, machineName: (id: MachineId) => string): string {
  const what =
    job.source.paths.length === 1
      ? `“${baseName(job.source.paths[0]!)}”`
      : noun(job.source.paths.length)
  const verb = job.mode === 'move' ? 'Moving' : 'Copying'
  const past = job.mode === 'move' ? 'Moved' : 'Copied'
  const dest = `${machineName(job.dest.machineId)}:${job.dest.dir}`
  switch (job.status) {
    case 'done':
      return `${past} ${what} to ${dest}`
    case 'cancelled':
      return `${verb} ${what} to ${dest} (cancelled)`
    case 'error':
      return `${verb} ${what} to ${dest}`
    default:
      return `${verb} ${what} to ${dest}`
  }
}

export function statusText(job: JobSnapshot): string {
  switch (job.status) {
    case 'queued':
      return 'Waiting for other transfers…'
    case 'scanning':
      return 'Scanning…'
    case 'waiting':
      return 'Waiting for your answer'
    case 'running':
      return 'In progress'
    case 'done':
      return job.skipped > 0 ? `Done, ${job.skipped} skipped` : 'Done'
    case 'cancelled':
      return 'Cancelled'
    case 'error':
      return `Finished with ${job.errorCount} ${job.errorCount === 1 ? 'error' : 'errors'}`
  }
}

/** One-line detail: files, bytes, speed and time left while running. */
export function progressDetail(job: JobSnapshot): string {
  const parts = [`${job.filesDone} of ${job.filesTotal} ${job.filesTotal === 1 ? 'file' : 'files'}`]
  if (job.bytesTotal > 0)
    parts.push(`${formatSize(job.bytesDone)} of ${formatSize(job.bytesTotal)}`)
  if (job.status === 'running' && job.speed > 0) {
    parts.push(formatSpeed(job.speed))
    if (job.etaSeconds !== null) parts.push(`${formatEta(job.etaSeconds)} left`)
  }
  return parts.join(' · ')
}

export interface PanelSummary {
  active: number
  finished: number
  errors: number
  speed: number
  /** Overall progress of the active jobs, 0..1. */
  progress: number
}

export function summarize(jobs: readonly JobSnapshot[]): PanelSummary {
  const active = jobs.filter((j) => ACTIVE_STATUSES.includes(j.status))
  const bytesTotal = active.reduce((n, j) => n + j.bytesTotal, 0)
  const bytesDone = active.reduce((n, j) => n + j.bytesDone, 0)
  return {
    active: active.length,
    finished: jobs.length - active.length,
    errors: jobs.filter((j) => j.status === 'error').length,
    speed: active.reduce((n, j) => n + j.speed, 0),
    progress: bytesTotal > 0 ? Math.min(1, bytesDone / bytesTotal) : 0
  }
}
