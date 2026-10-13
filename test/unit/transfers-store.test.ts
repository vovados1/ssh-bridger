import { describe, expect, it } from 'vitest'
import { FsError } from '@shared/fs-types'
import type { ConflictPrompt } from '@shared/transfers'
import { createTransfersStore } from '../../src/renderer/src/features/transfers/transfersStore'
import {
  TransferRefresher,
  foldersTouched
} from '../../src/renderer/src/features/transfers/transferRefresh'
import {
  beginDrag,
  canDrop,
  chooseMode,
  describeDrag,
  endDrag,
  readPayload,
  ITEMS_MIME,
  type DragData,
  type DragInfo
} from '../../src/renderer/src/features/transfers/dnd'
import type { Notification } from '../../src/renderer/src/lib/toasts'
import { fakeTransfers, job } from './fake-transfers'

async function started() {
  const client = fakeTransfers()
  const notes: Notification[] = []
  const store = createTransfersStore(client, (n) => notes.push(n))
  await store.getState().init()
  return { client, notes, store, s: () => store.getState() }
}

const conflict = (id: string, jobId = 'j1'): ConflictPrompt => ({
  id,
  jobId,
  kind: 'file',
  name: 'a.txt',
  destMachineId: 'ssh:s',
  src: { path: '/s/a.txt', type: 'file', size: 1, mtime: 1 },
  dst: { path: '/d/a.txt', type: 'file', size: 2, mtime: 2 }
})

describe('transfers store', () => {
  it('loads existing jobs and merges updates by id, oldest first', async () => {
    const client = fakeTransfers()
    client.jobs = [job({ id: 'b', startedAt: 20 }), job({ id: 'a', startedAt: 10 })]
    const store = createTransfersStore(client, () => {})
    await store.getState().init()
    expect(store.getState().jobs.map((j) => j.id)).toEqual(['a', 'b'])
    client.emitUpdate([
      job({ id: 'b', startedAt: 20, bytesDone: 50 }),
      job({ id: 'c', startedAt: 30 })
    ])
    expect(store.getState().jobs.map((j) => [j.id, j.bytesDone])).toEqual([
      ['a', 0],
      ['b', 50],
      ['c', 0]
    ])
  })

  it('starting a transfer sends the request and opens the panel', async () => {
    const { client, s } = await started()
    await s().start({
      source: { machineId: 'local', paths: ['/a'] },
      dest: { machineId: 'ssh:s', dir: '/d' },
      mode: 'copy'
    })
    expect(client.started).toHaveLength(1)
    expect(s().panelOpen).toBe(true)
  })

  it('reports a failure to start as a toast instead of throwing', async () => {
    const { client, notes, s } = await started()
    client.startResult = async () => {
      throw new FsError({ code: 'ENOTDIR', message: '"/x" is not a folder' })
    }
    await s().start({
      source: { machineId: 'local', paths: ['/a'] },
      dest: { machineId: 'local', dir: '/x' },
      mode: 'copy'
    })
    expect(notes).toEqual([{ kind: 'error', message: '"/x" is not a folder' }])
    expect(s().panelOpen).toBe(false)
  })

  it('queues conflicts in order and removes one when main cancels it', async () => {
    const { client, s } = await started()
    client.emitConflict(conflict('1'))
    client.emitConflict(conflict('2'))
    expect(s().conflicts.map((c) => c.id)).toEqual(['1', '2'])
    client.emitConflictCancel('1')
    expect(s().conflicts.map((c) => c.id)).toEqual(['2'])
  })

  it('sends the answer and closes the question; abandoning cancels the whole job', async () => {
    const { client, s } = await started()
    client.emitConflict(conflict('1', 'jobA'))
    client.emitConflict(conflict('2', 'jobB'))
    s().resolveConflict('1', { resolution: 'skip', applyToAll: true })
    expect(client.resolved).toEqual([{ id: '1', answer: { resolution: 'skip', applyToAll: true } }])
    s().abandonConflict('2')
    expect(client.cancelled).toEqual(['jobB'])
    expect(s().conflicts).toEqual([])
  })

  it('clear removes finished jobs but never active ones', async () => {
    const { client, s } = await started()
    client.emitUpdate([
      job({ id: 'run', status: 'running' }),
      job({ id: 'done', status: 'done', startedAt: 2 }),
      job({ id: 'err', status: 'error', startedAt: 3 }),
      job({ id: 'wait', status: 'waiting', startedAt: 4 })
    ])
    s().clear('done')
    expect(s().jobs.map((j) => j.id)).toEqual(['run', 'err', 'wait'])
    s().clear()
    expect(s().jobs.map((j) => j.id)).toEqual(['run', 'wait'])
    expect(client.cleared).toEqual(['done', undefined])
  })

  it('retry replaces the old entry and opens the panel', async () => {
    const { client, s } = await started()
    client.emitUpdate([job({ id: 'bad', status: 'error' })])
    await s().retry('bad')
    expect(client.retried).toEqual(['bad'])
    expect(s().jobs).toEqual([])
    expect(s().panelOpen).toBe(true)
  })

  it('stops listening after dispose', async () => {
    const { client, s, store } = await started()
    store.getState().dispose()
    client.emitUpdate([job()])
    client.emitConflict(conflict('x'))
    expect(s().jobs).toEqual([])
    expect(s().conflicts).toEqual([])
  })
})

describe('clipboard', () => {
  it('copy then paste starts a copy and keeps the clipboard for more pastes', async () => {
    const { client, s } = await started()
    s().copy('local', ['/a', '/b'])
    expect(await s().paste({ machineId: 'ssh:s', dir: '/d' })).toBe(true)
    expect(client.started[0]).toEqual({
      source: { machineId: 'local', paths: ['/a', '/b'] },
      dest: { machineId: 'ssh:s', dir: '/d' },
      mode: 'copy'
    })
    expect(s().clipboard).not.toBeNull()
    await s().paste({ machineId: 'local', dir: '/e' })
    expect(client.started).toHaveLength(2)
  })

  it('cut then paste is a one-shot move', async () => {
    const { client, s } = await started()
    s().cut('local', ['/a'])
    expect(s().clipboard?.mode).toBe('cut')
    await s().paste({ machineId: 'local', dir: '/d' })
    expect(client.started[0]!.mode).toBe('move')
    expect(s().clipboard).toBeNull()
    expect(await s().paste({ machineId: 'local', dir: '/d' })).toBe(false)
  })

  it('an empty selection clears instead of copying nothing', async () => {
    const { s } = await started()
    s().copy('local', ['/a'])
    s().copy('local', [])
    expect(s().clipboard).toBeNull()
    s().cut('local', ['/a'])
    s().clearClipboard()
    expect(s().clipboard).toBeNull()
  })
})

describe('TransferRefresher / foldersTouched', () => {
  it('lists the destination, and for moves the source folders too', () => {
    expect(foldersTouched(job())).toEqual([{ machineId: 'ssh:s', dir: '/dst' }])
    expect(
      foldersTouched(job({ mode: 'move', source: { machineId: 'local', paths: ['/a/x', '/b/y'] } }))
    ).toEqual([
      { machineId: 'ssh:s', dir: '/dst' },
      { machineId: 'local', dir: '/a' },
      { machineId: 'local', dir: '/b' }
    ])
  })

  it('refreshes while files land but not more than once per interval, and always when finished', () => {
    const calls: string[] = []
    let t = 0
    const r = new TransferRefresher(
      (m, d) => calls.push(`${m}:${d}`),
      () => t,
      1000
    )
    r.update([job({ filesDone: 0 })])
    expect(calls).toEqual([]) // nothing landed yet
    r.update([job({ filesDone: 1 })])
    expect(calls).toHaveLength(1)
    t = 200
    r.update([job({ filesDone: 2 })])
    expect(calls).toHaveLength(1) // throttled
    t = 1200
    r.update([job({ filesDone: 3 })])
    expect(calls).toHaveLength(2)
    r.update([job({ filesDone: 4, status: 'done' })])
    expect(calls).toHaveLength(3) // finishing always refreshes
    r.update([job({ filesDone: 4, status: 'done' })])
    expect(calls).toHaveLength(3) // and only once
  })

  it('refreshes for a job that fails or is cancelled without any progress', () => {
    const calls: string[] = []
    const r = new TransferRefresher((m, d) => calls.push(d))
    r.update([job({ status: 'cancelled' })])
    expect(calls).toEqual(['/dst'])
  })
})

/** A minimal DataTransfer: enough for the helpers under test. */
class FakeDataTransfer {
  data = new Map<string, string>()
  effectAllowed = 'uninitialized'
  get types(): string[] {
    return [...this.data.keys(), ...this.extra]
  }
  constructor(private extra: string[] = []) {}
  setData(type: string, value: string) {
    this.data.set(type, value)
  }
  getData(type: string) {
    return this.data.get(type) ?? ''
  }
}
const dt = (extra: string[] = []): DragData => new FakeDataTransfer(extra)

describe('drag and drop helpers', () => {
  it('carries the dragged paths and recognises our own drags', () => {
    const t = dt()
    beginDrag(t, { machineId: 'local', paths: ['/a', '/b'], columnId: 'c1' })
    expect(describeDrag(t)).toEqual({
      kind: 'internal',
      payload: { machineId: 'local', paths: ['/a', '/b'], columnId: 'c1' }
    })
    expect(readPayload(t)).toEqual({ machineId: 'local', paths: ['/a', '/b'], columnId: 'c1' })
    expect(t.getData('text/plain')).toBe('/a\n/b')
    endDrag()
    expect(describeDrag(t)).toBeNull() // a stale marker without a live drag is ignored
  })

  it('recognises files from the desktop and ignores everything else', () => {
    endDrag()
    expect(describeDrag(dt(['Files']))).toEqual({ kind: 'os' })
    expect(describeDrag(dt(['text/uri-list']))).toBeNull()
    expect(describeDrag(null)).toBeNull()
  })

  it('refuses malformed payloads', () => {
    const t = dt()
    t.setData(ITEMS_MIME, '{"machineId":1}')
    expect(readPayload(t)).toBeNull()
    t.setData(ITEMS_MIME, 'not json')
    expect(readPayload(t)).toBeNull()
    expect(readPayload(dt())).toBeNull()
  })

  const internal = (machineId: 'local' | `ssh:${string}`, paths: string[]): DragInfo => ({
    kind: 'internal',
    payload: { machineId, paths, columnId: 'c' }
  })

  it('moves within a machine and copies between machines; modifier keys override', () => {
    const none = { ctrlKey: false, shiftKey: false }
    expect(chooseMode(internal('local', ['/a']), 'local', none)).toBe('move')
    expect(chooseMode(internal('local', ['/a']), 'ssh:s', none)).toBe('copy')
    expect(chooseMode(internal('local', ['/a']), 'local', { ctrlKey: true, shiftKey: false })).toBe(
      'copy'
    )
    expect(chooseMode(internal('local', ['/a']), 'ssh:s', { ctrlKey: false, shiftKey: true })).toBe(
      'move'
    )
    expect(chooseMode({ kind: 'os' }, 'local', { ctrlKey: false, shiftKey: true })).toBe('copy') // desktop files are never moved
  })

  it('does not allow dropping a folder into itself or below, or moving to where it already is', () => {
    const drag = internal('local', ['/home/me/proj', '/home/me/a.txt'])
    expect(canDrop(drag, 'local', '/home/me/proj', 'copy')).toBe(false)
    expect(canDrop(drag, 'local', '/home/me/proj/sub', 'move')).toBe(false)
    expect(canDrop(drag, 'local', '/home/me', 'move')).toBe(false) // already there
    expect(canDrop(drag, 'local', '/home/me', 'copy')).toBe(true) // duplicating is fine
    expect(canDrop(drag, 'local', '/home/me/projects', 'move')).toBe(true) // similar prefix is not "inside"
    expect(canDrop(drag, 'ssh:s', '/home/me/proj', 'copy')).toBe(true) // a different machine's /home/me/proj is unrelated
    expect(canDrop({ kind: 'os' }, 'local', '/anywhere', 'copy')).toBe(true)
  })

  it('treats a drag from the root folder correctly', () => {
    expect(canDrop(internal('local', ['/top.txt']), 'local', '/', 'move')).toBe(false)
    expect(canDrop(internal('local', ['/top.txt']), 'local', '/other', 'move')).toBe(true)
  })
})
