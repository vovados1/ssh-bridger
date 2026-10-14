import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'
import { SettingsSchema } from '@shared/settings-schemas'
import { quarantine, readJson, writeJsonAtomic } from './json-file'

/** User preferences. Anything unusable falls back to the defaults. */
export class SettingsStore {
  private current: Settings = DEFAULT_SETTINGS
  private writing: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(settings: Settings) => void>()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readJson(this.file)
      this.current = raw === null ? DEFAULT_SETTINGS : SettingsSchema.parse(raw)
    } catch {
      // Not JSON (a hand edit gone wrong): keep the file for the user and start over.
      await quarantine(this.file).catch(() => {})
      this.current = DEFAULT_SETTINGS
    }
  }

  get(): Settings {
    return this.current
  }

  /** Validates, applies at once and saves. Resolves to what was stored. */
  async save(next: Settings): Promise<Settings> {
    const valid = SettingsSchema.parse(next)
    this.current = valid
    for (const listener of this.listeners) listener(valid)
    this.writing = this.writing.then(() => writeJsonAtomic(this.file, valid))
    await this.writing
    return valid
  }

  onChange(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
