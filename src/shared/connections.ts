/**
 * Types for SSH connection profiles, connection state and the interactive prompts main
 * raises while connecting. Plain types only (no zod) so the renderer can import them freely;
 * the validation schemas live in connection-schemas.ts.
 */

export type AuthMethodId = 'agent' | 'publickey' | 'password' | 'keyboard-interactive'

/** Tried in this order unless a profile says otherwise. */
export const DEFAULT_AUTH_METHODS: readonly AuthMethodId[] = [
  'agent',
  'publickey',
  'password',
  'keyboard-interactive'
]

export interface ConnectionProfile {
  id: string
  name: string
  host: string
  port: number
  /** Empty means "the local user name", like `ssh host`. */
  username: string
  authMethods: AuthMethodId[]
  /** Private key to use for `publickey`; default keys in ~/.ssh are tried when unset. */
  identityFile?: string
  /** Another profile to tunnel through (like ProxyJump). */
  jumpHostId?: string
  /** Folder to open first; the remote home directory when unset. */
  defaultPath?: string
  /** Accent color for the column header, as `#rrggbb`. */
  color?: string
  /** `Host` alias in ~/.ssh/config this profile is linked to; re-read on every connect. */
  sshAlias?: string
}

/** What the editor submits; `id` is assigned on first save. */
export type ConnectionProfileInput = Omit<ConnectionProfile, 'id'> & { id?: string }

export type ConnectionStatus =
  'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'

export interface ConnectionState {
  profileId: string
  status: ConnectionStatus
  /** Why we are in `error` / `disconnected`, or what the last failed attempt said. */
  error?: string
  /** Reconnect attempt number while `reconnecting`. */
  attempt?: number
}

/** A concrete `Host` block found in ~/.ssh/config, offered for import. */
export interface SshConfigCandidate {
  alias: string
  hostName: string
  user?: string
  port: number
  identityFile?: string
  proxyJump?: string
  /** A profile linked to this alias already exists. */
  imported: boolean
}

// ---- interactive prompts: main asks, the renderer answers --------------------------------

interface PromptBase {
  /** Correlates the answer; unique per prompt. */
  id: string
  profileId: string
  profileName: string
}

export type PromptRequest =
  | (PromptBase & {
      kind: 'password'
      username: string
      host: string
      /** The previous attempt was rejected. */
      retry: boolean
      /** Offer "remember"; false when no secure storage exists. */
      canRemember: boolean
    })
  | (PromptBase & {
      kind: 'passphrase'
      keyPath: string
      retry: boolean
      canRemember: boolean
    })
  | (PromptBase & {
      kind: 'keyboard-interactive'
      name: string
      instructions: string
      prompts: { prompt: string; echo: boolean }[]
    })
  | (PromptBase & {
      kind: 'hostkey'
      host: string
      port: number
      keyType: string
      /** `SHA256:...` as shown by OpenSSH. */
      fingerprint: string
    })

export type PromptResponse =
  | { kind: 'password' | 'passphrase'; value: string; remember: boolean }
  | { kind: 'keyboard-interactive'; answers: string[] }
  | {
      kind: 'hostkey'
      accept: boolean
      /** Write the key to ~/.ssh/known_hosts. */ remember: boolean
    }

export const DEFAULT_SSH_PORT = 22

/** Machine id of a profile's SFTP provider. */
export function sshMachineId(profileId: string): `ssh:${string}` {
  return `ssh:${profileId}`
}

export function profileIdOf(machineId: string): string | null {
  return machineId.startsWith('ssh:') ? machineId.slice(4) : null
}
