import { describe, expect, it } from 'vitest'
import type { Layout } from '@shared/layout'
import { createWorkspaceStore, toLayout } from '../../src/renderer/src/app/workspaceStore'
import { createConnectionsStore } from '../../src/renderer/src/features/connections/connectionsStore'
import type { Notification } from '../../src/renderer/src/lib/toasts'
import { fail, fakeConnections, profile } from './fake-connections'
import { fakeTransfers } from './fake-transfers'

async function workspace(
  profiles = [profile(), profile({ id: 'p2', name: 'Stage' })],
  saved: Layout | null = null
) {
  const client = fakeConnections(profiles)
  const connections = createConnectionsStore(client)
  await connections.getState().init()
  const layoutClient = fakeTransfers()
  layoutClient.layout = saved
  const notes: Notification[] = []
  let n = 0
  const ws = createWorkspaceStore({
    connections,
    notify: (x) => notes.push(x),
    layout: { load: layoutClient.loadLayout, save: layoutClient.saveLayout },
    newId: () => `col-${++n}`,
    saveDelayMs: 10
  })
  const s = connections.getState
  const settle = () => new Promise((r) => setTimeout(r, 40))
  return { client, connections, s, ws, w: () => ws.getState(), notes, layoutClient, settle }
}

describe('columns', () => {
  it('starts with just the local machine, which cannot be closed while it is the only column', async () => {
    const { w } = await workspace()
    expect(w().columns).toEqual([{ id: 'local', machineId: 'local', title: 'Local', width: 420 }])
    w().closeColumn('local')
    expect(w().columns).toHaveLength(1)
  })

  it('connects, then opens a column for the profile', async () => {
    const { w, client } = await workspace()
    await w().openRemote('p1')
    expect(client.connected).toEqual(['p1'])
    expect(w().columns[1]).toEqual({
      id: 'col-1',
      machineId: 'ssh:p1',
      title: 'Prod',
      profileId: 'p1',
      width: 420
    })
    expect(w().connecting.size).toBe(0)
  })

  it('opens another column on an already connected profile without reconnecting', async () => {
    const { w, client } = await workspace()
    client.emitState({ profileId: 'p1', status: 'connected' })
    await w().openRemote('p1')
    await w().openRemote('p1')
    expect(client.connected).toEqual([])
    expect(w().columns.map((c) => c.id)).toEqual(['local', 'col-1', 'col-2'])
  })

  it('ignores a second open while the first is still connecting', async () => {
    const { w, client } = await workspace()
    let release!: () => void
    client.connectResult = () => new Promise((r) => (release = r))
    const first = w().openRemote('p1')
    await w().openRemote('p1')
    expect(w().connecting.has('p1')).toBe(true)
    release()
    await first
    expect(w().columns).toHaveLength(2)
  })

  it('opens no column and shows a toast when connecting fails; stays quiet on cancel', async () => {
    const { w, client, notes } = await workspace()
    client.connectResult = fail('ECONNECT', 'Connection refused by prod:22')
    await w().openRemote('p1')
    expect(w().columns).toHaveLength(1)
    expect(notes).toEqual([{ kind: 'error', message: 'Prod: Connection refused by prod:22' }])
    client.connectResult = fail('ECANCELLED')
    await w().openRemote('p1')
    expect(notes).toHaveLength(1)
    expect(w().dialog).toBeNull()
  })

  it('shows a persistent dialog, not a toast, for a distrusted host key', async () => {
    const { w, client, notes } = await workspace()
    client.connectResult = fail('EHOSTKEY', 'WARNING: host key CHANGED')
    await w().openRemote('p1')
    expect(notes).toEqual([])
    expect(w().dialog).toMatchObject({
      kind: 'connectError',
      profileName: 'Prod',
      error: { code: 'EHOSTKEY' }
    })
  })

  it('adds local columns, and closing works for any column while one remains', async () => {
    const { w } = await workspace()
    w().addLocalColumn()
    w().addLocalColumn()
    expect(w().columns.map((c) => c.id)).toEqual(['local', 'col-1', 'col-2'])
    w().closeColumn('local')
    expect(w().columns.map((c) => c.id)).toEqual(['col-1', 'col-2'])
    w().closeColumn('col-1')
    w().closeColumn('col-2') // last one stays
    expect(w().columns.map((c) => c.id)).toEqual(['col-2'])
  })

  it('reorders columns, clamping the target index', async () => {
    const { w } = await workspace()
    w().addLocalColumn()
    w().addLocalColumn()
    w().moveColumn('col-2', 0)
    expect(w().columns.map((c) => c.id)).toEqual(['col-2', 'local', 'col-1'])
    w().moveColumn('local', 99)
    expect(w().columns.map((c) => c.id)).toEqual(['col-2', 'col-1', 'local'])
    w().moveColumn('ghost', 0)
    expect(w().columns).toHaveLength(3)
  })

  it('resizes columns with a minimum width', async () => {
    const { w } = await workspace()
    w().setColumnWidth('local', 555.4)
    expect(w().columns[0]!.width).toBe(555)
    w().setColumnWidth('local', 10)
    expect(w().columns[0]!.width).toBe(260)
  })

  it('retitles and recolors columns when their profile is edited, and closes them when it is deleted', async () => {
    const { w, s, client } = await workspace()
    await w().openRemote('p1')
    await w().openRemote('p2')
    await s().saveProfile({ ...client.profiles[0]!, name: 'Production', color: '#ff0000' })
    expect(w().columns[1]).toMatchObject({ title: 'Production', color: '#ff0000' })
    const withoutColor = { ...client.profiles[0]!, name: 'Production' }
    delete withoutColor.color
    await s().saveProfile(withoutColor)
    expect('color' in w().columns[1]!).toBe(false)
    await s().deleteProfile('p2')
    expect(w().columns.map((c) => c.title)).toEqual(['Local', 'Production'])
  })

  it('shows and hides dialogs', async () => {
    const { w } = await workspace()
    w().showDialog({ kind: 'manage' })
    expect(w().dialog).toEqual({ kind: 'manage' })
    w().showDialog(null)
    expect(w().dialog).toBeNull()
  })
})

describe('saved layout', () => {
  const saved: Layout = {
    columns: [
      {
        id: 'a',
        machineId: 'local',
        cwd: '/home/me/code',
        width: 500,
        showHidden: true,
        sortKey: 'mtime',
        sortDir: 'desc'
      },
      { id: 'b', machineId: 'ssh:p1', profileId: 'p1', cwd: '/var/www', width: 300 },
      { id: 'c', machineId: 'ssh:gone', profileId: 'gone', cwd: '/x' },
      { id: 'd', machineId: 'local', width: 50 }
    ]
  }

  it('does not save anything before the saved layout has been read', async () => {
    const { w, layoutClient, settle } = await workspace()
    w().addLocalColumn()
    await settle()
    expect(layoutClient.saved).toEqual([])
  })

  it('restores columns with their folders, view settings and widths; drops deleted connections', async () => {
    const { w } = await workspace(undefined, saved)
    await w().restore()
    expect(w().columns.map((c) => c.id)).toEqual(['a', 'b', 'd'])
    expect(w().columns[0]).toMatchObject({
      machineId: 'local',
      width: 500,
      initial: { path: '/home/me/code', showHidden: true, sortKey: 'mtime', sortDir: 'desc' }
    })
    expect(w().columns[1]).toMatchObject({
      machineId: 'ssh:p1',
      profileId: 'p1',
      title: 'Prod',
      width: 300,
      initial: { path: '/var/www' }
    })
    expect(w().columns[2]!.width).toBe(260) // a corrupt tiny width is raised to the minimum
    expect(w().restored).toBe(true)
  })

  it('keeps the default layout when nothing is saved, or when every saved column is gone', async () => {
    const empty = await workspace()
    await empty.w().restore()
    expect(empty.w().columns.map((c) => c.id)).toEqual(['local'])
    const gone = await workspace(undefined, {
      columns: [{ id: 'x', machineId: 'ssh:z', profileId: 'z' }]
    })
    await gone.w().restore()
    expect(gone.w().columns.map((c) => c.id)).toEqual(['local'])
  })

  it('survives an unreadable layout', async () => {
    const t = await workspace()
    t.layoutClient.loadLayout = async () => {
      throw new Error('disk on fire')
    }
    const ws = createWorkspaceStore({
      connections: t.connections,
      notify: () => {},
      layout: { load: t.layoutClient.loadLayout, save: t.layoutClient.saveLayout }
    })
    await ws.getState().restore()
    expect(ws.getState().columns).toHaveLength(1)
    expect(ws.getState().restored).toBe(true)
  })

  it('saves after changes, batching a burst (e.g. dragging a splitter) into one write', async () => {
    const { w, layoutClient, settle } = await workspace(undefined, saved)
    await w().restore()
    await settle()
    layoutClient.saved.length = 0
    for (let i = 0; i < 30; i++) w().setColumnWidth('a', 300 + i)
    await settle()
    expect(layoutClient.saved).toHaveLength(1)
    expect(layoutClient.saved[0]!.columns.find((c) => c.id === 'a')!.width).toBe(329)
  })

  it('saves view changes (folder, hidden files, sort) of columns', async () => {
    const { w, layoutClient, settle } = await workspace(undefined, saved)
    await w().restore()
    await settle()
    layoutClient.saved.length = 0
    w().updateColumnView('a', { cwd: '/tmp', showHidden: false, sortKey: 'size', sortDir: 'asc' })
    await settle()
    expect(layoutClient.saved.at(-1)!.columns.find((c) => c.id === 'a')).toMatchObject({
      cwd: '/tmp',
      showHidden: false,
      sortKey: 'size',
      sortDir: 'asc'
    })
  })

  it('keeps a restored column’s saved folder in the layout until the column reports its own', async () => {
    const { w, layoutClient, settle } = await workspace(undefined, saved)
    await w().restore()
    await settle()
    const layout = layoutClient.saved.at(-1)!
    expect(layout.columns.find((c) => c.id === 'b')).toMatchObject({
      cwd: '/var/www',
      profileId: 'p1',
      width: 300
    })
  })

  it('round-trips order, widths and remote columns', async () => {
    const { w, layoutClient, settle } = await workspace(undefined, saved)
    await w().restore()
    w().moveColumn('d', 0)
    await settle()
    expect(layoutClient.saved.at(-1)!.columns.map((c) => c.id)).toEqual(['d', 'a', 'b'])
    expect(toLayout(w().columns, new Map()).columns).toEqual(layoutClient.saved.at(-1)!.columns)
  })
})
