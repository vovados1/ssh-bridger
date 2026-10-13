import { FsError, type Entry, type EntryDetails } from '@shared/fs-types'
import { baseName, joinPath, parentOf } from '@shared/posix-path'
import type { FsClient } from '../../src/renderer/src/lib/fs-client'

export const file = (dir: string, name: string, over: Partial<Entry> = {}): Entry => ({
  name,
  path: joinPath(dir, name),
  type: 'file',
  size: 1,
  mtime: 1,
  mode: 0o644,
  ...over
})
export const folder = (dir: string, name: string, over: Partial<Entry> = {}): Entry =>
  file(dir, name, { type: 'dir', mode: 0o755, ...over })

export type Tree = Record<string, Entry[]>

export interface FakeFs extends FsClient {
  tree: Tree
  /** Every folder listed, in order. */
  calls: string[]
  /** Every mutation, e.g. `rename /a /b`. */
  ops: string[]
  watched: { path: string; key: string }[]
  unwatched: string[]
  /** Simulate main reporting a change in the watched folder. */
  emitChanged(key: string): void
  /** Make the next `remove` with toTrash fail, like a filesystem without a trash can. */
  failTrash: boolean
}

const err = (code: 'ENOENT' | 'EEXIST' | 'EACCES' | 'EUNKNOWN', path: string, message?: string) =>
  new FsError({ code, path, message: message ?? `${code} ${path}` })

/** An in-memory FsClient whose mutations really change what the next `list` returns. */
export function fakeFs(tree: Tree, delays: Record<string, Promise<void>> = {}): FakeFs {
  const listeners = new Set<(key: string) => void>()
  const find = (path: string): Entry | undefined =>
    tree[parentOf(path)]?.find((e) => e.path === path)

  const fs: FakeFs = {
    tree,
    calls: [],
    ops: [],
    watched: [],
    unwatched: [],
    failTrash: false,
    emitChanged: (key) => listeners.forEach((l) => l(key)),

    home: async () => '/home/me',
    realpath: async (_m, p) => p,
    stat: async (_m, p) => {
      const e = find(p)
      if (!e) throw err('ENOENT', p)
      return e
    },
    list: async (_m, path) => {
      fs.calls.push(path)
      await delays[path]
      const entries = tree[path]
      if (!entries) throw new FsError({ code: 'ENOENT', path, message: `"${path}" does not exist` })
      return [...entries]
    },
    details: async (_m, p): Promise<EntryDetails> => {
      const e = find(p)
      if (!e) throw err('ENOENT', p)
      return { ...e, uid: 1000, gid: 1000, owner: 'me', group: 'me', atime: 2, ctime: 3 }
    },
    mkdir: async (_m, path) => {
      fs.ops.push(`mkdir ${path}`)
      const siblings = tree[parentOf(path)]
      if (!siblings) throw err('ENOENT', path)
      if (find(path)) throw err('EEXIST', path)
      siblings.push(folder(parentOf(path), baseName(path)))
      tree[path] = []
    },
    createFile: async (_m, path) => {
      fs.ops.push(`createFile ${path}`)
      const siblings = tree[parentOf(path)]
      if (!siblings) throw err('ENOENT', path)
      if (find(path)) throw err('EEXIST', path)
      siblings.push(file(parentOf(path), baseName(path), { size: 0 }))
    },
    rename: async (_m, from, to) => {
      fs.ops.push(`rename ${from} ${to}`)
      const entry = find(from)
      if (!entry) throw err('ENOENT', from)
      if (find(to)) throw err('EEXIST', to, `"${baseName(to)}" already exists`)
      tree[parentOf(from)] = tree[parentOf(from)]!.filter((e) => e !== entry)
      tree[parentOf(to)]!.push({ ...entry, name: baseName(to), path: to })
      for (const key of Object.keys(tree)) {
        if (key === from || key.startsWith(from + '/')) {
          tree[to + key.slice(from.length)] = tree[key]!
          delete tree[key]
        }
      }
    },
    remove: async (_m, path, { toTrash }) => {
      fs.ops.push(`remove ${path}${toTrash ? ' (trash)' : ''}`)
      if (toTrash && fs.failTrash)
        throw err('EUNKNOWN', path, `Could not move "${baseName(path)}" to the Trash`)
      const entry = find(path)
      if (!entry) throw err('ENOENT', path)
      tree[parentOf(path)] = tree[parentOf(path)]!.filter((e) => e !== entry)
      for (const key of Object.keys(tree))
        if (key === path || key.startsWith(path + '/')) delete tree[key]
    },
    chmod: async (_m, path, mode) => {
      fs.ops.push(`chmod ${path} ${mode.toString(8)}`)
      const entry = find(path)
      if (!entry) throw err('ENOENT', path)
      entry.mode = mode
    },
    watch: async (_m, path, key) => {
      fs.watched.push({ path, key })
      return true
    },
    unwatch: async (key) => {
      fs.unwatched.push(key)
    },
    onChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return fs
}
