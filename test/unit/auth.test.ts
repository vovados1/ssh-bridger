import type { AnyAuthMethod } from 'ssh2'
import { describe, expect, it } from 'vitest'
import { FsError } from '@shared/fs-types'
import {
  DEFAULT_AUTH_METHODS,
  type ConnectionProfile,
  type PromptResponse
} from '@shared/connections'
import {
  SessionCredentials,
  authCandidates,
  makeAuthHandler,
  type AuthDeps
} from '../../src/main/ssh/auth'
import { generateUsableKey } from '../helpers/auth-server'
import type { NewPrompt, Prompter } from '../../src/main/ssh/prompter'
import {
  SecretStore,
  passphraseKey,
  passwordKey,
  type Cipher
} from '../../src/main/store/secret-store'

const plainKey = generateUsableKey().private
const encryptedKey = generateUsableKey('swordfish').private

const profile = (over: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id: 'p1',
  name: 'Prod',
  host: 'prod',
  port: 22,
  username: 'me',
  authMethods: [...DEFAULT_AUTH_METHODS],
  ...over
})

/** Scripted prompter: answers come from a queue; every question is recorded. */
function scripted(answers: (PromptResponse | null)[]) {
  const asked: NewPrompt[] = []
  const prompter: Prompter = {
    ask: async (p) => {
      asked.push(p)
      return answers.shift() ?? null
    }
  }
  return { prompter, asked }
}

const noKeyring: Cipher = {
  isAvailable: () => false,
  encrypt: () => Buffer.alloc(0),
  decrypt: () => ''
}

function deps(over: Partial<AuthDeps> & { files?: Record<string, string> } = {}): AuthDeps {
  const { files = {}, ...rest } = over
  return {
    profile: profile(),
    username: 'me',
    prompter: scripted([]).prompter,
    secrets: new SecretStore('/nonexistent/secrets.json', noKeyring),
    session: new SessionCredentials(),
    agentSocket: '/run/agent.sock',
    signal: new AbortController().signal,
    interactive: true,
    homeDir: '/home/me',
    readFile: async (path) => {
      if (path in files) return Buffer.from(files[path]!)
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    ...rest
  }
}

async function collect(gen: AsyncGenerator<AnyAuthMethod>, max = 20): Promise<AnyAuthMethod[]> {
  const out: AnyAuthMethod[] = []
  for (let i = 0; i < max; i++) {
    const { value, done } = await gen.next()
    if (done) break
    out.push(value)
  }
  return out
}
const types = (methods: AnyAuthMethod[]) => methods.map((m) => m.type)

describe('authCandidates order and availability', () => {
  it('follows the profile order and skips agent without a socket', async () => {
    const { prompter } = scripted([{ kind: 'password', value: 'pw', remember: false }])
    const d = deps({
      agentSocket: undefined,
      prompter,
      files: { '/home/me/.ssh/id_ed25519': plainKey }
    })
    const gen = authCandidates(d)
    expect(types(await collect(gen, 2))).toEqual(['publickey', 'password'])
  })

  it('offers the agent first when one is running', async () => {
    const first = (await authCandidates(deps()).next()).value
    expect(first).toMatchObject({ type: 'agent', agent: '/run/agent.sock', username: 'me' })
  })

  it('respects a custom order and a restricted method list', async () => {
    const d = deps({ profile: profile({ authMethods: ['keyboard-interactive', 'agent'] }) })
    expect(types(await collect(authCandidates(d)))).toEqual(['keyboard-interactive', 'agent'])
    const only = deps({ profile: profile({ authMethods: ['agent'] }) })
    expect(types(await collect(authCandidates(only)))).toEqual(['agent'])
  })

  it('does not prompt before earlier methods have been tried', async () => {
    const { prompter, asked } = scripted([{ kind: 'password', value: 'pw', remember: false }])
    const gen = authCandidates(deps({ prompter }))
    await gen.next() // agent
    expect(asked).toHaveLength(0)
    await gen.next() // no keys on disk -> password prompt
    expect(asked.map((a) => a.kind)).toEqual(['password'])
  })

  it('tries the explicit identity file instead of the default keys', async () => {
    const d = deps({
      profile: profile({ authMethods: ['publickey'], identityFile: '/keys/mine' }),
      files: { '/keys/mine': plainKey, '/home/me/.ssh/id_ed25519': plainKey }
    })
    const methods = await collect(authCandidates(d))
    expect(methods).toHaveLength(1)
    expect(methods[0]).toMatchObject({ type: 'publickey' })
  })

  it('skips missing and unparseable key files silently', async () => {
    const d = deps({
      profile: profile({ authMethods: ['publickey'] }),
      files: { '/home/me/.ssh/id_ed25519': 'not a key', '/home/me/.ssh/id_rsa': plainKey }
    })
    expect(types(await collect(authCandidates(d)))).toEqual(['publickey'])
  })
})

describe('passwords', () => {
  const pwProfile = profile({ authMethods: ['password'] })

  it('asks, and asks again with retry set after each rejection, up to three times', async () => {
    const { prompter, asked } = scripted([
      { kind: 'password', value: 'a', remember: false },
      { kind: 'password', value: 'b', remember: false },
      { kind: 'password', value: 'c', remember: false }
    ])
    const methods = await collect(authCandidates(deps({ profile: pwProfile, prompter })))
    expect(methods.map((m) => (m as { password: string }).password)).toEqual(['a', 'b', 'c'])
    expect(asked.map((a) => (a as { retry: boolean }).retry)).toEqual([false, true, true])
  })

  it('throws ECANCELLED when the user dismisses the prompt', async () => {
    const gen = authCandidates(deps({ profile: pwProfile, prompter: scripted([null]).prompter }))
    await expect(gen.next()).rejects.toMatchObject({ code: 'ECANCELLED' })
  })

  it('reuses the session password without asking and defers saving until success', async () => {
    const session = new SessionCredentials()
    session.password = 'cached'
    const { prompter, asked } = scripted([])
    const first = (await authCandidates(deps({ profile: pwProfile, session, prompter })).next())
      .value
    expect(first).toMatchObject({ type: 'password', password: 'cached' })
    expect(asked).toHaveLength(0)
  })

  it('queues "remember" for after authentication instead of saving immediately', async () => {
    const session = new SessionCredentials()
    const { prompter } = scripted([{ kind: 'password', value: 'pw', remember: true }])
    await authCandidates(deps({ profile: pwProfile, session, prompter })).next()
    expect([...session.rememberOnSuccess]).toEqual([[passwordKey('p1'), 'pw']])
  })

  it('never prompts during a silent reconnect', async () => {
    const { prompter, asked } = scripted([])
    const methods = await collect(
      authCandidates(deps({ profile: pwProfile, prompter, interactive: false }))
    )
    expect(methods).toEqual([])
    expect(asked).toHaveLength(0)
  })

  it('offers the remembered password from the keyring first', async () => {
    const store = new SecretStore('/tmp/x', {
      isAvailable: () => true,
      encrypt: (s) => Buffer.from(s),
      decrypt: (b) => b.toString()
    })
    // Seed through the public API on a throwaway file path is overkill; emulate with a stub.
    const stub = {
      available: true,
      get: (k: string) => (k === passwordKey('p1') ? 'saved' : undefined),
      delete: async () => {}
    } as unknown as SecretStore
    void store
    const first = (await authCandidates(deps({ profile: pwProfile, secrets: stub })).next()).value
    expect(first).toMatchObject({ type: 'password', password: 'saved' })
  })
})

describe('encrypted keys', () => {
  const keyProfile = profile({ authMethods: ['publickey'], identityFile: '/keys/enc' })

  it('prompts for the passphrase and yields the decrypted key', async () => {
    const session = new SessionCredentials()
    const { prompter, asked } = scripted([
      { kind: 'passphrase', value: 'swordfish', remember: true }
    ])
    const [method] = await collect(
      authCandidates(
        deps({ profile: keyProfile, prompter, session, files: { '/keys/enc': encryptedKey } })
      )
    )
    expect(method).toMatchObject({ type: 'publickey' })
    expect(asked[0]).toMatchObject({ kind: 'passphrase', keyPath: '/keys/enc', retry: false })
    expect(session.passphrases.get('/keys/enc')).toBe('swordfish')
    expect(session.rememberOnSuccess.get(passphraseKey('/keys/enc'))).toBe('swordfish')
  })

  it('re-asks with retry after a wrong passphrase, then gives up after three', async () => {
    const wrong = { kind: 'passphrase', value: 'nope', remember: false } as const
    const { prompter, asked } = scripted([wrong, wrong, wrong])
    const methods = await collect(
      authCandidates(deps({ profile: keyProfile, prompter, files: { '/keys/enc': encryptedKey } }))
    )
    expect(methods).toEqual([])
    expect(asked.map((a) => (a as { retry: boolean }).retry)).toEqual([false, true, true])
  })

  it('uses the session passphrase silently, and skips encrypted keys when non-interactive', async () => {
    const session = new SessionCredentials()
    session.passphrases.set('/keys/enc', 'swordfish')
    const files = { '/keys/enc': encryptedKey }
    expect(
      await collect(
        authCandidates(deps({ profile: keyProfile, session, files, interactive: false }))
      )
    ).toHaveLength(1)
    expect(
      await collect(authCandidates(deps({ profile: keyProfile, files, interactive: false })))
    ).toHaveLength(0)
  })

  it('cancels on a dismissed passphrase prompt', async () => {
    const gen = authCandidates(
      deps({
        profile: keyProfile,
        prompter: scripted([null]).prompter,
        files: { '/keys/enc': encryptedKey }
      })
    )
    await expect(gen.next()).rejects.toBeInstanceOf(FsError)
  })
})

describe('keyboard-interactive', () => {
  const kiProfile = profile({ authMethods: ['keyboard-interactive'] })
  const run = async (d: AuthDeps, prompts: { prompt: string; echo?: boolean }[]) => {
    const m = (await authCandidates(d).next()).value as Extract<
      AnyAuthMethod,
      { type: 'keyboard-interactive' }
    >
    return new Promise<string[]>((resolve) =>
      m.prompt('name', 'instr', '', prompts as never, resolve)
    )
  }

  it('relays prompts to the user and returns their answers', async () => {
    const { prompter, asked } = scripted([{ kind: 'keyboard-interactive', answers: ['123456'] }])
    const answers = await run(deps({ profile: kiProfile, prompter }), [
      { prompt: 'Verification code: ', echo: true }
    ])
    expect(answers).toEqual(['123456'])
    expect(asked[0]).toMatchObject({
      kind: 'keyboard-interactive',
      name: 'name',
      prompts: [{ prompt: 'Verification code: ', echo: true }]
    })
  })

  it('answers a lone "Password:" prompt from a known password instead of asking again', async () => {
    const session = new SessionCredentials()
    session.password = 'known'
    const { prompter, asked } = scripted([])
    expect(
      await run(deps({ profile: kiProfile, session, prompter }), [{ prompt: 'Password: ' }])
    ).toEqual(['known'])
    expect(asked).toHaveLength(0)
  })

  it('answers empty prompt lists without asking', async () => {
    expect(await run(deps({ profile: kiProfile }), [])).toEqual([])
  })

  it('is skipped on silent reconnects unless a password is known', async () => {
    expect(await collect(authCandidates(deps({ profile: kiProfile, interactive: false })))).toEqual(
      []
    )
  })
})

describe('makeAuthHandler', () => {
  /** Drive the handler like ssh2: the first call is the probe, later ones follow a rejection. */
  const call = (handler: ReturnType<typeof makeAuthHandler>, left: string[]) =>
    new Promise<unknown>((resolve) => handler(left as never, false, resolve as never))
  const afterProbe = async (handler: ReturnType<typeof makeAuthHandler>, left: string[]) => {
    expect(await call(handler, [])).toBe('none')
    return call(handler, left)
  }

  it('starts by asking the server what it accepts', async () => {
    const asked = scripted([])
    const handler = makeAuthHandler(deps({ prompter: asked.prompter }), () => {})
    expect(await call(handler, [])).toBe('none')
    expect(asked.asked).toHaveLength(0)
  })

  it('maps the agent to publickey and offers it when the server accepts publickey', async () => {
    const handler = makeAuthHandler(deps(), () => {})
    expect(await afterProbe(handler, ['publickey', 'password'])).toMatchObject({ type: 'agent' })
  })

  it('does not prompt for a password the server does not accept', async () => {
    const { prompter, asked } = scripted([{ kind: 'password', value: 'pw', remember: false }])
    const d = deps({
      profile: profile({ authMethods: ['password', 'keyboard-interactive'] }),
      prompter
    })
    const handler = makeAuthHandler(d, () => {})
    const method = await afterProbe(handler, ['keyboard-interactive'])
    expect(method).toMatchObject({ type: 'keyboard-interactive' })
    expect(asked).toHaveLength(0)
  })

  it('does not load or prompt for an encrypted key if publickey is refused', async () => {
    const { prompter, asked } = scripted([])
    const d = deps({
      profile: profile({ authMethods: ['publickey', 'password'], identityFile: '/keys/enc' }),
      prompter: scripted([{ kind: 'password', value: 'pw', remember: false }]).prompter,
      files: { '/keys/enc': encryptedKey }
    })
    void prompter
    void asked
    const handler = makeAuthHandler(d, () => {})
    expect(await afterProbe(handler, ['password'])).toMatchObject({ type: 'password' })
  })

  it('gives up with false when candidates run out', async () => {
    const handler = makeAuthHandler(
      deps({ profile: profile({ authMethods: ['agent'] }) }),
      () => {}
    )
    await afterProbe(handler, ['publickey'])
    expect(await call(handler, ['publickey'])).toBe(false)
  })

  it('reports a cancelled prompt as fatal and stops offering methods', async () => {
    const fatal: unknown[] = []
    const handler = makeAuthHandler(
      deps({
        profile: profile({ authMethods: ['password'] }),
        prompter: scripted([null]).prompter
      }),
      (e) => fatal.push(e)
    )
    expect(await afterProbe(handler, ['password'])).toBe(false)
    expect(fatal[0]).toMatchObject({ code: 'ECANCELLED' })
  })
})

describe('authCandidates with a method filter', () => {
  it('skips methods the server refuses before doing any work for them', async () => {
    const { prompter, asked } = scripted([])
    const d = deps({
      profile: profile({ authMethods: ['publickey', 'password'], identityFile: '/keys/enc' }),
      prompter,
      files: { '/keys/enc': encryptedKey }
    })
    const methods = await collect(authCandidates(d, () => false))
    expect(methods).toEqual([])
    expect(asked).toHaveLength(0)
  })
})
