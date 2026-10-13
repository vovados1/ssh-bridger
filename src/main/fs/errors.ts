import { FsError, type FsErrorCode } from '@shared/fs-types'

const CODE_MAP: Record<string, FsErrorCode> = {
  ENOENT: 'ENOENT',
  EACCES: 'EACCES',
  EPERM: 'EACCES',
  EROFS: 'EACCES',
  EEXIST: 'EEXIST',
  ENOTEMPTY: 'ENOTEMPTY',
  ENOTDIR: 'ENOTDIR',
  EISDIR: 'EISDIR'
}

/** Map any thrown value onto the app-wide FsError. FsErrors pass through unchanged. */
export function toFsError(err: unknown, path?: string): FsError {
  if (err instanceof FsError) return err
  const errno = (err as NodeJS.ErrnoException | undefined)?.code
  const code = (errno && CODE_MAP[errno]) || 'EUNKNOWN'
  const detail = err instanceof Error ? err.message : String(err)
  const where = (err as NodeJS.ErrnoException | undefined)?.path ?? path
  return new FsError({
    code,
    ...(where === undefined ? {} : { path: where }),
    message: describe(code, where, detail)
  })
}

function describe(code: FsErrorCode, path: string | undefined, detail: string): string {
  const target = path ? `"${path}"` : 'this location'
  switch (code) {
    case 'ENOENT':
      return `${target} does not exist`
    case 'EACCES':
      return `Permission denied for ${target}`
    case 'EEXIST':
      return `${target} already exists`
    case 'ENOTEMPTY':
      return `${target} is not empty`
    case 'ENOTDIR':
      return `${target} is not a folder`
    case 'EISDIR':
      return `${target} is a folder`
    default:
      return detail
  }
}
