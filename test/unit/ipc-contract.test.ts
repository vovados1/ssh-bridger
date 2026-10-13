import { describe, expect, it } from 'vitest'
import { ipcContract } from '@shared/ipc'

describe('ipcContract', () => {
  const { request, response } = ipcContract['fs:list']

  it('fs:list accepts a machine id and an absolute path', () => {
    expect(request.safeParse({ machineId: 'local', path: '/home/me' }).success).toBe(true)
    expect(request.safeParse({ machineId: 'ssh:prod', path: '/var/www' }).success).toBe(true)
  })

  it('rejects relative paths, NUL bytes, unknown machine ids and extra shapes', () => {
    expect(request.safeParse({ machineId: 'local', path: 'relative' }).success).toBe(false)
    expect(request.safeParse({ machineId: 'local', path: '/a\0b' }).success).toBe(false)
    expect(request.safeParse({ machineId: 'laptop', path: '/' }).success).toBe(false)
    expect(request.safeParse({ path: '/' }).success).toBe(false)
    expect(request.safeParse('/etc').success).toBe(false)
  })

  it('validates entries in responses', () => {
    const entry = { name: 'a', path: '/a', type: 'file', size: 1, mtime: 0, mode: 0o644 }
    expect(response.safeParse([entry]).success).toBe(true)
    expect(response.safeParse([{ ...entry, type: 'socket' }]).success).toBe(false)
  })
})
