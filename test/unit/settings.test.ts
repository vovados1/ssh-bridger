import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'
import { SettingsStore } from '../../src/main/store/settings-store'
import { createSettingsStore } from '../../src/renderer/src/features/settings/settingsStore'
import type { SettingsClient } from '../../src/renderer/src/lib/settings-client'
import type { Notification } from '../../src/renderer/src/lib/toasts'

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bridger-settings-'))
  file = join(dir, 'settings.json')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const custom: Settings = {
  theme: 'dark',
  transfers: {
    filesPerTransfer: 5,
    totalFiles: 10,
    parallelTransfers: 3,
    preserveAttributes: false
  },
  remotePollSeconds: 30
}

describe('SettingsStore (main)', () => {
  it('starts with the defaults when nothing is saved', async () => {
    const store = new SettingsStore(file)
    await store.load()
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('round-trips across instances, with private permissions', async () => {
    await new SettingsStore(file).save(custom)
    const again = new SettingsStore(file)
    await again.load()
    expect(again.get()).toEqual(custom)
  })

  it('replaces only the bad values with defaults', async () => {
    await writeFile(
      file,
      JSON.stringify({
        theme: 'neon',
        transfers: { filesPerTransfer: 4, totalFiles: 9999, parallelTransfers: 'x' },
        remotePollSeconds: 45,
        somethingFromTheFuture: true
      })
    )
    const store = new SettingsStore(file)
    await store.load()
    expect(store.get()).toEqual({
      theme: DEFAULT_SETTINGS.theme,
      transfers: {
        filesPerTransfer: 4,
        totalFiles: DEFAULT_SETTINGS.transfers.totalFiles,
        parallelTransfers: DEFAULT_SETTINGS.transfers.parallelTransfers,
        preserveAttributes: DEFAULT_SETTINGS.transfers.preserveAttributes
      },
      remotePollSeconds: 45
    })
  })

  it('moves a file that is not JSON aside instead of losing it', async () => {
    await writeFile(file, '{ oops')
    const store = new SettingsStore(file)
    await store.load()
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect((await readdir(dir)).some((f) => f.includes('.corrupt-'))).toBe(true)
  })

  it('applies a save immediately, tells listeners and stores out-of-range values as defaults', async () => {
    const store = new SettingsStore(file)
    const seen: Settings[] = []
    const off = store.onChange((s) => seen.push(s))
    const saved = await store.save({
      ...custom,
      transfers: { ...custom.transfers, totalFiles: 500 }
    })
    expect(saved.transfers.totalFiles).toBe(DEFAULT_SETTINGS.transfers.totalFiles)
    expect(store.get()).toEqual(saved)
    expect(seen).toEqual([saved])
    off()
    await store.save(custom)
    expect(seen).toHaveLength(1)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(custom)
  })

  it('keeps the last of many rapid saves', async () => {
    const store = new SettingsStore(file)
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.save({ ...custom, remotePollSeconds: i }))
    )
    const again = new SettingsStore(file)
    await again.load()
    expect(again.get().remotePollSeconds).toBe(19)
  })
})

function fakeClient(initial: Settings = DEFAULT_SETTINGS) {
  const listeners = new Set<(s: Settings) => void>()
  const client: SettingsClient & { saved: Settings[]; failNext: boolean; stored: Settings } = {
    stored: initial,
    saved: [],
    failNext: false,
    load: async () => client.stored,
    save: async (s) => {
      if (client.failNext) {
        client.failNext = false
        throw new Error('disk full')
      }
      client.saved.push(s)
      client.stored = s
      return s
    },
    onChanged: (l) => (listeners.add(l), () => listeners.delete(l))
  }
  return { client, emit: (s: Settings) => listeners.forEach((l) => l(s)) }
}

describe('settings store (renderer)', () => {
  it('loads the saved settings', async () => {
    const { client } = fakeClient(custom)
    const store = createSettingsStore(client, () => {})
    expect(store.getState().loaded).toBe(false)
    await store.getState().init()
    expect(store.getState().settings).toEqual(custom)
    expect(store.getState().loaded).toBe(true)
  })

  it('shows a change at once and saves it', async () => {
    const { client } = fakeClient()
    const store = createSettingsStore(client, () => {})
    await store.getState().init()
    const pending = store.getState().update((s) => ({ ...s, theme: 'light' }))
    expect(store.getState().settings.theme).toBe('light') // before the save finished
    await pending
    expect(client.saved.at(-1)?.theme).toBe('light')
  })

  it('puts the old values back and says so when saving fails', async () => {
    const { client } = fakeClient()
    const messages: Notification[] = []
    const store = createSettingsStore(client, (n) => messages.push(n))
    await store.getState().init()
    client.failNext = true
    await store.getState().update((s) => ({ ...s, theme: 'dark' }))
    expect(store.getState().settings.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(messages[0]?.message).toContain('disk full')
  })

  it('saves quick successive edits in order', async () => {
    const { client } = fakeClient()
    const store = createSettingsStore(client, () => {})
    await store.getState().init()
    const a = store.getState().update((s) => ({ ...s, remotePollSeconds: 20 }))
    const b = store.getState().update((s) => ({ ...s, theme: 'dark' }))
    await Promise.all([a, b])
    expect(client.stored).toMatchObject({ remotePollSeconds: 20, theme: 'dark' })
  })

  it('follows changes pushed from main', async () => {
    const { client, emit } = fakeClient()
    const store = createSettingsStore(client, () => {})
    await store.getState().init()
    emit(custom)
    expect(store.getState().settings).toEqual(custom)
    store.getState().dispose()
    emit(DEFAULT_SETTINGS)
    expect(store.getState().settings).toEqual(custom)
  })
})
