import { createStore, type StoreApi } from 'zustand/vanilla'
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'
import type { SettingsClient } from '../../lib/settings-client'
import type { Notify } from '../../lib/toasts'

export interface SettingsState {
  settings: Settings
  /** False until the saved settings arrive; the defaults are shown meanwhile. */
  loaded: boolean
  init(): Promise<void>
  /** Apply a change straight away and save it; a failed save puts the old values back. */
  update(change: (current: Settings) => Settings): Promise<void>
  dispose(): void
}

export type SettingsStore = StoreApi<SettingsState>

export function createSettingsStore(client: SettingsClient, notify: Notify): SettingsStore {
  let unsubscribe: (() => void) | undefined
  /** Saves are applied in order, so quick successive edits can't overwrite each other. */
  let saving: Promise<unknown> = Promise.resolve()

  return createStore<SettingsState>()((set, get) => ({
    settings: DEFAULT_SETTINGS,
    loaded: false,

    async init() {
      unsubscribe?.()
      unsubscribe = client.onChanged((settings) => set({ settings }))
      set({ settings: await client.load(), loaded: true })
    },

    async update(change) {
      const before = get().settings
      const next = change(before)
      set({ settings: next })
      const run = saving.then(async () => {
        try {
          set({ settings: await client.save(next) })
        } catch (err) {
          set({ settings: before })
          notify({
            kind: 'error',
            message: `Could not save settings: ${err instanceof Error ? err.message : String(err)}`
          })
        }
      })
      saving = run
      await run
    },

    dispose() {
      unsubscribe?.()
      unsubscribe = undefined
    }
  }))
}
