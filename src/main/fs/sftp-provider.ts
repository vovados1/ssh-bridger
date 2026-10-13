import type { SFTPWrapper, Stats } from 'ssh2'
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
import type { FileSystemProvider, RemoveOptions } from './provider'

/** Where a provider gets its SFTP channel from. The connection owns it and may replace it after a reconnect. */
export interface SftpSource {
  /** Rejects with EDISCONNECTED while the connection is down. */
  sftp(): Promise<SFTPWrapper>
  /** Folder to start in; the remote home when unset. */
  readonly defaultPath: string | undefined
}

/** SFTP status codes (draft-ietf-secsh-filexfer-02). */
const STATUS_NO_SUCH_FILE = 2
const STATUS_PERMISSION_DENIED = 3
const STATUS_FAILURE = 4

const S_IFMT = 0o170000
const TYPE_BY_FORMAT: Record<number, EntryType> = {
  0o040000: 'dir',
  0o100000: 'file',
  0o120000: 'symlink'
}

const SYMLINK_CONCURRENCY = 16
const DELETE_CONCURRENCY = 8

type Callback<T> = (err: Error | null | undefined, result: T) => void
type ErrorOnly = (err: Error | null | undefined) => void

/** Turn an ssh2 callback API into a promise. */
function call<T>(fn: (cb: Callback<T>) => void): Promise<T> {
  return new Promise((resolve, reject) =>
    fn((err, result) => (err ? reject(err) : resolve(result)))
  )
}
function callVoid(fn: (cb: ErrorOnly) => void): Promise<void> {
  return new Promise((resolve, reject) => fn((err) => (err ? reject(err) : resolve())))
}

const typeOf = (mode: number): EntryType => TYPE_BY_FORMAT[mode & S_IFMT] ?? 'other'

/** Why the channel itself is unusable, as opposed to the server refusing one request. */
const DEAD_CHANNEL = /closed|lost|not connected|no response|ECONNRESET|EPIPE|socket|channel/i

export class SftpProvider implements FileSystemProvider {
  private homeDir: string | undefined

  constructor(
    readonly id: MachineId,
    private readonly source: SftpSource
  ) {}

  async home(): Promise<string> {
    if (this.homeDir) return this.homeDir
    const sftp = await this.source.sftp()
    try {
      // Servers resolve "." to the login directory.
      const dir = this.source.defaultPath ?? (await call<string>((cb) => sftp.realpath('.', cb)))
      this.homeDir = dir
      return dir
    } catch (err) {
      throw await this.translate(sftp, err, this.source.defaultPath ?? '.')
    }
  }

  async realpath(path: string): Promise<string> {
    const sftp = await this.source.sftp()
    try {
      const resolved = await call<string>((cb) => sftp.realpath(path, cb))
      // OpenSSH canonicalizes paths that do not exist; every other provider rejects them.
      await this.lstat(sftp, resolved)
      return resolved
    } catch (err) {
      throw await this.translate(sftp, err, path)
    }
  }

  async stat(path: string): Promise<Entry> {
    const sftp = await this.source.sftp()
    try {
      return await this.describe(sftp, path, baseName(path), await this.lstat(sftp, path))
    } catch (err) {
      throw await this.translate(sftp, err, path)
    }
  }

  async details(path: string): Promise<EntryDetails> {
    const sftp = await this.source.sftp()
    try {
      const st = await this.lstat(sftp, path)
      const entry = await this.describe(sftp, path, baseName(path), st)
      // SFTP carries numeric ids only and no change time; modified time stands in for it.
      return { ...entry, uid: st.uid, gid: st.gid, atime: st.atime * 1000, ctime: st.mtime * 1000 }
    } catch (err) {
      throw await this.translate(sftp, err, path)
    }
  }

  async list(dir: string): Promise<Entry[]> {
    const sftp = await this.source.sftp()
    let items: { filename: string; attrs: Stats }[]
    try {
      items = await call((cb) => sftp.readdir(dir, cb))
    } catch (err) {
      throw await this.translate(sftp, err, dir, 'list')
    }
    const children = items.filter((i) => i.filename !== '.' && i.filename !== '..')
    try {
      // readdir already carries each entry's lstat data; only symlinks need a second look.
      return await mapLimit(children, SYMLINK_CONCURRENCY, (i) =>
        this.describe(sftp, joinPath(dir, i.filename), i.filename, i.attrs)
      )
    } catch (err) {
      throw await this.translate(sftp, err, dir)
    }
  }

  async mkdir(path: string): Promise<void> {
    const sftp = await this.source.sftp()
    try {
      await callVoid((cb) => sftp.mkdir(path, cb))
    } catch (err) {
      throw await this.translate(sftp, err, path, 'create')
    }
  }

  async createFile(path: string): Promise<void> {
    const sftp = await this.source.sftp()
    try {
      // 'wx' fails instead of truncating an existing file.
      const handle = await call<Buffer>((cb) => sftp.open(path, 'wx', { mode: 0o666 }, cb))
      await callVoid((cb) => sftp.close(handle, cb))
    } catch (err) {
      throw await this.translate(sftp, err, path, 'create')
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const sftp = await this.source.sftp()
    try {
      // SFTP servers differ on whether rename replaces the target; never rely on it.
      const taken = await this.lstat(sftp, to).then(
        () => true,
        (err: unknown) => {
          if (statusOf(err) === STATUS_NO_SUCH_FILE) return false
          throw err
        }
      )
      if (taken) {
        throw new FsError({ code: 'EEXIST', path: to, message: `"${baseName(to)}" already exists` })
      }
      await callVoid((cb) => sftp.rename(from, to, cb))
    } catch (err) {
      throw await this.translate(sftp, err, from)
    }
  }

  async remove(path: string, { recursive, toTrash }: RemoveOptions): Promise<void> {
    if (path === '/') {
      throw new FsError({ code: 'EACCES', path, message: 'Refusing to delete the root folder' })
    }
    if (toTrash) {
      throw new FsError({
        code: 'EUNKNOWN',
        path,
        message: 'Remote machines have no Trash. Delete permanently instead.'
      })
    }
    const sftp = await this.source.sftp()
    try {
      const st = await this.lstat(sftp, path)
      if (typeOf(st.mode) !== 'dir') await callVoid((cb) => sftp.unlink(path, cb))
      else if (recursive) await this.removeTree(sftp, path)
      else await this.rmdir(sftp, path)
    } catch (err) {
      throw await this.translate(sftp, err, path)
    }
  }

  async chmod(path: string, mode: number): Promise<void> {
    const sftp = await this.source.sftp()
    try {
      await callVoid((cb) => sftp.chmod(path, mode, cb))
    } catch (err) {
      throw await this.translate(sftp, err, path)
    }
  }

  // No `watch`: SFTP can't report changes. The UI refreshes after its own operations and on F5.

  // ---- helpers ---------------------------------------------------------------------------

  private lstat(sftp: SFTPWrapper, path: string): Promise<Stats> {
    return call<Stats>((cb) => sftp.lstat(path, cb))
  }

  /** Build an Entry from lstat-style attributes, resolving symlinks to say what they point at. */
  private async describe(sftp: SFTPWrapper, path: string, name: string, st: Stats): Promise<Entry> {
    const entry: Entry = {
      name,
      path,
      type: typeOf(st.mode),
      size: st.size,
      mtime: st.mtime * 1000,
      mode: st.mode & 0o7777
    }
    if (entry.type !== 'symlink') return entry

    try {
      entry.linkTarget = await call<string>((cb) => sftp.readlink(path, cb))
    } catch {
      /* unreadable link text */
    }
    try {
      const target = typeOf((await call<Stats>((cb) => sftp.stat(path, cb))).mode)
      entry.linkTargetType = target === 'symlink' ? 'other' : target
    } catch {
      entry.linkTargetType = 'broken'
    }
    return entry
  }

  private async rmdir(sftp: SFTPWrapper, path: string): Promise<void> {
    try {
      await callVoid((cb) => sftp.rmdir(path, cb))
    } catch (err) {
      // SFTP reports a non-empty folder as a bare "failure"; look to give the real reason.
      if (statusOf(err) === STATUS_FAILURE) {
        const rest = await call<unknown[]>((cb) => sftp.readdir(path, cb)).catch(() => [])
        if (rest.length > 0) throw new FsError(notEmpty(path))
      }
      throw err
    }
  }

  /** Depth-first delete; symlinks are unlinked, never followed. */
  private async removeTree(sftp: SFTPWrapper, dir: string): Promise<void> {
    const items = await call<{ filename: string; attrs: Stats }[]>((cb) => sftp.readdir(dir, cb))
    await mapLimit(
      items.filter((i) => i.filename !== '.' && i.filename !== '..'),
      DELETE_CONCURRENCY,
      async (i) => {
        const child = joinPath(dir, i.filename)
        if (typeOf(i.attrs.mode) === 'dir') await this.removeTree(sftp, child)
        else await callVoid((cb) => sftp.unlink(child, cb))
      }
    )
    await this.rmdir(sftp, dir)
  }

  /**
   * Map an ssh2/SFTP error onto FsError. SFTP v3 has only a handful of status codes, so
   * the vague "failure" is resolved by looking at the path (`context` says what we were doing).
   */
  private async translate(
    sftp: SFTPWrapper,
    err: unknown,
    path: string,
    context?: 'list' | 'create'
  ): Promise<FsError> {
    if (err instanceof FsError) return err
    const status = statusOf(err)
    const errno = (code: string): FsError =>
      toFsError(Object.assign(new Error(code), { code }), path)

    if (status === STATUS_NO_SUCH_FILE) {
      // sftp-server also reports "not a directory" as "no such file"; look to tell them apart.
      if (context === 'list') {
        const st = await this.lstat(sftp, path).catch(() => null)
        if (st && typeOf(st.mode) !== 'dir') return errno('ENOTDIR')
      }
      return errno('ENOENT')
    }
    if (status === STATUS_PERMISSION_DENIED) return errno('EACCES')

    if (status === STATUS_FAILURE && context) {
      const st = await this.lstat(sftp, path).catch(() => null)
      if (st && context === 'create') return errno('EEXIST')
      if (st && context === 'list' && typeOf(st.mode) !== 'dir') return errno('ENOTDIR')
    }

    const message = err instanceof Error ? err.message : String(err)
    if (status === undefined && DEAD_CHANNEL.test(message)) {
      return new FsError({ code: 'EDISCONNECTED', path, message: 'The connection was lost' })
    }
    return toFsError(err, path)
  }
}

const notEmpty = (path: string) => ({
  code: 'ENOTEMPTY' as const,
  path,
  message: `"${path}" is not empty`
})

/** The SFTP status code carried by an ssh2 error, if it came from the server. */
function statusOf(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'number' ? code : undefined
}
