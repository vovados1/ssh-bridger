import { describe, expect, it, vi } from 'vitest'
import type { PromptRequest } from '@shared/connections'
import { PromptBroker, silentPrompter, type NewPrompt } from '../../src/main/ssh/prompter'

const password: NewPrompt = {
  kind: 'password',
  profileId: 'p',
  profileName: 'Prod',
  username: 'me',
  host: 'h',
  retry: false,
  canRemember: true
}

function setup(canSend = true) {
  const sent: PromptRequest[] = []
  const cancelled: string[] = []
  const broker = new PromptBroker(
    (r) => (canSend ? (sent.push(r), true) : false),
    (id) => cancelled.push(id)
  )
  return { broker, sent, cancelled }
}

describe('PromptBroker', () => {
  it('sends a request with a fresh id and resolves with the matching answer', async () => {
    const { broker, sent } = setup()
    const answer = broker.ask(password)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: 'password', profileName: 'Prod' })
    broker.respond(sent[0]!.id, { kind: 'password', value: 'pw', remember: false })
    expect(await answer).toEqual({ kind: 'password', value: 'pw', remember: false })
    expect(broker.size).toBe(0)
  })

  it('gives every prompt its own id', async () => {
    const { broker, sent } = setup()
    void broker.ask(password)
    void broker.ask(password)
    expect(new Set(sent.map((s) => s.id)).size).toBe(2)
  })

  it('resolves null when nobody can show the prompt', async () => {
    expect(await setup(false).broker.ask(password)).toBeNull()
  })

  it('treats a cancel (null) as null', async () => {
    const { broker, sent } = setup()
    const answer = broker.ask(password)
    broker.respond(sent[0]!.id, null)
    expect(await answer).toBeNull()
  })

  it('rejects an answer of the wrong kind rather than trusting the renderer', async () => {
    const { broker, sent } = setup()
    const answer = broker.ask(password)
    broker.respond(sent[0]!.id, { kind: 'hostkey', accept: true, remember: true })
    expect(await answer).toBeNull()

    const second = broker.ask({
      kind: 'hostkey',
      profileId: 'p',
      profileName: 'P',
      host: 'h',
      port: 22,
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:x'
    })
    broker.respond(sent[1]!.id, { kind: 'password', value: 'x', remember: false })
    expect(await second).toBeNull()
  })

  it('does not let a passphrase answer satisfy a password prompt or vice versa', async () => {
    const { broker, sent } = setup()
    const answer = broker.ask(password)
    broker.respond(sent[0]!.id, { kind: 'passphrase', value: 'x', remember: false })
    expect(await answer).toBeNull()
  })

  it('ignores unknown ids and duplicate answers', async () => {
    const { broker, sent } = setup()
    const answer = broker.ask(password)
    broker.respond('nope', { kind: 'password', value: 'x', remember: false })
    broker.respond(sent[0]!.id, { kind: 'password', value: 'first', remember: false })
    broker.respond(sent[0]!.id, { kind: 'password', value: 'second', remember: false })
    expect(await answer).toMatchObject({ value: 'first' })
  })

  it('cancels a pending prompt when its signal aborts, telling the renderer to close it', async () => {
    const { broker, sent, cancelled } = setup()
    const ctl = new AbortController()
    const answer = broker.ask(password, ctl.signal)
    ctl.abort()
    expect(await answer).toBeNull()
    expect(cancelled).toEqual([sent[0]!.id])
    expect(broker.size).toBe(0)
  })

  it('answers null immediately for an already-aborted signal without sending anything', async () => {
    const { broker, sent } = setup()
    const ctl = new AbortController()
    ctl.abort()
    expect(await broker.ask(password, ctl.signal)).toBeNull()
    expect(sent).toHaveLength(0)
  })

  it('does not send a cancel for a prompt that was already answered', async () => {
    const { broker, sent, cancelled } = setup()
    const ctl = new AbortController()
    const answer = broker.ask(password, ctl.signal)
    broker.respond(sent[0]!.id, { kind: 'password', value: 'x', remember: false })
    await answer
    ctl.abort()
    expect(cancelled).toEqual([])
  })
})

describe('silentPrompter', () => {
  it('never answers', async () => {
    expect(await silentPrompter.ask(password)).toBeNull()
    expect(vi.isMockFunction(silentPrompter.ask)).toBe(false)
  })
})
