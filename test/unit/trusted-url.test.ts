import { describe, expect, it } from 'vitest'

// register.ts imports electron; mock it so the pure helper can be tested under plain Node.
import { vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const { isTrustedUrl } = await import('../../src/main/ipc/register')

describe('isTrustedUrl', () => {
  it('trusts packaged file:// pages', () => {
    expect(isTrustedUrl('file:///opt/app/out/renderer/index.html', undefined)).toBe(true)
  })

  it('trusts only the configured dev server', () => {
    expect(isTrustedUrl('http://localhost:5173/', 'http://localhost:5173')).toBe(true)
    expect(isTrustedUrl('http://localhost:5173/', undefined)).toBe(false)
    expect(isTrustedUrl('https://evil.example/', 'http://localhost:5173')).toBe(false)
  })

  it('rejects empty and non-app URLs', () => {
    expect(isTrustedUrl('', undefined)).toBe(false)
    expect(isTrustedUrl('about:blank', undefined)).toBe(false)
  })
})
