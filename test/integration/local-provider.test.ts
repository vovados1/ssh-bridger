import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FsError } from '@shared/fs-types'
import { LocalProvider } from '../../src/main/fs/local-provider'

const provider = new LocalProvider()
let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bridger-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function fresh(name: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir)
  return dir
}

const byName = <T extends { name: string }>(xs: T[]): Record<string, T> =>
  Object.fromEntries(xs.map((x) => [x.name, x]))

describe('LocalProvider.list', () => {
  it('returns an empty array for an empty folder', async () => {
    expect(await provider.list(await fresh('empty'))).toEqual([])
  })

  it('describes files, folders and dotfiles', async () => {
    const dir = await fresh('basic')
    await writeFile(join(dir, 'a.txt'), 'hello')
    await writeFile(join(dir, '.hidden'), '')
    await mkdir(join(dir, 'sub'))
    await chmod(join(dir, 'a.txt'), 0o640)

    const entries = byName(await provider.list(dir))
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

  it('describes symlinks to files, folders and nothing', async () => {
    const dir = await fresh('links')
    await writeFile(join(dir, 'file'), 'x')
    await mkdir(join(dir, 'folder'))
    await symlink('file', join(dir, 'to-file'))
    await symlink(join(dir, 'folder'), join(dir, 'to-folder'))
    await symlink('missing', join(dir, 'dangling'))
    await symlink('loop2', join(dir, 'loop1'))
    await symlink('loop1', join(dir, 'loop2'))

    const entries = byName(await provider.list(dir))
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
    const dir = await fresh('names')
    const names = ['with space', 'üñíçødé', 'new\nline', '--dash', '#hash']
    for (const n of names) await writeFile(join(dir, n), '')
    expect((await provider.list(dir)).map((e) => e.name).sort()).toEqual([...names].sort())
  })

  it('lists large folders', async () => {
    const dir = await fresh('big')
    await Promise.all(Array.from({ length: 3000 }, (_, i) => writeFile(join(dir, `f${i}`), '')))
    expect(await provider.list(dir)).toHaveLength(3000)
  })

  it('maps errors onto FsError codes', async () => {
    const file = join(root, 'plain-file')
    await writeFile(file, '')
    await expect(provider.list(join(root, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(provider.list(file)).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(provider.list(join(root, 'nope'))).rejects.toBeInstanceOf(FsError)
  })

  it.skipIf(process.getuid?.() === 0)('reports permission errors', async () => {
    const dir = await fresh('locked')
    await chmod(dir, 0o000)
    try {
      await expect(provider.list(dir)).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(dir, 0o700)
    }
  })

  it.skipIf(process.getuid?.() === 0)(
    'keeps names in folders that are readable but not traversable',
    async () => {
      const dir = await fresh('read-only-dir')
      await writeFile(join(dir, 'secret.txt'), '')
      await chmod(dir, 0o444)
      try {
        const entries = await provider.list(dir)
        expect(entries.map((e) => e.name)).toEqual(['secret.txt'])
        expect(entries[0]).toMatchObject({ type: 'file', size: 0, mtime: 0 })
      } finally {
        await chmod(dir, 0o700)
      }
    }
  )
})

describe('LocalProvider.stat / realpath / home', () => {
  it('stats a single entry, including its name', async () => {
    const dir = await fresh('stat')
    await writeFile(join(dir, 'f'), 'abc')
    expect(await provider.stat(join(dir, 'f'))).toMatchObject({ name: 'f', type: 'file', size: 3 })
    await expect(provider.stat(join(dir, 'gone'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stats the root', async () => {
    expect(await provider.stat('/')).toMatchObject({ name: '/', type: 'dir' })
  })

  it('resolves symlinks with realpath', async () => {
    const dir = await fresh('real')
    await mkdir(join(dir, 'target'))
    await symlink(join(dir, 'target'), join(dir, 'alias'))
    expect(await provider.realpath(join(dir, 'alias'))).toBe(
      await provider.realpath(join(dir, 'target'))
    )
    await expect(provider.realpath(join(dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('knows the home directory', async () => {
    expect((await provider.home()).startsWith('/')).toBe(true)
  })
})
