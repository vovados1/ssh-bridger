import { describe, expect, it } from 'vitest'
import { splitExtension, uniqueCopyName } from '../../src/main/transfer/copy-name'
import { Semaphore } from '../../src/main/transfer/semaphore'
import { SpeedMeter } from '../../src/main/transfer/speed-meter'

describe('uniqueCopyName', () => {
  const taken = (set: string[]) => async (c: string) => set.includes(c)

  it('adds (copy) before the extension and numbers further copies', async () => {
    expect(await uniqueCopyName('report.pdf', false, taken([]))).toBe('report (copy).pdf')
    expect(await uniqueCopyName('report.pdf', false, taken(['report (copy).pdf']))).toBe(
      'report (copy 2).pdf'
    )
    expect(
      await uniqueCopyName('report.pdf', false, taken(['report (copy).pdf', 'report (copy 2).pdf']))
    ).toBe('report (copy 3).pdf')
  })

  it('treats folders, dotfiles and extensionless names as all stem', async () => {
    expect(await uniqueCopyName('my.folder', true, taken([]))).toBe('my.folder (copy)')
    expect(await uniqueCopyName('.bashrc', false, taken([]))).toBe('.bashrc (copy)')
    expect(await uniqueCopyName('Makefile', false, taken([]))).toBe('Makefile (copy)')
  })

  it('keeps .tar.gz together', async () => {
    expect(splitExtension('backup.tar.gz')).toEqual({ stem: 'backup', ext: '.tar.gz' })
    expect(splitExtension('a.b.c')).toEqual({ stem: 'a.b', ext: '.c' })
    expect(await uniqueCopyName('backup.tar.gz', false, taken([]))).toBe('backup (copy).tar.gz')
  })
})

describe('SpeedMeter', () => {
  it('is zero without data, then reports bytes per second over the window', () => {
    const m = new SpeedMeter(3000)
    expect(m.speed(0)).toBe(0)
    m.record(0, 0)
    m.record(1000, 1000)
    m.record(3000, 2000)
    expect(m.speed(2000)).toBe(1500)
  })

  it('forgets samples older than the window', () => {
    const m = new SpeedMeter(1000)
    m.record(0, 0)
    m.record(1_000_000, 100) // an early burst
    m.record(1_000_000, 2000)
    m.record(1_001_000, 3000)
    expect(m.speed(3000)).toBeLessThan(2000)
  })

  it('decays while nothing arrives and resets', () => {
    const m = new SpeedMeter(5000)
    m.record(0, 0)
    m.record(1000, 1000)
    const busy = m.speed(1000)
    expect(m.speed(4000)).toBeLessThan(busy)
    m.reset()
    expect(m.speed(5000)).toBe(0)
  })
})

describe('Semaphore', () => {
  it('limits concurrency and hands permits to waiters in order', async () => {
    const s = new Semaphore(2)
    await s.acquire()
    await s.acquire()
    const order: number[] = []
    const a = s.acquire().then(() => order.push(1))
    const b = s.acquire().then(() => order.push(2))
    await Promise.resolve()
    expect(order).toEqual([])
    s.release()
    await a
    s.release()
    await b
    expect(order).toEqual([1, 2])
  })

  it('removes an aborted waiter without losing a permit', async () => {
    const s = new Semaphore(1)
    await s.acquire()
    const ctl = new AbortController()
    const waiting = s.acquire(ctl.signal)
    ctl.abort(new Error('stop'))
    await expect(waiting).rejects.toThrow('stop')
    s.release()
    await s.acquire() // the permit is still there
  })

  it('rejects immediately for an already-aborted signal', async () => {
    const s = new Semaphore(1)
    const ctl = new AbortController()
    ctl.abort(new Error('nope'))
    await expect(s.acquire(ctl.signal)).rejects.toThrow('nope')
  })

  it('wakes waiters when the limit grows', async () => {
    const s = new Semaphore(1)
    await s.acquire()
    let woke = 0
    void s.acquire().then(() => woke++)
    void s.acquire().then(() => woke++)
    await Promise.resolve()
    s.resize(2)
    await Promise.resolve()
    await Promise.resolve()
    expect(woke).toBe(2)
  })

  it('lets holders finish when the limit shrinks, then enforces it', async () => {
    const s = new Semaphore(3)
    await s.acquire()
    await s.acquire()
    await s.acquire()
    s.resize(-2) // limit is now 1, three are held
    let woke = 0
    void s.acquire().then(() => woke++)
    s.release() // 2 held
    s.release() // 1 held: still at the limit
    await Promise.resolve()
    expect(woke).toBe(0)
    s.release() // 0 held: the waiter gets in
    await Promise.resolve()
    await Promise.resolve()
    expect(woke).toBe(1)
  })
})
