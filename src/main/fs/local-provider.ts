import type { Dirent, Stats } from 'node:fs'
import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { type Entry, type EntryType, type MachineId } from '@shared/fs-types'
import { baseName, joinPath } from '@shared/posix-path'
import { mapLimit } from './async'
import { toFsError } from './errors'
import type { FileSystemProvider } from './provider'

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

export class LocalProvider implements FileSystemProvider {
  readonly id: MachineId = 'local'

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
