import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Layout } from '@shared/layout'
import { LayoutStore } from '../../src/main/store/layout-store'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bridger-layout-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const layout: Layout = {
  columns: [
    {
      id: 'local',
      machineId: 'local',
      cwd: '/home/me',
      width: 420,
      showHidden: true,
      sortKey: 'mtime',
      sortDir: 'desc'
    },
    { id: 'c2', machineId: 'ssh:abc', profileId: 'abc', cwd: '/var/www' }
  ]
}

describe('LayoutStore', () => {
  it('returns null when nothing was saved', async () => {
    expect(await new LayoutStore(join(dir, 'layout.json')).load()).toBeNull()
  })

  it('round-trips a layout across instances', async () => {
    await new LayoutStore(join(dir, 'layout.json')).save(layout)
    expect(await new LayoutStore(join(dir, 'layout.json')).load()).toEqual(layout)
  })

  it('serializes rapid saves so the last one wins', async () => {
    const store = new LayoutStore(join(dir, 'layout.json'))
    const saves = Array.from({ length: 20 }, (_, i) =>
      store.save({ columns: [{ id: `c${i}`, machineId: 'local' }] })
    )
    await Promise.all(saves)
    expect((await store.load())!.columns[0]!.id).toBe('c19')
  })

  it('moves a corrupt or malformed file aside instead of crashing', async () => {
    await writeFile(join(dir, 'layout.json'), '{ nope')
    expect(await new LayoutStore(join(dir, 'layout.json')).load()).toBeNull()
    expect((await readdir(dir)).some((f) => f.includes('.corrupt-'))).toBe(true)

    await writeFile(join(dir, 'layout.json'), JSON.stringify({ columns: [{ id: 1 }] }))
    expect(await new LayoutStore(join(dir, 'layout.json')).load()).toBeNull()
  })

  it('refuses to save something invalid', async () => {
    const store = new LayoutStore(join(dir, 'layout.json'))
    expect(() => store.save({ columns: [{ id: '', machineId: 'local' }] })).toThrow()
    expect(() => store.save({ columns: [{ id: 'x', machineId: 'bogus' as never }] })).toThrow()
  })
})
