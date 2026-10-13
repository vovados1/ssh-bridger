import { describe, expect, it } from 'vitest'
import { ipcContract } from '@shared/ipc'

describe('ipcContract', () => {
  it('fs:home takes no payload and returns a string', () => {
    const { request, response } = ipcContract['fs:home']
    expect(request.safeParse(undefined).success).toBe(true)
    expect(request.safeParse({ path: '/etc' }).success).toBe(false)
    expect(response.safeParse('/home/me').success).toBe(true)
    expect(response.safeParse(42).success).toBe(false)
  })
})
