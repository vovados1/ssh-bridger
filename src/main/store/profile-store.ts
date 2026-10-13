import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { FsError } from '@shared/fs-types'
import type { ConnectionProfile, ConnectionProfileInput } from '@shared/connections'
import {
  ConnectionProfileInputSchema,
  ConnectionProfileSchema,
  normalizeProfileInput
} from '@shared/connection-schemas'
import { quarantine, readJson, writeJsonAtomic } from './json-file'

const FileSchema = z.object({ version: z.literal(1), profiles: z.array(ConnectionProfileSchema) })

const invalid = (message: string): FsError => new FsError({ code: 'EUNKNOWN', message })

/** Saved connections, kept in memory and mirrored to a JSON file in the app's data folder. */
export class ProfileStore {
  private profiles: ConnectionProfile[] = []
  /** Serializes writes so concurrent saves can't interleave. */
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readJson(this.file)
      if (raw !== null) this.profiles = FileSchema.parse(raw).profiles
    } catch {
      // Unreadable or malformed: keep the evidence and start fresh rather than lose or crash.
      await quarantine(this.file).catch(() => {})
      this.profiles = []
    }
  }

  list(): ConnectionProfile[] {
    return this.profiles.map((p) => ({ ...p }))
  }

  get(id: string): ConnectionProfile | undefined {
    return this.profiles.find((p) => p.id === id)
  }

  findByAlias(alias: string): ConnectionProfile | undefined {
    return this.profiles.find((p) => p.sshAlias === alias)
  }

  /** Create (no `id`) or update (known `id`) a profile. */
  async save(input: ConnectionProfileInput): Promise<ConnectionProfile> {
    const parsed = ConnectionProfileInputSchema.safeParse(normalizeProfileInput(input))
    if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'Invalid connection')
    const data = parsed.data
    const id = data.id ?? randomUUID()
    const existing = this.get(id)
    if (data.id && !existing) throw invalid('That connection no longer exists')

    if (data.jumpHostId !== undefined) this.checkJumpHost(id, data.jumpHostId)

    const profile: ConnectionProfile = { ...data, id }
    this.profiles = existing
      ? this.profiles.map((p) => (p.id === id ? profile : p))
      : [...this.profiles, profile]
    await this.persist()
    return { ...profile }
  }

  async delete(id: string): Promise<void> {
    const dependents = this.profiles.filter((p) => p.jumpHostId === id)
    if (dependents.length > 0) {
      throw invalid(
        `"${this.get(id)?.name ?? id}" is the jump host of ${dependents.map((p) => `"${p.name}"`).join(', ')}. Change those first.`
      )
    }
    this.profiles = this.profiles.filter((p) => p.id !== id)
    await this.persist()
  }

  private checkJumpHost(id: string, jumpHostId: string): void {
    if (!this.get(jumpHostId)) throw invalid('The chosen jump host no longer exists')
    // Walk the chain: it must never lead back to the profile being saved.
    const seen = new Set<string>()
    for (
      let cur: string | undefined = jumpHostId;
      cur !== undefined;
      cur = this.get(cur)?.jumpHostId
    ) {
      if (cur === id)
        throw invalid('A connection cannot be its own jump host, directly or indirectly')
      if (seen.has(cur)) break
      seen.add(cur)
    }
  }

  private persist(): Promise<void> {
    const snapshot = { version: 1 as const, profiles: this.profiles }
    this.writing = this.writing.then(() => writeJsonAtomic(this.file, snapshot))
    return this.writing
  }
}
