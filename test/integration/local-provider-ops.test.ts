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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FsError } from '@shared/fs-types'
import { LocalProvider } from '../../src/main/fs/local-provider'

let root: string
const trashed: string[] = []
const trash = vi.fn(async (path: string) => {
  trashed.push(path)
  await rm(path, { recursive: true }) // stand in for the desktop Trash
})
const provider = new LocalProvider({ trash })

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bridger-ops-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

let n = 0
async function fresh(): Promise<string> {
  const dir = join(root, `case-${n++}`)
  await mkdir(dir)
  return dir
}

describe('mkdir / createFile', () => {
  it('creates a folder and an empty file', async () => {
    const dir = await fresh()
    await provider.mkdir(join(dir, 'sub'))
    await provider.createFile(join(dir, 'a.txt'))
    expect((await lstat(join(dir, 'sub'))).isDirectory()).toBe(true)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('')
  })

  it('refuses to clobber: EEXIST, and existing content survives', async () => {
    const dir = await fresh()
    await writeFile(join(dir, 'keep'), 'precious')
    await expect(provider.createFile(join(dir, 'keep'))).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(provider.mkdir(join(dir, 'keep'))).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(join(dir, 'keep'), 'utf8')).toBe('precious')
  })

  it('does not create missing parents', async () => {
    const dir = await fresh()
    await expect(provider.mkdir(join(dir, 'a', 'b'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(provider.createFile(join(dir, 'a', 'b'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('rename', () => {
  it('renames files and folders', async () => {
    const dir = await fresh()
    await writeFile(join(dir, 'old.txt'), 'x')
    await mkdir(join(dir, 'olddir'))
    await provider.rename(join(dir, 'old.txt'), join(dir, 'new.txt'))
    await provider.rename(join(dir, 'olddir'), join(dir, 'newdir'))
    expect((await readdir(dir)).sort()).toEqual(['new.txt', 'newdir'])
  })

  it('never overwrites an existing target', async () => {
    const dir = await fresh()
    await writeFile(join(dir, 'a'), 'A')
    await writeFile(join(dir, 'b'), 'B')
    await expect(provider.rename(join(dir, 'a'), join(dir, 'b'))).rejects.toMatchObject({
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
    await expect(provider.rename(join(dir, 'a'), join(dir, 'ghost'))).rejects.toMatchObject({
      code: 'EEXIST'
    })
  })

  it('reports a missing source', async () => {
    const dir = await fresh()
    await expect(provider.rename(join(dir, 'nope'), join(dir, 'x'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})

describe('remove', () => {
  it('deletes a file and an empty folder', async () => {
    const dir = await fresh()
    await writeFile(join(dir, 'f'), '')
    await mkdir(join(dir, 'd'))
    await provider.remove(join(dir, 'f'), { recursive: false, toTrash: false })
    await provider.remove(join(dir, 'd'), { recursive: false, toTrash: false })
    expect(await readdir(dir)).toEqual([])
  })

  it('needs recursive for a non-empty folder, then removes the tree', async () => {
    const dir = await fresh()
    await mkdir(join(dir, 'tree/deep'), { recursive: true })
    await writeFile(join(dir, 'tree/deep/f'), '')
    await expect(
      provider.remove(join(dir, 'tree'), { recursive: false, toTrash: false })
    ).rejects.toMatchObject({
      code: 'ENOTEMPTY'
    })
    await provider.remove(join(dir, 'tree'), { recursive: true, toTrash: false })
    expect(await readdir(dir)).toEqual([])
  })

  it('removes a symlink without touching its target', async () => {
    const dir = await fresh()
    await mkdir(join(dir, 'target'))
    await writeFile(join(dir, 'target/keep'), '')
    await symlink(join(dir, 'target'), join(dir, 'link'))
    await provider.remove(join(dir, 'link'), { recursive: true, toTrash: false })
    expect((await readdir(dir)).sort()).toEqual(['target'])
    expect(await readdir(join(dir, 'target'))).toEqual(['keep'])
  })

  it('reports a missing path', async () => {
    const dir = await fresh()
    await expect(
      provider.remove(join(dir, 'nope'), { recursive: true, toTrash: false })
    ).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('refuses to delete the root', async () => {
    await expect(provider.remove('/', { recursive: true, toTrash: false })).rejects.toBeInstanceOf(
      FsError
    )
    await expect(provider.remove('/', { recursive: true, toTrash: true })).rejects.toBeInstanceOf(
      FsError
    )
  })

  it('sends items to the trash helper instead of deleting directly', async () => {
    const dir = await fresh()
    await writeFile(join(dir, 'f'), '')
    await provider.remove(join(dir, 'f'), { recursive: false, toTrash: true })
    expect(trashed).toContain(join(dir, 'f'))
  })

  it('explains trash failures and does not fall back to permanent deletion', async () => {
    const dir = await fresh()
    await writeFile(join(dir, 'f'), 'data')
    const failing = new LocalProvider({
      trash: async () => {
        throw new Error('no trash can on this filesystem')
      }
    })
    await expect(
      failing.remove(join(dir, 'f'), { recursive: false, toTrash: true })
    ).rejects.toThrow(/Could not move "f" to the Trash.*no trash can.*Shift\+Delete/)
    expect(await readFile(join(dir, 'f'), 'utf8')).toBe('data')
  })

  it('reports a missing path as ENOENT even when trashing', async () => {
    const dir = await fresh()
    await expect(
      provider.remove(join(dir, 'nope'), { recursive: false, toTrash: true })
    ).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('says so when no trash is configured', async () => {
    const dir = await fresh()
    await writeFile(join(dir, 'f'), '')
    await expect(
      new LocalProvider().remove(join(dir, 'f'), { recursive: false, toTrash: true })
    ).rejects.toThrow(/Trash is not available/)
  })
})

describe('chmod', () => {
  it('sets permission bits including special ones', async () => {
    const dir = await fresh()
    await writeFile(join(dir, 'f'), '')
    await provider.chmod(join(dir, 'f'), 0o640)
    expect((await provider.stat(join(dir, 'f'))).mode).toBe(0o640)
    await provider.chmod(join(dir, 'f'), 0o2755)
    expect((await provider.stat(join(dir, 'f'))).mode).toBe(0o2755)
  })

  it('reports a missing path', async () => {
    await expect(provider.chmod(join(root, 'nope'), 0o644)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it.skipIf(process.getuid?.() === 0)(
    'shows a folder as non-listable after chmod 000',
    async () => {
      const dir = await fresh()
      await mkdir(join(dir, 'd'))
      await provider.chmod(join(dir, 'd'), 0o000)
      try {
        await expect(provider.list(join(dir, 'd'))).rejects.toMatchObject({ code: 'EACCES' })
      } finally {
        await chmod(join(dir, 'd'), 0o700)
      }
    }
  )
})

describe('details', () => {
  it('adds owner, group and times to stat', async () => {
    const dir = await fresh()
    await writeFile(join(dir, 'f'), 'abc')
    const d = await provider.details(join(dir, 'f'))
    expect(d).toMatchObject({
      name: 'f',
      type: 'file',
      size: 3,
      uid: process.getuid?.(),
      gid: process.getgid?.()
    })
    expect(d.owner).toBeTruthy()
    expect(d.atime).toBeGreaterThan(0)
    expect(d.ctime).toBeGreaterThan(0)
  })

  it('keeps symlink info and reports missing paths', async () => {
    const dir = await fresh()
    await symlink('target', join(dir, 'l'))
    expect(await provider.details(join(dir, 'l'))).toMatchObject({
      type: 'symlink',
      linkTarget: 'target'
    })
    await expect(provider.details(join(dir, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('watch', () => {
  const settle = () => new Promise((r) => setTimeout(r, 200))

  it('fires when entries are created, renamed and deleted in the folder', async () => {
    const dir = await fresh()
    const onChange = vi.fn()
    const stop = provider.watch(dir, onChange)
    try {
      await writeFile(join(dir, 'a'), '')
      await settle()
      expect(onChange).toHaveBeenCalled()
      onChange.mockClear()
      await provider.rename(join(dir, 'a'), join(dir, 'b'))
      await settle()
      expect(onChange).toHaveBeenCalled()
      onChange.mockClear()
      await rm(join(dir, 'b'))
      await settle()
      expect(onChange).toHaveBeenCalled()
    } finally {
      stop()
    }
  })

  it('is not recursive', async () => {
    const dir = await fresh()
    await mkdir(join(dir, 'sub'))
    const onChange = vi.fn()
    const stop = provider.watch(dir, onChange)
    try {
      await writeFile(join(dir, 'sub', 'deep'), '')
      await settle()
      expect(onChange).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })

  it('stops after the stopper is called', async () => {
    const dir = await fresh()
    const onChange = vi.fn()
    provider.watch(dir, onChange)()
    await writeFile(join(dir, 'a'), '')
    await settle()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('throws for a folder that does not exist', () => {
    expect(() => provider.watch(join(root, 'missing-dir'), () => {})).toThrow()
  })
})
