import { FsError } from '@shared/fs-types'
import type {
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionState,
  PromptRequest,
  PromptResponse,
  SshConfigCandidate
} from '@shared/connections'
import type { ConnectionsClient } from '../../src/renderer/src/lib/connections-client'

export interface FakeConnections extends ConnectionsClient {
  profiles: ConnectionProfile[]
  /** Behaviour of the next `connect` calls: resolve, or reject with an error. */
  connectResult: (profileId: string) => Promise<void>
  connected: string[]
  responses: { id: string; response: PromptResponse | null }[]
  emitState(state: ConnectionState): void
  emitPrompt(prompt: PromptRequest): void
  emitPromptCancel(id: string): void
  secureStorage: boolean
  initialStates: ConnectionState[]
}

export const profile = (over: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id: 'p1',
  name: 'Prod',
  host: 'prod.example.com',
  port: 22,
  username: 'me',
  authMethods: ['agent', 'publickey', 'password', 'keyboard-interactive'],
  ...over
})

export function fakeConnections(initial: ConnectionProfile[] = []): FakeConnections {
  const stateListeners = new Set<(s: ConnectionState) => void>()
  const promptListeners = new Set<(p: PromptRequest) => void>()
  const cancelListeners = new Set<(id: string) => void>()
  let nextId = 1

  const fake: FakeConnections = {
    profiles: [...initial],
    connected: [],
    responses: [],
    secureStorage: true,
    initialStates: [],
    connectResult: async () => {},

    listProfiles: async () => fake.profiles.map((p) => ({ ...p })),
    saveProfile: async (input: ConnectionProfileInput) => {
      const saved = { ...input, id: input.id ?? `new-${nextId++}` } as ConnectionProfile
      fake.profiles = input.id
        ? fake.profiles.map((p) => (p.id === input.id ? saved : p))
        : [...fake.profiles, saved]
      return saved
    },
    deleteProfile: async (id) => {
      fake.profiles = fake.profiles.filter((p) => p.id !== id)
    },
    listSshConfig: async (): Promise<SshConfigCandidate[]> => [],
    importSshConfig: async () => [],
    connect: async (id) => {
      await fake.connectResult(id)
      fake.connected.push(id)
    },
    disconnect: async () => {},
    states: async () => fake.initialStates,
    respond: async (id, response) => {
      fake.responses.push({ id, response })
    },
    capabilities: async () => ({ secureStorage: fake.secureStorage }),
    pickFile: async () => null,
    onState: (l) => (stateListeners.add(l), () => stateListeners.delete(l)),
    onPrompt: (l) => (promptListeners.add(l), () => promptListeners.delete(l)),
    onPromptCancel: (l) => (cancelListeners.add(l), () => cancelListeners.delete(l)),

    emitState: (s) => stateListeners.forEach((l) => l(s)),
    emitPrompt: (p) => promptListeners.forEach((l) => l(p)),
    emitPromptCancel: (id) => cancelListeners.forEach((l) => l(id))
  }
  return fake
}

export const fail =
  (code: FsError['code'], message: string = code) =>
  async () => {
    throw new FsError({ code, message })
  }
