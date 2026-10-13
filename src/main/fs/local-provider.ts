import type { Dirent, Stats } from 'node:fs'
import { watch as fsWatch } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat
} from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  FsError,
  type Entry,
  type EntryDetails,
  type EntryType,
  type MachineId
} from '@shared/fs-types'
import { baseName, joinPath } from '@shared/posix-path'
import { mapLimit } from './async'
import { toFsError } from './errors'
import { lookupOwner } from './owners'
import type { FileSystemProvider, RemoveOptions } from './provider'

/** Enough parallel lstats to keep the disk busy without exhausting file descriptors. */
const STAT_CONCURRENCY = 64

type Kind = Pick<Stats, 'isDirectory' | 'isFile' | 'isSymbolicLink'>

function typeOf(s: Kind): EntryType {
  if (s.isSymbolicLink()) return 'symlink'
  if (s.isDirectory()) return 'dir'
  if (s.isFile()) return 'file'
  return 'other'
}

function direntType(d: Dirent): EntryType {
  if (d.isSymbolicLink()) return 'symlink'
  if (d.isDirectory()) return 'dir'
  if (d.isFile()) return 'file'
  return 'other'
}

export interface LocalProviderOptions {
  /** Moves a path to the desktop Trash. Injected because it needs Electron's `shell`. */
  trash?: (path: string) => Promise<void>
}

export class LocalProvider implements FileSystemProvider {
  readonly id: MachineId = 'local'

  constructor(private readonly options: LocalProviderOptions = {}) {}

  async home(): Promise<string> {
    return homedir()
  }

  async realpath(path: string): Promise<string> {
    try {
      return await realpath(path)
    } catch (err) {
      throw toFsError(err, path)
    }
  }

  async stat(path: string): Promise<Entry> {
    try {
      return await this.describe(path, baseName(path))
    } catch (err) {
      throw toFsError(err, path)
    }
  }

  async list(dir: string): Promise<Entry[]> {
    let dirents: Dirent[]
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      throw toFsError(err, dir)
    }

    const entries = await mapLimit(dirents, STAT_CONCURRENCY, async (d) => {
      const path = joinPath(dir, d.name)
      try {
        return await this.describe(path, d.name)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null // vanished mid-listing
        // e.g. a directory we may read but not traverse: keep the name, drop the metadata.
        return {
          name: d.name,
          path,
          type: direntType(d),
          size: 0,
          mtime: 0,
          mode: 0
        } satisfies Entry
      }
    })
    return entries.filter((e): e is Entry => e !== null)
  }

  async details(path: string): Promise<EntryDetails> {
    try {
      const [entry, st] = await Promise.all([this.describe(path, baseName(path)), lstat(path)])
      return {
        ...entry,
        uid: st.uid,
        gid: st.gid,
        ...(await lookupOwner(st.uid, st.gid)),
        atime: st.atimeMs,
        ctime: st.ctimeMs
      }
    } catch (err) {
      throw toFsError(err, path)
    }
  }

  async mkdir(path: string): Promise<void> {
    try {
      await mkdir(path)
    } catch (err) {
      throw toFsError(err, path)
    }
  }

  async createFile(path: string): Promise<void> {
    try {
      // 'wx' fails with EEXIST instead of truncating an existing file.
      await (await open(path, 'wx', 0o666)).close()
    } catch (err) {
      throw toFsError(err, path)
    }
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      // rename(2) silently replaces the target, so check first. A file created in the
      // gap between the check and the rename would be replaced; acceptable for a UI action.
      const taken = await lstat(to).then(
        () => true,
        (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return false
          throw err
        }
      )
      if (taken)
        throw new FsError({ code: 'EEXIST', path: to, message: `"${baseName(to)}" already exists` })
      await rename(from, to)
    } catch (err) {
      throw toFsError(err, from)
    }
  }

  async remove(path: string, { recursive, toTrash }: RemoveOptions): Promise<void> {
    if (path === '/') {
      throw new FsError({ code: 'EACCES', path, message: 'Refusing to delete the root folder' })
    }
    if (toTrash) {
      const trash = this.options.trash
      try {
        if (!trash) throw new Error('Trash is not available')
        await lstat(path) // fail with ENOENT rather than whatever the trash helper says
        await trash(path)
      } catch (err) {
        const e = toFsError(err, path)
        if (e.code === 'ENOENT') throw e
        throw new FsError({
          code: 'EUNKNOWN',
          path,
          message: `Could not move "${baseName(path)}" to the Trash (${e.message}). Use Shift+Delete to delete it permanently.`
        })
      }
      return
    }
    try {
      if (!recursive && (await lstat(path)).isDirectory()) await rmdir(path)
      else await rm(path, { recursive, force: false })
    } catch (err) {
      throw toFsError(err, path)
    }
  }

  async chmod(path: string, mode: number): Promise<void> {
    try {
      await chmod(path, mode)
    } catch (err) {
      throw toFsError(err, path)
    }
  }

  watch(dir: string, onChange: () => void): () => void {
    // Non-recursive: one inotify watch for just this folder, however big the tree below it.
    const watcher = fsWatch(dir, { persistent: false }, () => onChange())
    // The folder itself went away or the watch broke; let the UI re-list and find out.
    watcher.on('error', () => {
      watcher.close()
      onChange()
    })
    return () => watcher.close()
  }

  private async describe(path: string, name: string): Promise<Entry> {
    const st = await lstat(path)
    const entry: Entry = {
      name,
      path,
      type: typeOf(st),
      size: st.size,
      mtime: st.mtimeMs,
      mode: st.mode & 0o7777
    }
    if (entry.type !== 'symlink') return entry

    try {
      entry.linkTarget = await readlink(path)
    } catch {
      /* unreadable link text; leave undefined */
    }
    try {
      const target = typeOf(await stat(path))
      entry.linkTargetType = target === 'symlink' ? 'other' : target
    } catch {
      entry.linkTargetType = 'broken'
    }
    return entry
  }
}
