import { describe, expect, it } from 'vitest'
import { FsError } from '@shared/fs-types'
import type { PromptRequest } from '@shared/connections'
import { createConnectionsStore } from '../../src/renderer/src/features/connections/connectionsStore'
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
