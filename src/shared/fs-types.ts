/**
 * Plain types and the FsError class. Deliberately free of runtime dependencies so the
 * renderer can import it without bundling zod; the validation schemas live in fs-schemas.ts.
 */

/** `local` or `ssh:<profileId>`. Only `local` exists until M3. */
export type MachineId = 'local' | `ssh:${string}`

export type EntryType = 'file' | 'dir' | 'symlink' | 'other'

export interface Entry {
  name: string
  /** Absolute POSIX path. */
  path: string
  type: EntryType
  size: number
  /** Modification time, ms since epoch. */
  mtime: number
  /** Permission bits only (`st_mode & 0o7777`). The file type lives in `type`. */
  mode: number
  linkTarget?: string
  /** What a symlink resolves to. `broken` covers dangling and unreadable targets. */
  linkTargetType?: 'file' | 'dir' | 'other' | 'broken'
}

export const FS_ERROR_CODES = [
  'ENOENT',
  'EACCES',
  'EEXIST',
  'ENOTEMPTY',
  'ENOTDIR',
  'EISDIR',
  'EDISCONNECTED',
  'EUNKNOWN'
] as const
export type FsErrorCode = (typeof FS_ERROR_CODES)[number]

export interface FsErrorData {
  code: FsErrorCode
  path?: string
  message: string
}

/** One error type for every machine; providers map their native errors onto it. */
export class FsError extends Error implements FsErrorData {
  readonly code: FsErrorCode
  readonly path: string | undefined

  constructor(data: FsErrorData) {
    super(data.message)
    this.name = 'FsError'
    this.code = data.code
    this.path = data.path
  }

  toData(): FsErrorData {
    return this.path === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, path: this.path, message: this.message }
  }
}

/** True for an entry that behaves like a folder (a real directory or a symlink to one). */
export function isDirLike(entry: Pick<Entry, 'type' | 'linkTargetType'>): boolean {
  return entry.type === 'dir' || (entry.type === 'symlink' && entry.linkTargetType === 'dir')
}
