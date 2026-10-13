import { describe, expect, it } from 'vitest'
import { FsError } from '@shared/fs-types'
import type { PromptRequest } from '@shared/connections'
import { createWorkspaceStore } from '../../src/renderer/src/app/workspaceStore'
import { createConnectionsStore } from '../../src/renderer/src/features/connections/connectionsStore'
import type { Notification } from '../../src/renderer/src/lib/toasts'
import { fail, fakeConnections, profile } from './fake-connections'

async function started(profiles = [profile()]) {
  const client = fakeConnections(profiles)
  const connections = createConnectionsStore(client)
  await connections.getState().init()
  return { client, connections, s: () => connections.getState() }
}

const passwordPrompt = (id: string): PromptRequest => ({
  id,
  kind: 'password',
  profileId: 'p1',
  profileName: 'Prod',
  username: 'me',
  host: 'h',
  retry: false,
  canRemember: true
})

describe('connections store', () => {
  it('loads profiles, current states and capabilities on init', async () => {
    const client = fakeConnections([profile()])
    client.initialStates = [{ profileId: 'p1', status: 'connected' }]
    client.secureStorage = false
    const connections = createConnectionsStore(client)
    await connections.getState().init()
    expect(connections.getState()).toMatchObject({
      loaded: true,
      profiles: [{ id: 'p1' }],
      states: { p1: { status: 'connected' } },
      secureStorage: false
    })
  })

  it('tracks state events and forgets cleanly disconnected profiles', async () => {
    const { client, s } = await started()
    client.emitState({ profileId: 'p1', status: 'connecting' })
    expect(s().states['p1']?.status).toBe('connecting')
    client.emitState({ profileId: 'p1', status: 'reconnecting', attempt: 2 })
    expect(s().states['p1']).toEqual({ profileId: 'p1', status: 'reconnecting', attempt: 2 })
    client.emitState({ profileId: 'p1', status: 'disconnected' })
    expect(s().states['p1']).toBeUndefined()
  })

  it('keeps a disconnected-with-error state so the reason stays visible', async () => {
    const { client, s } = await started()
    client.emitState({ profileId: 'p1', status: 'disconnected', error: 'Timed out' })
    expect(s().states['p1']).toMatchObject({ status: 'disconnected', error: 'Timed out' })
  })

  it('queues prompts in order and removes one when main cancels it', async () => {
    const { client, s } = await started()
    client.emitPrompt(passwordPrompt('a'))
    client.emitPrompt(passwordPrompt('b'))
    expect(s().prompts.map((p) => p.id)).toEqual(['a', 'b'])
    client.emitPromptCancel('a')
    expect(s().prompts.map((p) => p.id)).toEqual(['b'])
  })

  it('sends the answer to main and removes the prompt', async () => {
    const { client, s } = await started()
    client.emitPrompt(passwordPrompt('a'))
    s().answerPrompt('a', { kind: 'password', value: 'x', remember: false })
    expect(s().prompts).toEqual([])
    expect(client.responses).toEqual([
      { id: 'a', response: { kind: 'password', value: 'x', remember: false } }
    ])
    s().answerPrompt('a', null) // cancel of an unknown prompt is harmless
  })

  it('connect resolves to null on success and to the FsError on failure, never throwing', async () => {
    const { client, s } = await started()
    expect(await s().connect('p1')).toBeNull()
    client.connectResult = fail('EAUTH', 'nope')
    const err = await s().connect('p1')
    expect(err).toBeInstanceOf(FsError)
    expect(err).toMatchObject({ code: 'EAUTH', message: 'nope' })
    client.connectResult = async () => {
      throw new Error('boom')
    }
    expect(await s().connect('p1')).toMatchObject({ code: 'EUNKNOWN', message: 'boom' })
  })

  it('saves and deletes profiles, then reloads the list', async () => {
    const { s } = await started()
    const saved = await s().saveProfile({
      name: 'New',
      host: 'h',
      port: 22,
      username: '',
      authMethods: ['agent']
    })
    expect(s().profiles.map((p) => p.name)).toEqual(['Prod', 'New'])
    await s().deleteProfile(saved.id)
    expect(s().profiles.map((p) => p.name)).toEqual(['Prod'])
  })

  it('stops listening after dispose', async () => {
    const { client, connections, s } = await started()
    connections.getState().dispose()
    client.emitPrompt(passwordPrompt('late'))
    client.emitState({ profileId: 'p1', status: 'connected' })
    expect(s().prompts).toEqual([])
    expect(s().states).toEqual({})
  })

  it('re-init does not double-subscribe', async () => {
    const { client, connections, s } = await started()
    await connections.getState().init()
    client.emitPrompt(passwordPrompt('once'))
    expect(s().prompts).toHaveLength(1)
  })
})

describe('workspace store', () => {
  async function workspace(profiles = [profile(), profile({ id: 'p2', name: 'Stage' })]) {
    const base = await started(profiles)
    const notes: Notification[] = []
    let n = 0
    const ws = createWorkspaceStore({
      connections: base.connections,
      notify: (x) => notes.push(x),
      newId: () => `col-${++n}`
    })
    return { ...base, ws, notes, w: () => ws.getState() }
  }

  it('starts with just the local machine, which cannot be closed', async () => {
    const { w } = await workspace()
    expect(w().columns).toEqual([{ id: 'local', machineId: 'local', title: 'Local' }])
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
      profileId: 'p1'
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

  it('opens no column and shows a toast when connecting fails', async () => {
    const { w, client, notes } = await workspace()
    client.connectResult = fail('ECONNECT', 'Connection refused by prod:22')
    await w().openRemote('p1')
    expect(w().columns).toHaveLength(1)
    expect(notes).toEqual([{ kind: 'error', message: 'Prod: Connection refused by prod:22' }])
    expect(w().connecting.size).toBe(0)
  })

  it('stays quiet when the user cancels', async () => {
    const { w, client, notes } = await workspace()
    client.connectResult = fail('ECANCELLED')
    await w().openRemote('p1')
    expect(notes).toEqual([])
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

  it('ignores unknown profiles', async () => {
    const { w, client } = await workspace()
    await w().openRemote('ghost')
    expect(client.connected).toEqual([])
  })

  it('closes remote columns and keeps others', async () => {
    const { w } = await workspace()
    await w().openRemote('p1')
    await w().openRemote('p2')
    w().closeColumn('col-1')
    expect(w().columns.map((c) => c.title)).toEqual(['Local', 'Stage'])
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
