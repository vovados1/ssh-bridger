import { randomBytes } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FsError } from '@shared/fs-types'
import { LocalProvider } from '../../src/main/fs/local-provider'
import type { FileSystemProvider } from '../../src/main/fs/provider'
import { connectSftp as sharedConnectSftp } from '../helpers/sftp-fixture'
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

async function connectSftp(server: TestSshd, port = server.port) {
  return sharedConnectSftp(server, root, port)
}

const sftp: Backend = {
  name: 'SftpProvider (real sshd)',
  trash: false,
  setup: () => connectSftp(sshd!)
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

      describe('streams', () => {
        const write = async (
          path: string,
          data: Buffer,
          opts?: { mode?: number; exclusive?: boolean }
        ) => {
          const out = await p.openWrite(path, opts)
          await new Promise<void>((resolve, reject) => {
            out.once('error', reject)
            out.once('close', resolve)
            out.end(data)
          })
        }
        const read = async (path: string, opts?: { start?: number }) => {
          const chunks: Buffer[] = []
          const input = await p.openRead(path, opts)
          for await (const chunk of input) chunks.push(chunk as Buffer)
          return Buffer.concat(chunks)
        }

        it('round-trips a multi-megabyte file byte for byte', async () => {
          const dir = await fresh()
          const data = randomBytes(5 * 1024 * 1024 + 123) // not a multiple of any chunk size
          await write(join(dir, 'big.bin'), data)
          expect(Buffer.compare(await readFile(join(dir, 'big.bin')), data)).toBe(0)
          expect(Buffer.compare(await read(join(dir, 'big.bin')), data)).toBe(0)
        })

        it('handles empty files and files smaller than a chunk', async () => {
          const dir = await fresh()
          await write(join(dir, 'empty'), Buffer.alloc(0))
          await write(join(dir, 'tiny'), Buffer.from('hi'))
          expect((await read(join(dir, 'empty'))).length).toBe(0)
          expect((await read(join(dir, 'tiny'))).toString()).toBe('hi')
          expect((await lstat(join(dir, 'empty'))).size).toBe(0)
        })

        it('reads from a byte offset', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'f'), '0123456789')
          expect((await read(join(dir, 'f'), { start: 4 })).toString()).toBe('456789')
        })

        it('truncates an existing file when writing, and refuses with exclusive', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'f'), 'a much longer original')
          await expect(p.openWrite(join(dir, 'f'), { exclusive: true })).rejects.toMatchObject({
            code: 'EEXIST'
          })
          expect(await readFile(join(dir, 'f'), 'utf8')).toBe('a much longer original')
          await write(join(dir, 'f'), Buffer.from('short'))
          expect(await readFile(join(dir, 'f'), 'utf8')).toBe('short')
        })

        it('applies the creation mode', async () => {
          const dir = await fresh()
          await write(join(dir, 'private'), Buffer.from('x'), { mode: 0o600 })
          expect((await lstat(join(dir, 'private'))).mode & 0o777).toBe(0o600)
        })

        it('maps open errors onto FsError codes', async () => {
          const dir = await fresh()
          await expect(p.openRead(join(dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
          await expect(p.openWrite(join(dir, 'no', 'such', 'dir'))).rejects.toMatchObject({
            code: 'ENOENT'
          })
        })

        it('can be abandoned halfway without breaking the connection', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'f'), randomBytes(2 * 1024 * 1024))
          const input = await p.openRead(join(dir, 'f'))
          await new Promise<void>((resolve) => {
            input.once('data', () => {
              input.destroy()
              resolve()
            })
          })
          expect((await p.list(dir)).map((e) => e.name)).toEqual(['f']) // still usable afterwards
        })

        it('pipelines into a node stream pipeline end to end', async () => {
          const dir = await fresh()
          const data = randomBytes(700_000)
          await writeFile(join(dir, 'src'), data)
          await pipeline(await p.openRead(join(dir, 'src')), await p.openWrite(join(dir, 'dst')))
          expect(Buffer.compare(await readFile(join(dir, 'dst')), data)).toBe(0)
        })
      })

      describe('setTimes / symlink / rename overwrite', () => {
        it('sets the modification time', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'f'), '')
          const when = Date.UTC(2020, 5, 15, 12, 0, 0)
          await p.setTimes(join(dir, 'f'), when)
          expect(Math.abs((await lstat(join(dir, 'f'))).mtimeMs - when)).toBeLessThan(1500)
          await expect(p.setTimes(join(dir, 'nope'), when)).rejects.toMatchObject({
            code: 'ENOENT'
          })
        })

        it('creates symlinks that point where asked, relative or absolute, even dangling', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'target'), 'x')
          await p.symlink('target', join(dir, 'rel'))
          await p.symlink(join(dir, 'target'), join(dir, 'abs'))
          await p.symlink('missing', join(dir, 'dangling'))
          expect(await readlink(join(dir, 'rel'))).toBe('target')
          expect(await readlink(join(dir, 'abs'))).toBe(join(dir, 'target'))
          expect(await readlink(join(dir, 'dangling'))).toBe('missing')
          await expect(p.symlink('x', join(dir, 'rel'))).rejects.toMatchObject({ code: 'EEXIST' })
        })

        it('replaces an existing file when overwrite is set, keeping the new content', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'new'), 'NEW')
          await writeFile(join(dir, 'old'), 'OLD')
          await expect(p.rename(join(dir, 'new'), join(dir, 'old'))).rejects.toMatchObject({
            code: 'EEXIST'
          })
          await p.rename(join(dir, 'new'), join(dir, 'old'), { overwrite: true })
          expect(await readFile(join(dir, 'old'), 'utf8')).toBe('NEW')
          expect(await readdir(dir)).toEqual(['old'])
        })

        it('overwrite never replaces a folder', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'f'), 'x')
          await mkdir(join(dir, 'd'))
          await expect(
            p.rename(join(dir, 'f'), join(dir, 'd'), { overwrite: true })
          ).rejects.toMatchObject({ code: 'EEXIST' })
        })

        it('overwrite onto a missing target is a plain rename', async () => {
          const dir = await fresh()
          await writeFile(join(dir, 'a'), 'A')
          await p.rename(join(dir, 'a'), join(dir, 'b'), { overwrite: true })
          expect(await readdir(dir)).toEqual(['b'])
        })
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

describe.skipIf(!sshdAvailable)('SFTP throughput on a slow link', () => {
  it('pipelines requests, so latency does not cap the transfer speed', async () => {
    const { startProxy } = await import('../helpers/tcp-proxy')
    const proxy = await startProxy(sshd!.port, 15) // 30 ms round trip
    const { provider, teardown } = await connectSftp(sshd!, proxy.port)
    try {
      const dir = await mkdtemp(join(root, 'slow-'))
      const data = randomBytes(8 * 1024 * 1024)
      await writeFile(join(dir, 'src'), data)

      // One request per round trip would take 8 MB / 32 KB * 30 ms = 7.7 s in each direction.
      let t0 = Date.now()
      await pipeline(
        await provider.openRead(join(dir, 'src')),
        await provider.openWrite(join(dir, 'up'))
      )
      const roundTrip = Date.now() - t0
      expect(Buffer.compare(await readFile(join(dir, 'up')), data)).toBe(0)
      console.log(`INFO  8 MB read+write over a 30 ms link: ${roundTrip} ms`)
      expect(roundTrip).toBeLessThan(6000)
      t0 = Date.now()
    } finally {
      await teardown()
      await proxy.stop()
    }
  }, 30_000)
})

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
