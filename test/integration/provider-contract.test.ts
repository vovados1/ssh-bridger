import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FsError } from '@shared/fs-types'
import { sshMachineId } from '@shared/connections'
import { LocalProvider } from '../../src/main/fs/local-provider'
import { MachineRegistry } from '../../src/main/fs/registry'
import type { FileSystemProvider } from '../../src/main/fs/provider'
import { ConnectionManager } from '../../src/main/ssh/connection-manager'
import { KnownHostsFile } from '../../src/main/ssh/known-hosts'
import { silentPrompter } from '../../src/main/ssh/prompter'
import { ProfileStore } from '../../src/main/store/profile-store'
import { SecretStore } from '../../src/main/store/secret-store'
import { sshdAvailable, startSshd, type TestSshd } from '../helpers/sshd'

/**
 * One behavioural spec for every FileSystemProvider. The tests build their fixtures with
 * plain node:fs in a temp folder and check results both through the provider and on disk.
 * The sshd runs as the current user on this machine, so the same folder is visible to the
 * SFTP provider: any difference between providers is a bug in one of them.
 */
interface Backend {
  name: string
  /** Does the machine have a Trash? */
  trash: boolean
  setup(): Promise<{ provider: FileSystemProvider; teardown(): Promise<void> }>
}

let root: string
let sshd: TestSshd | undefined
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bridger-contract-'))
  if (sshdAvailable) sshd = await startSshd()
})
afterAll(async () => {
  await sshd?.stop()
  await rm(root, { recursive: true, force: true })
})

const trashed: string[] = []
const local: Backend = {
  name: 'LocalProvider',
  trash: true,
  async setup() {
    const provider = new LocalProvider({
      trash: async (path) => {
        trashed.push(path)
        await rm(path, { recursive: true })
      }
    })
    return { provider, teardown: async () => {} }
  }
}

const sftp: Backend = {
  name: 'SftpProvider (real sshd)',
  trash: false,
  async setup() {
    const server = sshd!
    const dir = await mkdtemp(join(root, 'sftp-'))
    const profiles = new ProfileStore(join(dir, 'profiles.json'))
    await profiles.load()
    const knownHosts = new KnownHostsFile(join(dir, 'known_hosts'))
    await knownHosts.add('127.0.0.1', server.port, 'ssh-ed25519', server.hostKeyLine.split(' ')[1]!)
    const registry = new MachineRegistry()
    const manager = new ConnectionManager({
      profiles,
      secrets: new SecretStore(join(dir, 'secrets.json'), {
        isAvailable: () => false,
        encrypt: () => Buffer.alloc(0),
        decrypt: () => ''
      }),
      prompter: silentPrompter,
      knownHosts,
      registry,
      readSshConfig: async () => null,
      agentSocket: undefined,
      localUsername: userInfo().username,
      homeDir: dir,
      onState: () => {}
    })
    const profile = await profiles.save({
      name: 'contract',
      host: '127.0.0.1',
      port: server.port,
      username: userInfo().username,
      authMethods: ['publickey'],
      identityFile: server.clientKey
    })
    await manager.connect(profile.id)
    return { provider: registry.get(sshMachineId(profile.id)), teardown: () => manager.shutdown() }
  }
}

const byName = <T extends { name: string }>(xs: T[]): Record<string, T> =>
  Object.fromEntries(xs.map((x) => [x.name, x]))
const isRoot = process.getuid?.() === 0

for (const backend of [local, sftp]) {
  describe.skipIf(backend === sftp && !sshdAvailable)(
    `FileSystemProvider contract: ${backend.name}`,
    () => {
      let p: FileSystemProvider
      let teardown: () => Promise<void>
      let n = 0
      beforeAll(async () => {
        ;({ provider: p, teardown } = await backend.setup())
      })
      afterAll(() => teardown())

      async function fresh(): Promise<string> {
        const dir = join(root, `${backend === local ? 'l' : 's'}-${n++}`)
        await mkdir(dir)
        return dir
      }

      describe('list', () => {
        it('returns an empty array for an empty folder', async () => {
          expect(await p.list(await fresh())).toEqual([])
        })

        it('describes files, folders and dotfiles, never including . or ..', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'a.txt'), 'hello')
          await writeFile(join(dir, '.hidden'), '')
          await mkdir(join(dir, 'sub'))
          await chmod(join(dir, 'a.txt'), 0o640)
          const entries = byName(await p.list(dir))
          expect(Object.keys(entries).sort()).toEqual(['.hidden', 'a.txt', 'sub'])
          expect(entries['a.txt']).toMatchObject({
            type: 'file',
            size: 5,
            mode: 0o640,
            path: join(dir, 'a.txt')
          })
          expect(entries['a.txt']!.mtime).toBeGreaterThan(0)
          expect(entries['sub']!.type).toBe('dir')
        })

        it('reports modification times in milliseconds', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'f'), '')
          const [entry] = await p.list(dir)
          const real = (await lstat(join(dir, 'f'))).mtimeMs
          expect(Math.abs(entry!.mtime - real)).toBeLessThan(2000)
        })

        it('describes symlinks to files, folders and nothing', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'file'), 'x')
          await mkdir(join(dir, 'folder'))
          await symlink('file', join(dir, 'to-file'))
          await symlink(join(dir, 'folder'), join(dir, 'to-folder'))
          await symlink('missing', join(dir, 'dangling'))
          await symlink('loop2', join(dir, 'loop1'))
          await symlink('loop1', join(dir, 'loop2'))
          const entries = byName(await p.list(dir))
          expect(entries['to-file']).toMatchObject({
            type: 'symlink',
            linkTarget: 'file',
            linkTargetType: 'file'
          })
          expect(entries['to-folder']).toMatchObject({ type: 'symlink', linkTargetType: 'dir' })
          expect(entries['dangling']).toMatchObject({
            type: 'symlink',
            linkTarget: 'missing',
            linkTargetType: 'broken'
          })
          expect(entries['loop1']).toMatchObject({ type: 'symlink', linkTargetType: 'broken' })
        })

        it('handles unusual names', async () => {
          const dir = await fresh()
          const names = ['with space', 'üñíçødé', 'new\nline', '--dash', '#hash', "it's", 'a"b']
          for (const name of names) await writeFile(join(dir, name), '')
          expect((await p.list(dir)).map((e) => e.name).sort()).toEqual([...names].sort())
        })

        it('lists large folders completely', async () => {
          const dir = await fresh()
          await Promise.all(
            Array.from({ length: 3000 }, (_, i) => writeFile(join(dir, `f${i}`), ''))
          )
          const entries = await p.list(dir)
          expect(entries).toHaveLength(3000)
          expect(new Set(entries.map((e) => e.name)).size).toBe(3000)
        })

        it('maps errors onto FsError codes', async () => {
          const file = join(await fresh(), 'plain')
          await writeFile(file, '')
          await expect(p.list(join(root, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' })
          await expect(p.list(file)).rejects.toMatchObject({ code: 'ENOTDIR' })
          await expect(p.list(join(root, 'nope'))).rejects.toBeInstanceOf(FsError)
        })

        it.skipIf(isRoot)('reports permission errors', async () => {
          const dir = join(await fresh(), 'locked')
          await mkdir(dir)
          await chmod(dir, 0o000)
          try {
            await expect(p.list(dir)).rejects.toMatchObject({ code: 'EACCES' })
          } finally {
            await chmod(dir, 0o700)
          }
        })
      })

      describe('stat / realpath / details / home', () => {
        it('stats a single entry with its own name', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'f'), 'abc')
          expect(await p.stat(join(dir, 'f'))).toMatchObject({
            name: 'f',
            type: 'file',
            size: 3,
            path: join(dir, 'f')
          })
          await expect(p.stat(join(dir, 'gone'))).rejects.toMatchObject({ code: 'ENOENT' })
        })

        it('stats the root and describes a symlink without following it', async () => {
          expect(await p.stat('/')).toMatchObject({ name: '/', type: 'dir' })
          const dir = await fresh()
          await symlink('target', join(dir, 'l'))
          expect(await p.stat(join(dir, 'l'))).toMatchObject({
            type: 'symlink',
            linkTarget: 'target',
            linkTargetType: 'broken'
          })
        })

        it('resolves symlinks with realpath', async () => {
          const dir = await fresh()
          await mkdir(join(dir, 'target'))
          await symlink(join(dir, 'target'), join(dir, 'alias'))
          expect(await p.realpath(join(dir, 'alias'))).toBe(await p.realpath(join(dir, 'target')))
          await expect(p.realpath(join(dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
        })

        it('adds ids and times in details', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'f'), 'abc')
          const d = await p.details(join(dir, 'f'))
          expect(d).toMatchObject({
            name: 'f',
            type: 'file',
            size: 3,
            uid: process.getuid?.(),
            gid: process.getgid?.()
          })
          expect(d.atime).toBeGreaterThan(0)
          expect(d.ctime).toBeGreaterThan(0)
          await expect(p.details(join(dir, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' })
        })

        it('knows an absolute home directory', async () => {
          expect((await p.home()).startsWith('/')).toBe(true)
        })
      })

      describe('mkdir / createFile', () => {
        it('creates a folder and an empty file', async () => {
          const dir = await fresh()
          await p.mkdir(join(dir, 'sub'))
          await p.createFile(join(dir, 'a.txt'))
          expect((await lstat(join(dir, 'sub'))).isDirectory()).toBe(true)
          expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('')
        })

        it('refuses to clobber: EEXIST, and existing content survives', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'keep'), 'precious')
          await expect(p.createFile(join(dir, 'keep'))).rejects.toMatchObject({ code: 'EEXIST' })
          await expect(p.mkdir(join(dir, 'keep'))).rejects.toMatchObject({ code: 'EEXIST' })
          await mkdir(join(dir, 'folder'))
          await expect(p.mkdir(join(dir, 'folder'))).rejects.toMatchObject({ code: 'EEXIST' })
          expect(await readFile(join(dir, 'keep'), 'utf8')).toBe('precious')
        })

        it('does not create missing parents', async () => {
          const dir = await fresh()
          await expect(p.mkdir(join(dir, 'a', 'b'))).rejects.toMatchObject({ code: 'ENOENT' })
          await expect(p.createFile(join(dir, 'a', 'b'))).rejects.toMatchObject({ code: 'ENOENT' })
        })

        it('creates names with spaces and unicode', async () => {
          const dir = await fresh()
          await p.mkdir(join(dir, 'My Folder ünï'))
          await p.createFile(join(dir, 'new file.txt'))
          expect((await readdir(dir)).sort()).toEqual(['My Folder ünï', 'new file.txt'])
        })
      })

      describe('rename', () => {
        it('renames files and folders', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'old.txt'), 'x')
          await mkdir(join(dir, 'olddir'))
          await p.rename(join(dir, 'old.txt'), join(dir, 'new.txt'))
          await p.rename(join(dir, 'olddir'), join(dir, 'newdir'))
          expect((await readdir(dir)).sort()).toEqual(['new.txt', 'newdir'])
          expect(await readFile(join(dir, 'new.txt'), 'utf8')).toBe('x')
        })

        it('moves into another folder on the same machine', async () => {
          const dir = await fresh()
          await mkdir(join(dir, 'dest'))
          await writeFile(join(dir, 'f'), 'x')
          await p.rename(join(dir, 'f'), join(dir, 'dest', 'f'))
          expect(await readdir(join(dir, 'dest'))).toEqual(['f'])
        })

        it('never overwrites an existing target', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'a'), 'A')
          await writeFile(join(dir, 'b'), 'B')
          await expect(p.rename(join(dir, 'a'), join(dir, 'b'))).rejects.toMatchObject({
            code: 'EEXIST',
            message: '"b" already exists'
          })
          expect(await readFile(join(dir, 'b'), 'utf8')).toBe('B')
          expect(await readFile(join(dir, 'a'), 'utf8')).toBe('A')
        })

        it('treats a dangling symlink as taking the name', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'a'), '')
          await symlink('nowhere', join(dir, 'ghost'))
          await expect(p.rename(join(dir, 'a'), join(dir, 'ghost'))).rejects.toMatchObject({
            code: 'EEXIST'
          })
        })

        it('reports a missing source', async () => {
          const dir = await fresh()
          await expect(p.rename(join(dir, 'nope'), join(dir, 'x'))).rejects.toMatchObject({
            code: 'ENOENT'
          })
        })
      })

      describe('remove', () => {
        const permanent = { recursive: false, toTrash: false }

        it('deletes a file and an empty folder', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'f'), '')
          await mkdir(join(dir, 'd'))
          await p.remove(join(dir, 'f'), permanent)
          await p.remove(join(dir, 'd'), permanent)
          expect(await readdir(dir)).toEqual([])
        })

        it('needs recursive for a non-empty folder, then removes the whole tree', async () => {
          const dir = await fresh()
          await mkdir(join(dir, 'tree/a/b'), { recursive: true })
          await writeFile(join(dir, 'tree/a/b/f'), '')
          await writeFile(join(dir, 'tree/top'), '')
          await writeFile(join(dir, 'tree/.hidden'), '')
          await expect(p.remove(join(dir, 'tree'), permanent)).rejects.toMatchObject({
            code: 'ENOTEMPTY'
          })
          expect((await readdir(join(dir, 'tree'))).length).toBe(3) // nothing was deleted by the refusal
          await p.remove(join(dir, 'tree'), { recursive: true, toTrash: false })
          expect(await readdir(dir)).toEqual([])
        })

        it('removes a wide and deep tree', async () => {
          const dir = await fresh()
          for (let i = 0; i < 30; i++) {
            await mkdir(join(dir, 'tree', `d${i}`, 'x'), { recursive: true })
            await writeFile(join(dir, 'tree', `d${i}`, 'x', 'f'), '')
            await writeFile(join(dir, 'tree', `f${i}`), '')
          }
          await p.remove(join(dir, 'tree'), { recursive: true, toTrash: false })
          expect(await readdir(dir)).toEqual([])
        })

        it('removes a symlink without touching its target, even when it points at a folder', async () => {
          const dir = await fresh()
          await mkdir(join(dir, 'target'))
          await writeFile(join(dir, 'target/keep'), '')
          await symlink(join(dir, 'target'), join(dir, 'link'))
          await p.remove(join(dir, 'link'), { recursive: true, toTrash: false })
          expect((await readdir(dir)).sort()).toEqual(['target'])
          expect(await readdir(join(dir, 'target'))).toEqual(['keep'])
        })

        it('unlinks symlinks found inside a tree instead of following them', async () => {
          const dir = await fresh()
          await mkdir(join(dir, 'outside'))
          await writeFile(join(dir, 'outside/precious'), '')
          await mkdir(join(dir, 'tree'))
          await symlink(join(dir, 'outside'), join(dir, 'tree/escape'))
          await p.remove(join(dir, 'tree'), { recursive: true, toTrash: false })
          expect(await readdir(join(dir, 'outside'))).toEqual(['precious'])
        })

        it('reports a missing path', async () => {
          const dir = await fresh()
          await expect(
            p.remove(join(dir, 'nope'), { recursive: true, toTrash: false })
          ).rejects.toMatchObject({ code: 'ENOENT' })
        })

        it('refuses to delete the root', async () => {
          await expect(p.remove('/', { recursive: true, toTrash: false })).rejects.toBeInstanceOf(
            FsError
          )
        })

        if (backend.trash) {
          it('sends items to the trash helper instead of deleting directly', async () => {
            const dir = await fresh()
            await writeFile(join(dir, 'f'), '')
            await p.remove(join(dir, 'f'), { recursive: false, toTrash: true })
            expect(trashed).toContain(join(dir, 'f'))
          })
        } else {
          it('has no Trash: asking for it fails and deletes nothing', async () => {
            const dir = await fresh()
            await writeFile(join(dir, 'f'), 'keep')
            await expect(
              p.remove(join(dir, 'f'), { recursive: false, toTrash: true })
            ).rejects.toThrow(/no Trash/i)
            expect(await readFile(join(dir, 'f'), 'utf8')).toBe('keep')
          })
        }
      })

      describe('chmod', () => {
        it('sets permission bits including special ones', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'f'), '')
          await p.chmod(join(dir, 'f'), 0o640)
          expect((await p.stat(join(dir, 'f'))).mode).toBe(0o640)
          expect((await lstat(join(dir, 'f'))).mode & 0o7777).toBe(0o640)
          await p.chmod(join(dir, 'f'), 0o2755)
          expect((await p.stat(join(dir, 'f'))).mode).toBe(0o2755)
        })

        it('reports a missing path', async () => {
          await expect(p.chmod(join(root, 'nope'), 0o644)).rejects.toMatchObject({ code: 'ENOENT' })
        })
      })
    }
  )
}

describe('provider differences that are intentional', () => {
  it('only the local provider can watch folders', async () => {
    expect(typeof new LocalProvider().watch).toBe('function')
    if (!sshdAvailable) return
    const { provider, teardown } = await sftp.setup()
    expect(provider.watch).toBeUndefined()
    await teardown()
  })

  it('SFTP gives numeric owners; the local provider resolves names', async () => {
    if (!sshdAvailable) return
    const dir = await mkdtemp(join(root, 'own-'))
    await writeFile(join(dir, 'f'), '')
    const local = await new LocalProvider().details(join(dir, 'f'))
    expect(local.owner).toBeTruthy()
    const { provider, teardown } = await sftp.setup()
    const remote = await provider.details(join(dir, 'f'))
    expect(remote.uid).toBe(local.uid)
    expect(remote.owner).toBeUndefined()
    await teardown()
  })
})
