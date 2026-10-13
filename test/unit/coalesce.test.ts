import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coalesce } from '../../src/main/fs/coalesce'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('coalesce', () => {
  it('runs once, a quiet period after the last trigger', () => {
    const fn = vi.fn()
    const c = coalesce(fn, 100, 1000)
    c.trigger()
    vi.advanceTimersByTime(60)
    c.trigger()
    vi.advanceTimersByTime(60)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('still fires within maxWait when triggers never stop', () => {
    const fn = vi.fn()
    const c = coalesce(fn, 100, 1000)
    for (let t = 0; t < 1000; t += 50) {
      c.trigger()
      vi.advanceTimersByTime(50)
    }
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh window after firing', () => {
    const fn = vi.fn()
    const c = coalesce(fn, 100, 1000)
    c.trigger()
    vi.advanceTimersByTime(100)
    c.trigger()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('cancel drops a pending call', () => {
    const fn = vi.fn()
    const c = coalesce(fn, 100, 1000)
    c.trigger()
    c.cancel()
    vi.advanceTimersByTime(500)
    expect(fn).not.toHaveBeenCalled()
  })
})
