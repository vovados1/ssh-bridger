import { createStore, type StoreApi } from 'zustand/vanilla'
import { FsError } from '@shared/fs-types'
import type {
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionState,
  PromptRequest,
  PromptResponse,
  SshConfigCandidate
} from '@shared/connections'
import type { ConnectionsClient } from '../../lib/connections-client'

export interface ConnectionsState {
  loaded: boolean
  profiles: ConnectionProfile[]
  states: Record<string, ConnectionState>
  /** Prompts waiting for the user, oldest first; the UI shows the first. */
  prompts: PromptRequest[]
  /** Whether passwords may be remembered (an OS keyring exists). */
  secureStorage: boolean

  init(): Promise<void>
  dispose(): void
  saveProfile(input: ConnectionProfileInput): Promise<ConnectionProfile>
  deleteProfile(id: string): Promise<void>
  /** Connect and resolve with null, or with the error that stopped it (never throws). */
  connect(profileId: string): Promise<FsError | null>
  disconnect(profileId: string): Promise<void>
  answerPrompt(promptId: string, response: PromptResponse | null): void
  /** Re-read profiles from main, e.g. after an import. */
  reloadProfiles(): Promise<void>
  listSshConfig(): Promise<SshConfigCandidate[]>
  /** Import the aliases as profiles; resolves to the ones newly created. */
  importSshConfig(aliases: string[]): Promise<ConnectionProfile[]>
  pickFile(title: string, startIn?: string): Promise<string | null>
}

export type ConnectionsStore = StoreApi<ConnectionsState>

function toFsError(err: unknown): FsError {
  return err instanceof FsError
    ? err
    : new FsError({ code: 'EUNKNOWN', message: err instanceof Error ? err.message : String(err) })
}

export function createConnectionsStore(client: ConnectionsClient): ConnectionsStore {
  let unsubscribers: (() => void)[] = []

  return createStore<ConnectionsState>()((set, get) => ({
    loaded: false,
    profiles: [],
    states: {},
    prompts: [],
    secureStorage: false,

    async init() {
      get().dispose()
      // Subscribe before loading so nothing that happens during the load is missed.
      unsubscribers = [
        client.onState((state) => {
          const states = { ...get().states }
          // A cleanly disconnected profile has no connection; drop it from the map.
          if (state.status === 'disconnected' && !state.error) delete states[state.profileId]
          else states[state.profileId] = state
          set({ states })
        }),
        client.onPrompt((prompt) => set({ prompts: [...get().prompts, prompt] })),
        client.onPromptCancel((id) => set({ prompts: get().prompts.filter((p) => p.id !== id) }))
      ]
      const [profiles, states, caps] = await Promise.all([
        client.listProfiles(),
        client.states(),
        client.capabilities()
      ])
      set({
        loaded: true,
        profiles,
        states: Object.fromEntries(states.map((s) => [s.profileId, s])),
        secureStorage: caps.secureStorage
      })
    },

    dispose() {
      for (const off of unsubscribers) off()
      unsubscribers = []
    },

    async reloadProfiles() {
      set({ profiles: await client.listProfiles() })
    },

    listSshConfig: () => client.listSshConfig(),

    async importSshConfig(aliases) {
      const created = await client.importSshConfig(aliases)
      await get().reloadProfiles()
      return created
    },

    pickFile: (title, startIn) => client.pickFile(title, startIn),

    async saveProfile(input) {
      const saved = await client.saveProfile(input)
      await get().reloadProfiles()
      return saved
    },

    async deleteProfile(id) {
      await client.deleteProfile(id)
      await get().reloadProfiles()
    },

    async connect(profileId) {
      try {
        await client.connect(profileId)
        return null
      } catch (err) {
        return toFsError(err)
      }
    },

    async disconnect(profileId) {
      await client.disconnect(profileId)
    },

    answerPrompt(promptId, response) {
      set({ prompts: get().prompts.filter((p) => p.id !== promptId) })
      void client.respond(promptId, response)
    }
  }))
}
