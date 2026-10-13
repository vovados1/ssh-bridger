import { describe, expect, it } from 'vitest'
import { FsError } from '@shared/fs-types'
import { toFsError } from '../../src/main/fs/errors'

const errno = (code: string, path?: string) =>
  Object.assign(new Error(`${code}: boom`), { code, ...(path ? { path } : {}) })

describe('toFsError', () => {
  it('maps node errno codes', () => {
    expect(toFsError(errno('ENOENT', '/x')).code).toBe('ENOENT')
    expect(toFsError(errno('EPERM')).code).toBe('EACCES')
    expect(toFsError(errno('ENOTDIR')).code).toBe('ENOTDIR')
    expect(toFsError(errno('EMFILE')).code).toBe('EUNKNOWN')
  })

  it('writes friendly messages that name the path', () => {
    expect(toFsError(errno('ENOENT', '/x')).message).toBe('"/x" does not exist')
    expect(toFsError(errno('EACCES'), '/y').message).toBe('Permission denied for "/y"')
  })

  it('passes FsErrors through and wraps non-errors', () => {
    const own = new FsError({ code: 'EDISCONNECTED', message: 'gone' })
    expect(toFsError(own)).toBe(own)
    expect(toFsError('weird')).toMatchObject({ code: 'EUNKNOWN', message: 'weird' })
  })

  it('round-trips through plain data', () => {
    const data = toFsError(errno('ENOENT', '/x')).toData()
    expect(new FsError(data)).toMatchObject({ code: 'ENOENT', path: '/x' })
  })
})
