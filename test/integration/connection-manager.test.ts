import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  sshMachineId,
  type ConnectionProfile,
  type ConnectionState,
  type PromptRequest,
  type PromptResponse
} from '@shared/connections'
import { FsError } from '@shared/fs-types'
import { MachineRegistry } from '../../src/main/fs/registry'
import { ConnectionManager } from '../../src/main/ssh/connection-manager'
import { KnownHostsFile } from '../../src/main/ssh/known-hosts'
import type { NewPrompt, Prompter } from '../../src/main/ssh/prompter'
import { ProfileStore } from '../../src/main/store/profile-store'
import {
  SecretStore,
  passphraseKey,
  passwordKey,
  type Cipher
} from '../../src/main/store/secret-store'
import { startAuthServer, type AuthServer } from '../helpers/auth-server'
import { PASSPHRASE, sshdAvailable, startSshd, type TestSshd } from '../helpers/sshd'
import { startProxy, type TcpProxy } from '../helpers/tcp-proxy'

const run = promisify(execFile)
const cipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(s).reverse(),
  decrypt: (b) => Buffer.from(b).reverse().toString()
}

let root: string
let sshd: TestSshd
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bridger-conn-'))
  if (sshdAvailable) sshd = await startSshd()
})
afterAll(async () => {
  await sshd?.stop()
  await rm(root, { recursive: true, force: true })
})

/** Everything a ConnectionManager needs, in a private temp dir, with a scriptable user. */
async function harness(opts: { sshConfig?: string | null } = {}) {
  const dir = await mkdtemp(join(root, 'h-'))
  const profiles = new ProfileStore(join(dir, 'profiles.json'))
  const secrets = new SecretStore(join(dir, 'secrets.json'), cipher)
  const knownHosts = new KnownHostsFile(join(dir, 'known_hosts'))
  await Promise.all([profiles.load(), secrets.load()])

  const prompts: PromptRequest[] = []
  /** What the "user" answers; consulted in order, null = cancel. */
  const answers: (PromptResponse | null | ((p: NewPrompt) => PromptResponse | null))[] = []
  const prompter: Prompter = {
    ask: async (p) => {
      prompts.push({ ...p, id: String(prompts.length) } as PromptRequest)
      const next = answers.shift()
      return typeof next === 'function' ? next(p) : (next ?? null)
    }
  }
  const registry = new MachineRegistry()
  const states: ConnectionState[] = []
  const manager = new ConnectionManager({
    profiles,
    secrets,
    prompter,
    knownHosts,
    registry,
    readSshConfig: async () => opts.sshConfig ?? null,
    agentSocket: undefined, // never touch the developer's real agent
    localUsername: userInfo().username,
    homeDir: dir,
    onState: (s) => states.push(s),
    reconnectDelaysMs: [30, 60, 120, 240],
    readyTimeoutMs: 5000,
    keepaliveIntervalMs: 500
  })

  const addProfile = (over: Partial<ConnectionProfile> & { port: number }) =>
    profiles.save({
      name: 'Test',
      host: '127.0.0.1',
      username: userInfo().username,
      authMethods: ['publickey'],
      identityFile: sshd?.clientKey,
      ...over
    } as never)

  const trust: PromptResponse = { kind: 'hostkey', accept: true, remember: true }
  return {
    dir,
    profiles,
    secrets,
    knownHosts,
    prompts,
    answers,
    registry,
    states,
    manager,
    addProfile,
    trust
  }
}

const statuses = (states: ConnectionState[], id: string) =>
  states.filter((s) => s.profileId === id).map((s) => s.status)
const rejection = async (p: Promise<unknown>): Promise<FsError> => {
  try {
    await p
  } catch (e) {
    return e as FsError
  }
  throw new Error('expected a rejection')
}
const until = async (fn: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe.skipIf(!sshdAvailable)('ConnectionManager against a real sshd', () => {
  let h: Awaited<ReturnType<typeof harness>>
  beforeEach(async () => {
    h = await harness()
  })
  afterEach(() => h.manager.shutdown())

  describe('host keys', () => {
    it('asks about an unknown host, shows the OpenSSH fingerprint, and remembers it in known_hosts', async () => {
      const p = await h.addProfile({ port: sshd.port })
      h.answers.push(h.trust)
      await h.manager.connect(p.id)

      const prompt = h.prompts[0]!
      expect(prompt).toMatchObject({
        kind: 'hostkey',
        host: '127.0.0.1',
        port: sshd.port,
        keyType: 'ssh-ed25519'
      })
      const { stdout } = await run('ssh-keygen', ['-lf', `${sshd.hostKeyPath}.pub`])
      expect(stdout).toContain((prompt as { fingerprint: string }).fingerprint)

      expect(await readFile(h.knownHosts.path, 'utf8')).toBe(
        `[127.0.0.1]:${sshd.port} ${sshd.hostKeyLine}\n`
      )
      expect(statuses(h.states, p.id)).toEqual(['connecting', 'connected'])
    })

    it('does not ask again once remembered, even across managers', async () => {
      const p = await h.addProfile({ port: sshd.port })
      h.answers.push(h.trust)
      await h.manager.connect(p.id)
      await h.manager.disconnect(p.id)
      await h.manager.connect(p.id)
      expect(h.prompts).toHaveLength(1)
    })

    it('trusts for the session only when asked not to remember, and writes nothing', async () => {
      const p = await h.addProfile({ port: sshd.port })
      h.answers.push({ kind: 'hostkey', accept: true, remember: false })
      await h.manager.connect(p.id)
      await expect(readFile(h.knownHosts.path)).rejects.toThrow()
    })

    it('refuses when the user declines the key, and writes nothing', async () => {
      const p = await h.addProfile({ port: sshd.port })
      h.answers.push({ kind: 'hostkey', accept: false, remember: false })
      const err = await rejection(h.manager.connect(p.id))
      expect(err).toMatchObject({ code: 'EHOSTKEY' })
      expect(statuses(h.states, p.id).at(-1)).toBe('error')
      await expect(readFile(h.knownHosts.path)).rejects.toThrow()
      expect(h.registry.has(sshMachineId(p.id))).toBe(false)
    })

    it('reports a cancelled prompt as ECANCELLED and returns to disconnected', async () => {
      const p = await h.addProfile({ port: sshd.port })
      h.answers.push(null)
      expect(await rejection(h.manager.connect(p.id))).toMatchObject({ code: 'ECANCELLED' })
      expect(statuses(h.states, p.id).at(-1)).toBe('disconnected')
    })

    it('REFUSES a changed host key outright, never prompting and never rewriting known_hosts', async () => {
      const p = await h.addProfile({ port: sshd.port })
      const impostor = 'AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      const original = `[127.0.0.1]:${sshd.port} ssh-ed25519 ${impostor}\n`
      await writeFile(h.knownHosts.path, original)
      h.answers.push(h.trust) // would be fatal if it were ever consulted

      const err = await rejection(h.manager.connect(p.id))
      expect(err.code).toBe('EHOSTKEY')
      expect(err.message).toMatch(/CHANGED/)
      expect(err.message).toContain(h.knownHosts.path)
      expect(h.prompts).toHaveLength(0)
      expect(await readFile(h.knownHosts.path, 'utf8')).toBe(original)
      expect(h.registry.has(sshMachineId(p.id))).toBe(false)
    })

    it('refuses a revoked key', async () => {
      const p = await h.addProfile({ port: sshd.port })
      await writeFile(h.knownHosts.path, `@revoked [127.0.0.1]:${sshd.port} ${sshd.hostKeyLine}\n`)
      expect(await rejection(h.manager.connect(p.id))).toMatchObject({ code: 'EHOSTKEY' })
      expect(h.prompts).toHaveLength(0)
    })

    it('trusts a host already in known_hosts, including hashed entries', async () => {
      const p = await h.addProfile({ port: sshd.port })
      const { createHmac } = await import('node:crypto')
      const salt = Buffer.from('saltsaltsaltsaltsalt')
      const hash = createHmac('sha1', salt).update(`[127.0.0.1]:${sshd.port}`).digest()
      await writeFile(
        h.knownHosts.path,
        `|1|${salt.toString('base64')}|${hash.toString('base64')} ${sshd.hostKeyLine}\n`
      )
      await h.manager.connect(p.id)
      expect(h.prompts).toHaveLength(0)
    })
  })

  describe('authentication', () => {
    beforeEach(async () => {
      await writeFile(h.knownHosts.path, `[127.0.0.1]:${sshd.port} ${sshd.hostKeyLine}\n`)
    })

    it('logs in with an unencrypted key and exposes a working SFTP provider', async () => {
      const p = await h.addProfile({ port: sshd.port })
      await h.manager.connect(p.id)
      const provider = h.registry.get(sshMachineId(p.id))
      expect((await provider.home()).startsWith('/')).toBe(true)
      expect((await provider.list('/')).some((e) => e.name === 'etc')).toBe(true)
      expect(h.prompts).toHaveLength(0)
    })

    it('uses the profile default folder as home', async () => {
      const dir = await mkdtemp(join(h.dir, 'start-'))
      const p = await h.addProfile({ port: sshd.port, defaultPath: dir })
      await h.manager.connect(p.id)
      expect(await h.registry.get(sshMachineId(p.id)).home()).toBe(dir)
    })

    it('fails with EAUTH, without prompting, when the key is not authorized', async () => {
      const p = await h.addProfile({ port: sshd.port, identityFile: sshd.strangerKey })
      const err = await rejection(h.manager.connect(p.id))
      expect(err.code).toBe('EAUTH')
      expect(err.message).toMatch(/Authentication failed/)
      expect(statuses(h.states, p.id).at(-1)).toBe('error')
      expect(h.prompts.filter((x) => x.kind !== 'hostkey')).toHaveLength(0)
    })

    it('asks for a passphrase, connects, and remembers it only after success', async () => {
      const p = await h.addProfile({ port: sshd.port, identityFile: sshd.encryptedClientKey })
      h.answers.push({ kind: 'passphrase', value: PASSPHRASE, remember: true })
      await h.manager.connect(p.id)
      expect(h.prompts[0]).toMatchObject({
        kind: 'passphrase',
        keyPath: sshd.encryptedClientKey,
        retry: false,
        canRemember: true
      })
      expect(h.secrets.get(passphraseKey(sshd.encryptedClientKey))).toBe(PASSPHRASE)

      await h.manager.disconnect(p.id)
      await h.manager.connect(p.id)
      expect(h.prompts).toHaveLength(1) // used the remembered passphrase
    })

    it('does not remember a passphrase that was wrong', async () => {
      const p = await h.addProfile({ port: sshd.port, identityFile: sshd.encryptedClientKey })
      const wrong = { kind: 'passphrase', value: 'nope', remember: true } as const
      h.answers.push(wrong, wrong, wrong)
      expect(await rejection(h.manager.connect(p.id))).toMatchObject({ code: 'EAUTH' })
      expect(h.prompts.map((x) => (x as { retry: boolean }).retry)).toEqual([false, true, true])
      expect(h.secrets.get(passphraseKey(sshd.encryptedClientKey))).toBeUndefined()
    })

    it('recovers when the second passphrase is right', async () => {
      const p = await h.addProfile({ port: sshd.port, identityFile: sshd.encryptedClientKey })
      h.answers.push(
        { kind: 'passphrase', value: 'nope', remember: false },
        { kind: 'passphrase', value: PASSPHRASE, remember: false }
      )
      await h.manager.connect(p.id)
      expect(statuses(h.states, p.id).at(-1)).toBe('connected')
    })

    it('cancelling the passphrase prompt cancels the connection', async () => {
      const p = await h.addProfile({ port: sshd.port, identityFile: sshd.encryptedClientKey })
      h.answers.push(null)
      expect(await rejection(h.manager.connect(p.id))).toMatchObject({ code: 'ECANCELLED' })
      expect(statuses(h.states, p.id).at(-1)).toBe('disconnected')
    })

    it('resolves a profile linked to an ssh config alias at connect time', async () => {
      const aliased = await harness({
        sshConfig: `Host myalias\n  HostName 127.0.0.1\n  Port ${sshd.port}\n  IdentityFile ${sshd.clientKey}\n`
      })
      await writeFile(aliased.knownHosts.path, `[127.0.0.1]:${sshd.port} ${sshd.hostKeyLine}\n`)
      const p = await aliased.addProfile({
        host: 'stale.invalid',
        port: 9,
        sshAlias: 'myalias',
        identityFile: undefined
      })
      await aliased.manager.connect(p.id)
      expect(statuses(aliased.states, p.id).at(-1)).toBe('connected')
      await aliased.manager.shutdown()
    })
  })

  describe('connection errors', () => {
    it('explains a refused connection', async () => {
      const closed = await startProxy(1)
      await closed.stop()
      const p = await h.addProfile({ port: closed.port })
      const err = await rejection(h.manager.connect(p.id))
      expect(err).toMatchObject({ code: 'ECONNECT' })
      expect(err.message).toMatch(/refused/i)
      expect(statuses(h.states, p.id).at(-1)).toBe('error')
    })

    it('explains an unresolvable host', async () => {
      const p = await h.addProfile({ port: 22, host: 'no-such-host.invalid' })
      expect(await rejection(h.manager.connect(p.id))).toMatchObject({ code: 'ECONNECT' })
    })

    it('rejects an unknown profile', async () => {
      expect(await rejection(h.manager.connect('ghost'))).toBeInstanceOf(FsError)
    })
  })

  describe('lifecycle', () => {
    beforeEach(async () => {
      await writeFile(h.knownHosts.path, `[127.0.0.1]:${sshd.port} ${sshd.hostKeyLine}\n`)
    })

    it('shares one connection between simultaneous connect calls', async () => {
      const p = await h.addProfile({ port: sshd.port })
      await Promise.all([h.manager.connect(p.id), h.manager.connect(p.id), h.manager.connect(p.id)])
      expect(statuses(h.states, p.id).filter((s) => s === 'connecting')).toHaveLength(1)
      await h.manager.connect(p.id) // already connected: no-op
      expect(statuses(h.states, p.id).filter((s) => s === 'connecting')).toHaveLength(1)
    })

    it('disconnect unregisters the provider and reports disconnected', async () => {
      const p = await h.addProfile({ port: sshd.port })
      await h.manager.connect(p.id)
      await h.manager.disconnect(p.id)
      expect(h.registry.has(sshMachineId(p.id))).toBe(false)
      expect(statuses(h.states, p.id).at(-1)).toBe('disconnected')
      expect(h.manager.states()).toEqual([])
      await h.manager.disconnect(p.id) // idempotent
    })

    it('can reconnect after a disconnect', async () => {
      const p = await h.addProfile({ port: sshd.port })
      await h.manager.connect(p.id)
      await h.manager.disconnect(p.id)
      await h.manager.connect(p.id)
      expect(await h.registry.get(sshMachineId(p.id)).list('/')).not.toHaveLength(0)
    })

    it('lists states for connected profiles', async () => {
      const p = await h.addProfile({ port: sshd.port })
      await h.manager.connect(p.id)
      expect(h.manager.states()).toEqual([{ profileId: p.id, status: 'connected' }])
    })

    it('shutdown disconnects everything', async () => {
      const a = await h.addProfile({ port: sshd.port, name: 'A' })
      const b = await h.addProfile({ port: sshd.port, name: 'B' })
      await Promise.all([h.manager.connect(a.id), h.manager.connect(b.id)])
      await h.manager.shutdown()
      expect(h.manager.states()).toEqual([])
    })

    it('cancels an in-flight attempt when disconnect is called while a prompt is open', async () => {
      const p = await h.addProfile({ port: sshd.port })
      await rm(h.knownHosts.path, { force: true })
      h.answers.push(() => {
        void h.manager.disconnect(p.id)
        return null
      })
      expect(await rejection(h.manager.connect(p.id))).toMatchObject({ code: 'ECANCELLED' })
    })
  })

  describe('reconnecting', () => {
    let proxy: TcpProxy
    beforeEach(async () => {
      proxy = await startProxy(sshd.port)
      await writeFile(h.knownHosts.path, `[127.0.0.1]:${proxy.port} ${sshd.hostKeyLine}\n`)
    })
    afterEach(() => proxy.stop())

    it('notices a dropped connection, restores it without prompting, and keeps the provider usable', async () => {
      const p = await h.addProfile({ port: proxy.port })
      await h.manager.connect(p.id)
      const provider = h.registry.get(sshMachineId(p.id))
      const before = await provider.list('/')

      proxy.dropAll()
      await until(() => statuses(h.states, p.id).includes('reconnecting'))
      await until(() => statuses(h.states, p.id).at(-1) === 'connected')

      expect(h.registry.get(sshMachineId(p.id))).toBe(provider) // same provider, new channel
      expect(await provider.list('/')).toHaveLength(before.length)
      expect(h.prompts).toHaveLength(0)
    })

    it('fails file operations clearly while the connection is down', async () => {
      const p = await h.addProfile({ port: proxy.port })
      await h.manager.connect(p.id)
      const provider = h.registry.get(sshMachineId(p.id))
      await proxy.block()
      await until(() => statuses(h.states, p.id).includes('reconnecting'))
      expect(await rejection(provider.list('/'))).toMatchObject({ code: 'EDISCONNECTED' })
    })

    it('keeps retrying with increasing attempt numbers, then recovers once the network returns', async () => {
      const p = await h.addProfile({ port: proxy.port })
      await h.manager.connect(p.id)
      await proxy.block()
      await until(() => h.states.some((s) => s.status === 'reconnecting' && (s.attempt ?? 0) >= 2))
      await proxy.unblock()
      await until(() => statuses(h.states, p.id).at(-1) === 'connected')
    })

    it('gives up after the configured attempts and reports why', async () => {
      const p = await h.addProfile({ port: proxy.port })
      await h.manager.connect(p.id)
      await proxy.block()
      await until(() => statuses(h.states, p.id).at(-1) === 'disconnected', 8000)
      const last = h.states.at(-1)!
      expect(last.error).toMatch(/refused|reset|unreachable|lost/i)
    })

    it('a manual connect after giving up works', async () => {
      const p = await h.addProfile({ port: proxy.port })
      await h.manager.connect(p.id)
      await proxy.block()
      await until(() => statuses(h.states, p.id).at(-1) === 'disconnected', 8000)
      await proxy.unblock()
      await h.manager.connect(p.id)
      expect(statuses(h.states, p.id).at(-1)).toBe('connected')
    })

    it('does not reconnect after the user disconnects', async () => {
      const p = await h.addProfile({ port: proxy.port })
      await h.manager.connect(p.id)
      await h.manager.disconnect(p.id)
      proxy.dropAll()
      await new Promise((r) => setTimeout(r, 300))
      expect(statuses(h.states, p.id)).not.toContain('reconnecting')
    })

    it('stops retrying (no lockout loops) when the key is no longer accepted', async () => {
      const keyDir = await mkdtemp(join(h.dir, 'k-'))
      const keyCopy = join(keyDir, 'key')
      await writeFile(keyCopy, await readFile(sshd.clientKey), { mode: 0o600 })
      const p = await h.addProfile({ port: proxy.port, identityFile: keyCopy })
      await h.manager.connect(p.id)
      await writeFile(keyCopy, await readFile(sshd.strangerKey)) // swap in an unauthorized key
      proxy.dropAll()
      await until(() => statuses(h.states, p.id).at(-1) === 'disconnected', 8000)
      expect(h.states.at(-1)!.error).toMatch(/Authentication failed/)
      expect(
        statuses(h.states, p.id).filter((s) => s === 'reconnecting').length
      ).toBeLessThanOrEqual(2)
    })
  })

  describe('jump hosts', () => {
    let second: TestSshd
    beforeAll(async () => {
      second = await startSshd()
    })
    afterAll(() => second.stop())

    it('reaches a second host through the first, verifying both host keys', async () => {
      const jump = await h.addProfile({ port: sshd.port, name: 'Jump' })
      const target = await h.addProfile({
        port: second.port,
        name: 'Target',
        jumpHostId: jump.id,
        identityFile: second.clientKey
      })
      h.answers.push(h.trust, h.trust)
      await h.manager.connect(target.id)

      expect(h.prompts.map((p) => (p as { port: number }).port)).toEqual([sshd.port, second.port])
      expect(statuses(h.states, jump.id).at(-1)).toBe('connected')
      expect(statuses(h.states, target.id).at(-1)).toBe('connected')
      const dir = await mkdtemp(join(h.dir, 'via-'))
      await writeFile(join(dir, 'proof.txt'), 'x')
      expect((await h.registry.get(sshMachineId(target.id)).list(dir)).map((e) => e.name)).toEqual([
        'proof.txt'
      ])
    })

    it('reuses an existing jump connection', async () => {
      const jump = await h.addProfile({ port: sshd.port, name: 'Jump' })
      const target = await h.addProfile({
        port: second.port,
        name: 'Target',
        jumpHostId: jump.id,
        identityFile: second.clientKey
      })
      h.answers.push(h.trust)
      await h.manager.connect(jump.id)
      h.answers.push(h.trust)
      await h.manager.connect(target.id)
      expect(statuses(h.states, jump.id).filter((s) => s === 'connecting')).toHaveLength(1)
    })

    it('fails with a clear error when the jump host cannot be reached', async () => {
      const closed = await startProxy(1)
      await closed.stop()
      const jump = await h.addProfile({ port: closed.port, name: 'Jump' })
      const target = await h.addProfile({ port: second.port, name: 'Target', jumpHostId: jump.id })
      const err = await rejection(h.manager.connect(target.id))
      expect(err.code).toBe('ECONNECT')
    })

    it('does not silently reconnect a target while its jump host is down', async () => {
      const jump = await h.addProfile({ port: sshd.port, name: 'Jump' })
      const target = await h.addProfile({
        port: second.port,
        name: 'Target',
        jumpHostId: jump.id,
        identityFile: second.clientKey
      })
      h.answers.push(h.trust, h.trust)
      await h.manager.connect(target.id)
      await h.manager.disconnect(jump.id)
      await until(() => statuses(h.states, target.id).at(-1) === 'disconnected', 8000)
      expect(h.states.at(-1)!.error).toMatch(/jump host/i)
    })
  })
})

describe('ConnectionManager password and keyboard-interactive', () => {
  let h: Awaited<ReturnType<typeof harness>>
  let server: AuthServer
  beforeEach(async () => {
    h = await harness()
  })
  afterEach(async () => {
    await h.manager.shutdown()
    await server?.stop()
  })

  const profileFor = async (
    methods: ConnectionProfile['authMethods'],
    extra: Partial<ConnectionProfile> = {}
  ) => {
    await writeFile(h.knownHosts.path, `[127.0.0.1]:${server.port} ${server.hostKeyLine}\n`)
    return h.addProfile({
      port: server.port,
      authMethods: methods,
      identityFile: undefined,
      ...extra
    })
  }

  it('prompts for a password, connects, and saves it only because the user asked and it worked', async () => {
    server = await startAuthServer({ password: 'hunter2' })
    const p = await profileFor(['password'])
    h.answers.push({ kind: 'password', value: 'hunter2', remember: true })
    await h.manager.connect(p.id)
    expect(h.prompts[0]).toMatchObject({
      kind: 'password',
      username: userInfo().username,
      retry: false,
      canRemember: true
    })
    expect(h.secrets.get(passwordKey(p.id))).toBe('hunter2')

    // Next time no prompt at all.
    await h.manager.disconnect(p.id)
    await h.manager.connect(p.id)
    expect(h.prompts).toHaveLength(1)
  })

  it('retries after a wrong password with retry=true, and a wrong password is never saved', async () => {
    server = await startAuthServer({ password: 'right' })
    const p = await profileFor(['password'])
    h.answers.push(
      { kind: 'password', value: 'wrong', remember: true },
      { kind: 'password', value: 'right', remember: false }
    )
    await h.manager.connect(p.id)
    expect(h.prompts.map((x) => (x as { retry: boolean }).retry)).toEqual([false, true])
    expect(h.secrets.get(passwordKey(p.id))).toBeUndefined()
  })

  it('stops after three wrong passwords with EAUTH', async () => {
    server = await startAuthServer({ password: 'right' })
    const p = await profileFor(['password'])
    const wrong = { kind: 'password', value: 'wrong', remember: false } as const
    h.answers.push(wrong, wrong, wrong)
    expect(await rejection(h.manager.connect(p.id))).toMatchObject({ code: 'EAUTH' })
    expect(h.prompts.filter((x) => x.kind === 'password')).toHaveLength(3)
  })

  it('cancelling the password prompt cancels the connection', async () => {
    server = await startAuthServer({ password: 'x' })
    const p = await profileFor(['password'])
    h.answers.push(null)
    expect(await rejection(h.manager.connect(p.id))).toMatchObject({ code: 'ECANCELLED' })
    expect(statuses(h.states, p.id).at(-1)).toBe('disconnected')
  })

  it('discards a stored password the server rejects, so the user is asked again', async () => {
    server = await startAuthServer({ password: 'new' })
    const p = await profileFor(['password'])
    await h.secrets.set(passwordKey(p.id), 'stale')
    h.answers.push({ kind: 'password', value: 'new', remember: false })
    await h.manager.connect(p.id)
    // The saved password counted as the first attempt, so this prompt is a retry.
    expect(h.prompts[0]).toMatchObject({ kind: 'password', retry: true })
    expect(h.secrets.get(passwordKey(p.id))).toBeUndefined()
  })

  it('relays keyboard-interactive prompts (e.g. a one-time code)', async () => {
    server = await startAuthServer({
      keyboard: { prompts: [{ prompt: 'Code: ', echo: true }], answers: ['424242'] }
    })
    const p = await profileFor(['keyboard-interactive'])
    h.answers.push({ kind: 'keyboard-interactive', answers: ['424242'] })
    await h.manager.connect(p.id)
    expect(h.prompts[0]).toMatchObject({
      kind: 'keyboard-interactive',
      prompts: [{ prompt: 'Code: ', echo: true }]
    })
  })

  it('fails with EAUTH on wrong keyboard-interactive answers', async () => {
    server = await startAuthServer({
      keyboard: { prompts: [{ prompt: 'Code: ', echo: true }], answers: ['424242'] }
    })
    const p = await profileFor(['keyboard-interactive'])
    h.answers.push({ kind: 'keyboard-interactive', answers: ['000000'] })
    expect(await rejection(h.manager.connect(p.id))).toMatchObject({ code: 'EAUTH' })
  })

  it('skips the password method, without asking for one, when the server only offers keyboard-interactive', async () => {
    server = await startAuthServer({
      keyboard: { prompts: [{ prompt: 'Code: ', echo: true }], answers: ['7'] }
    })
    const p = await profileFor(['password', 'keyboard-interactive'])
    h.answers.push({ kind: 'keyboard-interactive', answers: ['7'] })
    await h.manager.connect(p.id)
    expect(h.prompts.map((x) => x.kind)).toEqual(['keyboard-interactive'])
  })

  it('never reconnects with a prompt: a dropped password session restores itself from memory', async () => {
    server = await startAuthServer({ password: 'pw' })
    const proxy = await startProxy(server.port)
    await writeFile(h.knownHosts.path, `[127.0.0.1]:${proxy.port} ${server.hostKeyLine}\n`)
    const p = await h.addProfile({
      port: proxy.port,
      authMethods: ['password'],
      identityFile: undefined
    })
    h.answers.push({ kind: 'password', value: 'pw', remember: false })
    await h.manager.connect(p.id)
    proxy.dropAll()
    await until(() => statuses(h.states, p.id).includes('reconnecting'))
    await until(() => statuses(h.states, p.id).at(-1) === 'connected')
    expect(h.prompts.filter((x) => x.kind === 'password')).toHaveLength(1)
    await proxy.stop()
  })
})
