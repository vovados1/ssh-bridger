import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_AUTH_METHODS, type ConnectionProfileInput } from '@shared/connections'
import { ProfileStore } from '../../src/main/store/profile-store'
import {
  SecretStore,
  passphraseKey,
  passwordKey,
  type Cipher
} from '../../src/main/store/secret-store'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bridger-store-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const input = (over: Partial<ConnectionProfileInput> = {}): ConnectionProfileInput => ({
  name: 'Prod',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  authMethods: [...DEFAULT_AUTH_METHODS],
  ...over
})

describe('ProfileStore', () => {
  const open = async () => {
    const store = new ProfileStore(join(dir, 'profiles.json'))
    await store.load()
    return store
  }

  it('creates profiles with generated ids and persists them across restarts', async () => {
    const store = await open()
    const a = await store.save(input())
    const b = await store.save(input({ name: 'Staging', host: 'stg' }))
    expect(a.id).not.toBe(b.id)
    expect((await open()).list().map((p) => p.name)).toEqual(['Prod', 'Staging'])
  })

  it('updates in place by id and refuses unknown ids', async () => {
    const store = await open()
    const p = await store.save(input())
    await store.save({ ...input({ name: 'Renamed' }), id: p.id })
    expect(store.list()).toHaveLength(1)
    expect(store.get(p.id)?.name).toBe('Renamed')
    await expect(store.save({ ...input(), id: 'ghost' })).rejects.toThrow(/no longer exists/)
  })

  it('trims text and drops blank optional fields', async () => {
    const store = await open()
    const p = await store.save(
      input({ name: '  Prod  ', identityFile: '   ', defaultPath: ' /srv ', sshAlias: '' })
    )
    expect(p.name).toBe('Prod')
    expect(p.defaultPath).toBe('/srv')
    expect('identityFile' in p).toBe(false)
    expect('sshAlias' in p).toBe(false)
  })

  it('rejects invalid input with a readable message', async () => {
    const store = await open()
    await expect(store.save(input({ name: ' ' }))).rejects.toThrow(/name/i)
    await expect(store.save(input({ host: 'a b' }))).rejects.toThrow(/spaces/)
    await expect(store.save(input({ port: 0 }))).rejects.toThrow()
    await expect(store.save(input({ authMethods: [] }))).rejects.toThrow(/at least one/)
    await expect(store.save(input({ defaultPath: 'relative' }))).rejects.toThrow(/absolute/)
    expect(store.list()).toEqual([])
  })

  it('validates jump hosts: must exist, no self-reference, no cycles', async () => {
    const store = await open()
    const a = await store.save(input({ name: 'A' }))
    const b = await store.save(input({ name: 'B', jumpHostId: a.id }))
    await expect(store.save(input({ jumpHostId: 'ghost' }))).rejects.toThrow(/no longer exists/)
    await expect(
      store.save({ ...input({ name: 'A', jumpHostId: a.id }), id: a.id })
    ).rejects.toThrow(/own jump host/)
    await expect(
      store.save({ ...input({ name: 'A', jumpHostId: b.id }), id: a.id })
    ).rejects.toThrow(/own jump host/)
  })

  it('refuses to delete a profile that is somebody’s jump host', async () => {
    const store = await open()
    const a = await store.save(input({ name: 'A' }))
    const b = await store.save(input({ name: 'B', jumpHostId: a.id }))
    await expect(store.delete(a.id)).rejects.toThrow(/jump host of "B"/)
    await store.delete(b.id)
    await store.delete(a.id)
    expect(store.list()).toEqual([])
  })

  it('finds by alias', async () => {
    const store = await open()
    const p = await store.save(input({ sshAlias: 'prod' }))
    expect(store.findByAlias('prod')?.id).toBe(p.id)
    expect(store.findByAlias('nope')).toBeUndefined()
  })

  it('writes private files and leaves no temp files behind', async () => {
    const store = await open()
    await store.save(input())
    const { mode } = await import('node:fs/promises').then((fs) =>
      fs.stat(join(dir, 'profiles.json'))
    )
    expect(mode & 0o777).toBe(0o600)
    expect(await readdir(dir)).toEqual(['profiles.json'])
  })

  it('serializes concurrent saves without losing any', async () => {
    const store = await open()
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.save(input({ name: `P${i}` }))))
    expect((await open()).list()).toHaveLength(20)
  })

  it('quarantines a corrupt file and starts empty instead of crashing or overwriting it', async () => {
    await writeFile(join(dir, 'profiles.json'), '{ not json')
    const store = await open()
    expect(store.list()).toEqual([])
    const files = await readdir(dir)
    expect(files.some((f) => f.startsWith('profiles.json.corrupt-'))).toBe(true)
    await store.save(input())
    expect((await open()).list()).toHaveLength(1)
  })

  it('quarantines a file that parses but has the wrong shape', async () => {
    await writeFile(
      join(dir, 'profiles.json'),
      JSON.stringify({ version: 1, profiles: [{ id: 1 }] })
    )
    expect((await open()).list()).toEqual([])
  })
})

/** Reversible stand-in for the keyring that makes plaintext leaks obvious. */
const fakeCipher = (available = true): Cipher => ({
  isAvailable: () => available,
  encrypt: (plain) => Buffer.from([...Buffer.from(plain)].map((b) => b ^ 0x5a)),
  decrypt: (data) => Buffer.from([...data].map((b) => b ^ 0x5a)).toString()
})

describe('SecretStore', () => {
  const open = async (cipher: Cipher = fakeCipher()) => {
    const store = new SecretStore(join(dir, 'secrets.json'), cipher)
    await store.load()
    return store
  }

  it('round-trips secrets across restarts and never writes plaintext', async () => {
    const store = await open()
    expect(await store.set(passwordKey('p1'), 'hunter2')).toBe(true)
    expect(await store.set(passphraseKey('/home/me/.ssh/id_rsa'), 'open sesame')).toBe(true)
    const onDisk = await readFile(join(dir, 'secrets.json'), 'utf8')
    expect(onDisk).not.toContain('hunter2')
    expect(onDisk).not.toContain('open sesame')
    const again = await open()
    expect(again.get(passwordKey('p1'))).toBe('hunter2')
    expect(again.get(passphraseKey('/home/me/.ssh/id_rsa'))).toBe('open sesame')
  })

  it('stores nothing and returns nothing when there is no keyring', async () => {
    const store = await open(fakeCipher(false))
    expect(store.available).toBe(false)
    expect(await store.set('k', 'v')).toBe(false)
    expect(store.get('k')).toBeUndefined()
    await expect(readFile(join(dir, 'secrets.json'))).rejects.toThrow()
  })

  it('ignores entries it can no longer decrypt', async () => {
    const store = await open()
    await store.set('k', 'v')
    const broken: Cipher = {
      ...fakeCipher(),
      decrypt: () => {
        throw new Error('keyring locked')
      }
    }
    expect((await open(broken)).get('k')).toBeUndefined()
  })

  it('deletes single keys and everything for a profile', async () => {
    const store = await open()
    await store.set(passwordKey('p1'), 'a')
    await store.set(passwordKey('p2'), 'b')
    await store.deleteProfile('p1')
    expect(store.get(passwordKey('p1'))).toBeUndefined()
    expect(store.get(passwordKey('p2'))).toBe('b')
    await store.delete('missing') // no-op
  })

  it('quarantines a corrupt file', async () => {
    await writeFile(join(dir, 'secrets.json'), 'garbage')
    const store = await open()
    expect(store.get('k')).toBeUndefined()
    expect((await readdir(dir)).some((f) => f.includes('.corrupt-'))).toBe(true)
  })
})
