import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConnectionProfile } from '@shared/connections'
import { importAliases } from '../../src/main/ssh/import'
import {
  applyAlias,
  listAliases,
  listCandidates,
  parseProxyJump,
  resolveHost
} from '../../src/main/ssh/ssh-config'
import { ProfileStore } from '../../src/main/store/profile-store'

const CONFIG = `
Host bastion
  HostName bastion.example.com
  User ops
  Port 2222

Host web db
  HostName %h.internal.example.com
  ProxyJump bastion

Host plain
  HostName 10.0.0.5

Host *.corp
  User corpuser

Host direct.corp
  ProxyJump none

Host !skipme staging-*
  HostName never

Host *
  User defaultuser
  IdentityFile ~/.ssh/id_default
`

describe('resolveHost', () => {
  it('merges Host * defaults with the specific block', () => {
    expect(resolveHost(CONFIG, 'bastion', '/home/me')).toEqual({
      hostName: 'bastion.example.com',
      user: 'ops', // more specific blocks come first, so they win over Host *
      port: 2222,
      identityFile: '/home/me/.ssh/id_default'
    })
  })

  it('falls back to the alias itself and port 22', () => {
    const r = resolveHost(CONFIG, 'unknown-host', '/home/me')
    expect(r).toMatchObject({ hostName: 'unknown-host', port: 22, user: 'defaultuser' })
  })

  it('applies wildcard blocks and understands ProxyJump none', () => {
    expect(resolveHost(CONFIG, 'x.corp', '/h').user).toBe('corpuser')
    expect(resolveHost(CONFIG, 'direct.corp', '/h').proxyJump).toBeUndefined()
    expect(resolveHost(CONFIG, 'web', '/h').proxyJump).toBe('bastion')
  })

  it('uses the first value found, as ssh does, so an early Host * overrides later blocks', () => {
    const text = 'Host *\n  User first\nHost a\n  User second'
    expect(resolveHost(text, 'a', '/h').user).toBe('first')
  })

  it('expands ~ in IdentityFile', () => {
    expect(resolveHost('Host a\n  IdentityFile ~/k/id', 'a', '/home/me').identityFile).toBe(
      '/home/me/k/id'
    )
  })

  it('copes with an empty config', () => {
    expect(resolveHost('', 'h', '/h')).toEqual({ hostName: 'h', port: 22 })
  })
})

describe('listAliases / listCandidates', () => {
  it('lists concrete aliases only, once each, in file order', () => {
    expect(listAliases(CONFIG)).toEqual(['bastion', 'web', 'db', 'plain', 'direct.corp'])
  })

  it('describes candidates and marks imported ones', () => {
    const list = listCandidates(CONFIG, new Set(['plain']), '/h')
    expect(list.map((c) => [c.alias, c.imported])).toEqual([
      ['bastion', false],
      ['web', false],
      ['db', false],
      ['plain', true],
      ['direct.corp', false]
    ])
    expect(list.find((c) => c.alias === 'bastion')).toMatchObject({
      hostName: 'bastion.example.com',
      port: 2222
    })
    expect(list.find((c) => c.alias === 'web')?.proxyJump).toBe('bastion')
  })
})

describe('parseProxyJump', () => {
  it('reads user, host and port from the first hop', () => {
    expect(parseProxyJump('bastion')).toEqual({ host: 'bastion', port: 22 })
    expect(parseProxyJump('me@jump.example.com:2200,other')).toEqual({
      user: 'me',
      host: 'jump.example.com',
      port: 2200
    })
    expect(parseProxyJump('[::1]:2200')).toEqual({ host: '::1', port: 2200 })
    expect(parseProxyJump('')).toBeNull()
  })
})

describe('applyAlias', () => {
  const base: ConnectionProfile = {
    id: 'p',
    name: 'Prod',
    host: 'stale.example.com',
    port: 22,
    username: 'saved',
    authMethods: ['agent'],
    sshAlias: 'bastion'
  }

  it('re-reads the linked alias, so edits to ssh config apply on the next connect', () => {
    expect(applyAlias(base, CONFIG, '/h')).toMatchObject({
      host: 'bastion.example.com',
      port: 2222,
      username: 'ops',
      identityFile: '/h/.ssh/id_default'
    })
  })

  it('leaves unlinked profiles and missing config untouched', () => {
    const unlinked = { ...base, sshAlias: undefined }
    delete unlinked.sshAlias
    expect(applyAlias(unlinked, CONFIG)).toBe(unlinked)
    expect(applyAlias(base, null)).toBe(base)
  })

  it('keeps the profile identity file when the config names none', () => {
    const p = { ...base, identityFile: '/keys/mine', sshAlias: 'plain' }
    expect(applyAlias(p, 'Host plain\n  HostName 10.0.0.5', '/h').identityFile).toBe('/keys/mine')
  })
})

describe('importAliases', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bridger-import-'))
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  const fresh = async (name: string) => {
    const store = new ProfileStore(join(dir, `${name}.json`))
    await store.load()
    return store
  }

  it('creates linked profiles with resolved settings', async () => {
    const store = await fresh('simple')
    const created = await importAliases(store, CONFIG, ['plain'], '/h')
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      name: 'plain',
      host: '10.0.0.5',
      port: 22,
      username: 'defaultuser',
      sshAlias: 'plain',
      identityFile: '/h/.ssh/id_default'
    })
  })

  it('imports a ProxyJump alias too and links it as the jump host', async () => {
    const store = await fresh('jump')
    const created = await importAliases(store, CONFIG, ['web'], '/h')
    expect(created.map((p) => p.name)).toEqual(['bastion', 'web'])
    const web = created.find((p) => p.name === 'web')!
    expect(web.jumpHostId).toBe(created.find((p) => p.name === 'bastion')!.id)
  })

  it('skips aliases already imported and unknown ones, and reuses an imported jump host', async () => {
    const store = await fresh('dupes')
    await importAliases(store, CONFIG, ['bastion'], '/h')
    const created = await importAliases(store, CONFIG, ['bastion', 'nonexistent', 'db'], '/h')
    expect(created.map((p) => p.name)).toEqual(['db'])
    expect(created[0]!.jumpHostId).toBe(store.findByAlias('bastion')!.id)
    expect(store.list()).toHaveLength(2)
  })

  it('makes a bare profile for a jump host that is not in the config', async () => {
    const store = await fresh('adhoc')
    const text = 'Host inner\n  HostName inner.lan\n  ProxyJump gw.example.com:2200'
    const created = await importAliases(store, text, ['inner'], '/h')
    expect(created.map((p) => [p.name, p.host, p.port])).toEqual([
      ['gw.example.com', 'gw.example.com', 2200],
      ['inner', 'inner.lan', 22]
    ])
  })

  it('survives a ProxyJump loop', async () => {
    const store = await fresh('loop')
    const text = 'Host a\n  ProxyJump b\nHost b\n  ProxyJump a'
    const created = await importAliases(store, text, ['a'], '/h')
    expect(created.length).toBeGreaterThan(0)
    expect(created.length).toBeLessThanOrEqual(6)
  })
})
