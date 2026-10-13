import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

describe('trash (local only)', () => {
  it('refuses to trash the root', async () => {
    await expect(provider.remove('/', { recursive: true, toTrash: true })).rejects.toBeInstanceOf(
      FsError
    )
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

describe('details (local only)', () => {
  it('resolves owner and group names from the local passwd and group files', async () => {
    const dir = await fresh()
    await writeFile(join(dir, 'f'), 'abc')
    const d = await provider.details(join(dir, 'f'))
    expect(d.owner).toBeTruthy()
    expect(d.group).toBeTruthy()
  })

  it('keeps symlink info', async () => {
    const dir = await fresh()
    await symlink('target', join(dir, 'l'))
    expect(await provider.details(join(dir, 'l'))).toMatchObject({
      type: 'symlink',
      linkTarget: 'target'
    })
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
