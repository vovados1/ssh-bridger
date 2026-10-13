import { z } from 'zod'
import { quarantine, readJson, writeJsonAtomic } from './json-file'

/** Encrypts and decrypts with the OS keyring. Electron's safeStorage in the app, a fake in tests. */
export interface Cipher {
  /** False when there is no real keyring (Electron falls back to a plaintext "basic_text" store). */
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

const FileSchema = z.object({ version: z.literal(1), entries: z.record(z.string(), z.string()) })

/**
 * Remembered passwords and key passphrases. Values are only ever written encrypted by the
 * keyring; when no keyring exists nothing is stored at all.
 */
export class SecretStore {
  private entries: Record<string, string> = {}
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher
  ) {}

  get available(): boolean {
    return this.cipher.isAvailable()
  }

  async load(): Promise<void> {
    try {
      const raw = await readJson(this.file)
      if (raw !== null) this.entries = FileSchema.parse(raw).entries
    } catch {
      await quarantine(this.file).catch(() => {})
      this.entries = {}
    }
  }

  get(key: string): string | undefined {
    const stored = this.entries[key]
    if (stored === undefined || !this.available) return undefined
    try {
      return this.cipher.decrypt(Buffer.from(stored, 'base64'))
    } catch {
      return undefined // keyring changed or locked; behave as if nothing was saved
    }
  }

  /** Returns false (and stores nothing) when no keyring is available. */
  async set(key: string, value: string): Promise<boolean> {
    if (!this.available) return false
    this.entries = { ...this.entries, [key]: this.cipher.encrypt(value).toString('base64') }
    await this.persist()
    return true
  }

  async delete(key: string): Promise<void> {
    if (!(key in this.entries)) return
    const rest = { ...this.entries }
    delete rest[key]
    this.entries = rest
    await this.persist()
  }

  /** Forget everything remembered for a profile (its password). */
  async deleteProfile(profileId: string): Promise<void> {
    await this.delete(passwordKey(profileId))
  }

  private persist(): Promise<void> {
    const snapshot = { version: 1 as const, entries: this.entries }
    this.writing = this.writing.then(() => writeJsonAtomic(this.file, snapshot))
    return this.writing
  }
}

export const passwordKey = (profileId: string): string => `password:${profileId}`
export const passphraseKey = (keyPath: string): string => `passphrase:${keyPath}`
