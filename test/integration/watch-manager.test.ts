import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MachineRegistry, createRegistry } from '../../src/main/fs/registry'
import { WatchManager } from '../../src/main/ipc/watches'

let root: string
let manager: WatchManager
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bridger-watch-'))
})
afterEach(() => manager?.dropOwner(1))
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('WatchManager', () => {
  it('coalesces a burst of changes into a single notification', async () => {
    manager = new WatchManager(createRegistry())
    const onChange = vi.fn()
    expect(manager.watch(1, 'col-a', 'local', root, onChange)).toBe(true)
    for (let i = 0; i < 20; i++) await writeFile(join(root, `burst-${i}`), '')
    await wait(600)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('replaces a key’s previous watch', async () => {
    manager = new WatchManager(createRegistry())
    const dirA = await mkdtemp(join(root, 'a-'))
    const dirB = await mkdtemp(join(root, 'b-'))
    const onA = vi.fn()
    const onB = vi.fn()
    manager.watch(1, 'col', 'local', dirA, onA)
    manager.watch(1, 'col', 'local', dirB, onB)
    expect(manager.size).toBe(1)
    await writeFile(join(dirA, 'x'), '')
    await wait(400)
    expect(onA).not.toHaveBeenCalled()
    await writeFile(join(dirB, 'x'), '')
    await wait(400)
    expect(onB).toHaveBeenCalledTimes(1)
  })

  it('unwatch and dropOwner stop notifications and release the watches', async () => {
    manager = new WatchManager(createRegistry())
    const dir = await mkdtemp(join(root, 'c-'))
    const onChange = vi.fn()
    manager.watch(1, 'one', 'local', dir, onChange)
    manager.watch(1, 'two', 'local', dir, onChange)
    manager.watch(2, 'one', 'local', dir, vi.fn())
    manager.unwatch(1, 'one')
    expect(manager.size).toBe(2)
    manager.dropOwner(1)
    expect(manager.size).toBe(1)
    await writeFile(join(dir, 'x'), '')
    await wait(400)
    expect(onChange).not.toHaveBeenCalled()
    manager.dropOwner(2)
    expect(manager.size).toBe(0)
  })

  it('returns false for unwatchable folders and providers without watch support', async () => {
    manager = new WatchManager(createRegistry())
    expect(manager.watch(1, 'k', 'local', join(root, 'does-not-exist'), vi.fn())).toBe(false)

    const registry = new MachineRegistry()
    registry.register({ id: 'ssh:x' } as never)
    expect(new WatchManager(registry).watch(1, 'k', 'ssh:x', '/', vi.fn())).toBe(false)
  })
})
