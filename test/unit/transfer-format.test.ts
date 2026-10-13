import { describe, expect, it } from 'vitest'
import {
  formatEta,
  formatSpeed,
  jobProgress,
  jobTitle,
  progressDetail,
  statusText,
  summarize
} from '../../src/renderer/src/features/transfers/transferFormat'
import { job } from './fake-transfers'

const name = (id: string) => (id === 'local' ? 'Local' : 'prod-1')

describe('transfer formatting', () => {
  it('formats speed and time left', () => {
    expect(formatSpeed(5 * 1024 * 1024)).toBe('5.0 MB/s')
    expect(formatEta(0.2)).toBe('1 s')
    expect(formatEta(45)).toBe('45 s')
    expect(formatEta(180)).toBe('3 min')
    expect(formatEta(3600)).toBe('1 h')
    expect(formatEta(4800)).toBe('1 h 20 min')
  })

  it('computes progress from bytes, falling back to files, and treats done as complete', () => {
    expect(jobProgress(job({ bytesTotal: 200, bytesDone: 50 }))).toBe(0.25)
    expect(jobProgress(job({ bytesTotal: 0, filesTotal: 4, filesDone: 1 }))).toBe(0.25)
    expect(jobProgress(job({ bytesTotal: 0, filesTotal: 0 }))).toBe(0)
    expect(jobProgress(job({ status: 'done', bytesTotal: 0, filesTotal: 0 }))).toBe(1)
    expect(jobProgress(job({ bytesTotal: 10, bytesDone: 99 }))).toBe(1)
  })

  it('titles jobs with the verb tense, item count and machine', () => {
    expect(jobTitle(job({ source: { machineId: 'local', paths: ['/a/report.pdf'] } }), name)).toBe(
      'Copying “report.pdf” to prod-1:/dst'
    )
    expect(
      jobTitle(
        job({ mode: 'move', source: { machineId: 'local', paths: ['/a', '/b', '/c'] } }),
        name
      )
    ).toBe('Moving 3 items to prod-1:/dst')
    expect(jobTitle(job({ status: 'done' }), name)).toBe('Copied “a.txt” to prod-1:/dst')
    expect(jobTitle(job({ status: 'done', mode: 'move' }), name)).toBe(
      'Moved “a.txt” to prod-1:/dst'
    )
    expect(jobTitle(job({ status: 'cancelled' }), name)).toContain('(cancelled)')
  })

  it('describes every status in words', () => {
    expect(statusText(job({ status: 'queued' }))).toMatch(/Waiting/)
    expect(statusText(job({ status: 'scanning' }))).toBe('Scanning…')
    expect(statusText(job({ status: 'waiting' }))).toMatch(/your answer/)
    expect(statusText(job({ status: 'done', skipped: 2 }))).toBe('Done, 2 skipped')
    expect(statusText(job({ status: 'done' }))).toBe('Done')
    expect(statusText(job({ status: 'error', errorCount: 1 }))).toBe('Finished with 1 error')
    expect(statusText(job({ status: 'error', errorCount: 3 }))).toBe('Finished with 3 errors')
    expect(statusText(job({ status: 'cancelled' }))).toBe('Cancelled')
  })

  it('shows files, bytes, speed and time left while running only', () => {
    expect(
      progressDetail(
        job({
          filesDone: 2,
          filesTotal: 5,
          bytesDone: 1024,
          bytesTotal: 4096,
          speed: 2048,
          etaSeconds: 30
        })
      )
    ).toBe('2 of 5 files · 1.0 KB of 4.0 KB · 2.0 KB/s · 30 s left')
    expect(
      progressDetail(
        job({ status: 'done', filesDone: 1, filesTotal: 1, bytesDone: 0, bytesTotal: 0 })
      )
    ).toBe('1 of 1 file')
  })

  it('summarizes active, finished and failed jobs', () => {
    const s = summarize([
      job({ id: '1', status: 'running', bytesTotal: 100, bytesDone: 25, speed: 10 }),
      job({ id: '2', status: 'waiting', bytesTotal: 100, bytesDone: 75, speed: 5 }),
      job({ id: '3', status: 'done' }),
      job({ id: '4', status: 'error' })
    ])
    expect(s).toEqual({ active: 2, finished: 2, errors: 1, speed: 15, progress: 0.5 })
    expect(summarize([])).toEqual({ active: 0, finished: 0, errors: 0, speed: 0, progress: 0 })
  })
})
