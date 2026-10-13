import type {
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionState,
  PromptRequest,
  PromptResponse,
  SshConfigCandidate
} from '@shared/connections'

/** What the renderer needs from main for SSH connections. Faked in tests. */
export interface ConnectionsClient {
  listProfiles(): Promise<ConnectionProfile[]>
  saveProfile(input: ConnectionProfileInput): Promise<ConnectionProfile>
  deleteProfile(id: string): Promise<void>
  listSshConfig(): Promise<SshConfigCandidate[]>
  importSshConfig(aliases: string[]): Promise<ConnectionProfile[]>

  /** Rejects with an FsError (EAUTH / ECONNECT / EHOSTKEY / ECANCELLED) when it fails. */
  connect(profileId: string): Promise<void>
  disconnect(profileId: string): Promise<void>
  states(): Promise<ConnectionState[]>
  respond(promptId: string, response: PromptResponse | null): Promise<void>

  capabilities(): Promise<{ secureStorage: boolean }>
  /** Native file picker; null when cancelled. */
  pickFile(title: string, startIn?: string): Promise<string | null>

  onState(listener: (state: ConnectionState) => void): () => void
  onPrompt(listener: (prompt: PromptRequest) => void): () => void
  onPromptCancel(listener: (promptId: string) => void): () => void
}
