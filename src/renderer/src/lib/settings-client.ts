import type { Settings } from '@shared/settings'

/** What the renderer needs from main for preferences. Faked in tests. */
export interface SettingsClient {
  load(): Promise<Settings>
  /** Resolves to what was actually stored. */
  save(settings: Settings): Promise<Settings>
  onChanged(listener: (settings: Settings) => void): () => void
}
