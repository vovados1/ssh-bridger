import { Client, type SFTPWrapper } from 'ssh2'
import type { Duplex } from 'node:stream'
import { FsError } from '@shared/fs-types'
import {
  sshMachineId,
  type ConnectionProfile,
  type ConnectionState,
  type ConnectionStatus
} from '@shared/connections'
import { SftpProvider, type SftpSource } from '../fs/sftp-provider'
import type { MachineRegistry } from '../fs/registry'
import type { ProfileStore } from '../store/profile-store'
import type { SecretStore } from '../store/secret-store'
import { makeAuthHandler, SessionCredentials } from './auth'
import {
  describeKey,
  hostToken,
  knownKeyTypes,
  preferredAlgorithms,
  SUPPORTED_HOST_KEY_ALGORITHMS,
  verifyHostKey,
  type KnownHostEntry,
  type KnownHostsFile
} from './known-hosts'
import type { Prompter } from './prompter'
import { applyAlias } from './ssh-config'

export interface ConnectionManagerDeps {
  profiles: ProfileStore
  secrets: SecretStore
  prompter: Prompter
  knownHosts: KnownHostsFile
  registry: MachineRegistry
  /** Contents of ~/.ssh/config, or null if there is none. Read on every connect. */
  readSshConfig(): Promise<string | null>
  /** `SSH_AUTH_SOCK`, if an agent is running. */
  agentSocket: string | undefined
  /** Used when a profile leaves the user name empty. */
  localUsername: string
  homeDir: string
  onState(state: ConnectionState): void
  /** Pause before each automatic reconnect attempt; its length is the number of attempts. */
  reconnectDelaysMs?: number[]
  readyTimeoutMs?: number
  keepaliveIntervalMs?: number
}

const DEFAULT_RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000]

const fail = (code: FsError['code'], message: string): FsError => new FsError({ code, message })

/** One profile's live connection. Owned by the manager; shared by every column on that host. */
class Connection implements SftpSource {
  status: ConnectionStatus = 'disconnected'
  error: string | undefined
  attempt: number | undefined
  client: Client | undefined
  /** Profile with ~/.ssh/config applied, as of the last connect. */
  resolved: ConnectionProfile
  abort = new AbortController()
  userClosed = false
  /** Bumped by connect/disconnect so a stale reconnect loop knows to stop. */
  generation = 0
  connecting: Promise<void> | undefined
  readonly session = new SessionCredentials()
  /** Host keys the user chose to trust for this session only. */
  readonly trustedThisSession = new Set<string>()
  readonly provider: SftpProvider
  private channel: Promise<SFTPWrapper> | undefined

  constructor(public profile: ConnectionProfile) {
    this.resolved = profile
    this.provider = new SftpProvider(sshMachineId(profile.id), this)
  }

  get defaultPath(): string | undefined {
    return this.resolved.defaultPath
  }

  sftp(): Promise<SFTPWrapper> {
    const client = this.client
    if (this.status !== 'connected' || !client) {
      const why = this.status === 'reconnecting' ? 'is being restored' : 'is closed'
      return Promise.reject(
        fail('EDISCONNECTED', `The connection to "${this.profile.name}" ${why}`)
      )
    }
    this.channel ??= new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(err)
        const forget = (): void => {
          this.channel = undefined
        }
        sftp.once('close', forget)
        sftp.once('end', forget)
        resolve(sftp)
      })
    }).catch((err: unknown) => {
      this.channel = undefined
      throw err
    })
    return this.channel
  }

  dropChannel(): void {
    this.channel = undefined
  }
}

export class ConnectionManager {
  private readonly conns = new Map<string, Connection>()

  constructor(private readonly deps: ConnectionManagerDeps) {}

  states(): ConnectionState[] {
    return [...this.conns.values()].map((c) => stateOf(c))
  }

  /** Connect (interactively) and resolve once the SFTP provider is usable. */
  async connect(profileId: string): Promise<void> {
    const profile = this.deps.profiles.get(profileId)
    if (!profile) throw fail('EUNKNOWN', 'That connection no longer exists')

    let conn = this.conns.get(profileId)
    if (conn?.status === 'connected') return
    if (conn?.connecting) return conn.connecting
    if (!conn) {
      conn = new Connection(profile)
      this.conns.set(profileId, conn)
    }
    conn.profile = profile
    conn.userClosed = false
    conn.generation++ // retire any reconnect loop still running
    conn.abort = new AbortController()

    const attempt = this.run(conn, true).finally(() => {
      conn.connecting = undefined
    })
    conn.connecting = attempt
    return attempt
  }

  async disconnect(profileId: string): Promise<void> {
    const conn = this.conns.get(profileId)
    if (!conn) return
    conn.userClosed = true
    conn.generation++
    conn.abort.abort()
    conn.client?.end()
    conn.client?.destroy()
    conn.client = undefined
    conn.dropChannel()
    this.deps.registry.unregister(conn.provider.id)
    this.conns.delete(profileId)
    this.deps.onState({ profileId, status: 'disconnected' })
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((id) => this.disconnect(id)))
  }

  // ---- connecting ------------------------------------------------------------------------

  private async run(conn: Connection, interactive: boolean): Promise<void> {
    this.setState(conn, 'connecting')
    try {
      await this.establish(conn, interactive)
    } catch (err) {
      const e = toConnectError(err, conn.resolved)
      conn.client?.destroy()
      conn.client = undefined
      // A cancelled attempt is not a failure worth showing; anything else stays visible.
      this.setState(conn, e.code === 'ECANCELLED' ? 'disconnected' : 'error', e.message)
      throw e
    }
    await this.onConnected(conn)
  }

  private async onConnected(conn: Connection): Promise<void> {
    // Remember secrets only now that they demonstrably worked.
    for (const [key, value] of conn.session.rememberOnSuccess)
      await this.deps.secrets.set(key, value)
    conn.session.rememberOnSuccess.clear()
    this.deps.registry.register(conn.provider)
    this.setState(conn, 'connected')
  }

  private async establish(conn: Connection, interactive: boolean): Promise<void> {
    const d = this.deps
    const profile = applyAlias(conn.profile, await d.readSshConfig(), d.homeDir)
    conn.resolved = profile
    const username = profile.username || d.localUsername
    const signal = conn.abort.signal
    if (signal.aborted) throw fail('ECANCELLED', 'Connection cancelled')

    let sock: Duplex | undefined
    if (profile.jumpHostId) {
      const jump = await this.requireJump(profile.jumpHostId, interactive)
      sock = await forwardOut(jump.client!, profile.host, profile.port)
    }

    const known = await d.knownHosts.load()
    const preferred = preferredAlgorithms(knownKeyTypes(known, profile.host, profile.port))
    const client = new Client()

    let fatal: unknown
    let hostKeyError: FsError | undefined

    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        client.destroy()
        reject(fail('ECANCELLED', 'Connection cancelled'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const settle = (): void => signal.removeEventListener('abort', onAbort)

      client.once('ready', () => {
        settle()
        resolve()
      })
      client.once('error', (err) => {
        settle()
        client.destroy()
        reject(fatal ?? hostKeyError ?? err)
      })

      const authDeps = {
        profile,
        username,
        prompter: d.prompter,
        secrets: d.secrets,
        session: conn.session,
        agentSocket: d.agentSocket,
        signal,
        interactive,
        homeDir: d.homeDir
      }

      client.connect({
        host: profile.host,
        port: profile.port,
        username,
        ...(sock ? { sock } : {}),
        readyTimeout: d.readyTimeoutMs ?? 20_000,
        keepaliveInterval: d.keepaliveIntervalMs ?? 15_000,
        keepaliveCountMax: 3,
        // Known key types first; the rest stay on offer so a swapped key is reported as "changed", not as a handshake error.
        ...(preferred.length > 0
          ? {
              algorithms: {
                serverHostKey: [
                  ...preferred,
                  ...SUPPORTED_HOST_KEY_ALGORITHMS.filter((a) => !preferred.includes(a))
                ]
              }
            }
          : {}),
        authHandler: makeAuthHandler(authDeps, (err) => (fatal = err)),
        hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
          this.checkHostKey(conn, known, profile, key, interactive, signal).then(
            (result) => {
              if (result instanceof FsError) hostKeyError = result
              verify(!(result instanceof FsError))
            },
            (err: unknown) => {
              fatal = err
              verify(false)
            }
          )
        }
      })
    })

    conn.client = client
    client.on('error', () => {
      /* post-handshake errors are followed by 'close', which drives reconnecting */
    })
    client.on('close', () => this.onClosed(conn, client))
  }

  /** Resolves to true when trusted, or an FsError explaining why not. Throws only for cancellation. */
  private async checkHostKey(
    conn: Connection,
    known: KnownHostEntry[],
    profile: ConnectionProfile,
    key: Buffer,
    interactive: boolean,
    signal: AbortSignal
  ): Promise<true | FsError> {
    const { keyType, keyBase64, fingerprint } = describeKey(key)
    const token = hostToken(profile.host, profile.port)
    const verdict = verifyHostKey(known, profile.host, profile.port, keyType, keyBase64)

    if (verdict === 'trusted') return true
    if (verdict === 'revoked') {
      return fail(
        'EHOSTKEY',
        `The host key for "${token}" (${fingerprint}) is marked as revoked in known_hosts. Connection refused.`
      )
    }
    if (verdict === 'changed') {
      // The one thing we never offer to click through.
      return fail(
        'EHOSTKEY',
        `WARNING: the host key for "${token}" has CHANGED (now ${fingerprint}). Someone may be intercepting the connection. ` +
          `Connection refused. If the server was legitimately reinstalled, remove its old line from ${this.deps.knownHosts.path} and connect again.`
      )
    }

    const sessionKey = `${token} ${keyType} ${fingerprint}`
    if (conn.trustedThisSession.has(sessionKey)) return true
    if (!interactive) {
      return fail(
        'EHOSTKEY',
        `The host key for "${token}" is not trusted yet. Connect manually to review it.`
      )
    }

    const answer = await this.deps.prompter.ask(
      {
        kind: 'hostkey',
        profileId: profile.id,
        profileName: profile.name,
        host: profile.host,
        port: profile.port,
        keyType,
        fingerprint
      },
      signal
    )
    if (answer === null) throw fail('ECANCELLED', 'Connection cancelled')
    if (answer.kind !== 'hostkey' || !answer.accept) {
      return fail('EHOSTKEY', `You did not trust the host key for "${token}". Connection refused.`)
    }
    conn.trustedThisSession.add(sessionKey)
    if (answer.remember)
      await this.deps.knownHosts.add(profile.host, profile.port, keyType, keyBase64)
    return true
  }

  private async requireJump(jumpId: string, interactive: boolean): Promise<Connection> {
    let jump = this.conns.get(jumpId)
    if (jump?.status !== 'connected') {
      // An automatic reconnect must not open prompts for a different host.
      if (!interactive) throw fail('ECONNECT', 'The jump host is not connected')
      await this.connect(jumpId)
      jump = this.conns.get(jumpId)
    }
    if (!jump?.client) throw fail('ECONNECT', 'The jump host is not connected')
    return jump
  }

  // ---- losing and restoring the connection -------------------------------------------------

  private onClosed(conn: Connection, client: Client): void {
    if (conn.client !== client) return // an old client closing after we replaced it
    conn.client = undefined
    conn.dropChannel()
    if (conn.userClosed) return
    void this.reconnect(conn)
  }

  /** Quietly retry with backoff. Never prompts; gives up on errors only the user can fix. */
  private async reconnect(conn: Connection): Promise<void> {
    const generation = ++conn.generation
    const delays = this.deps.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS
    let last: FsError | undefined

    for (let attempt = 1; attempt <= delays.length; attempt++) {
      conn.attempt = attempt
      this.setState(conn, 'reconnecting', last?.message)
      await sleep(delays[attempt - 1]!)
      if (conn.generation !== generation || conn.userClosed) return

      try {
        await this.establish(conn, false)
        if (conn.generation !== generation || conn.userClosed) {
          conn.client?.destroy()
          return
        }
        conn.attempt = undefined
        await this.onConnected(conn)
        return
      } catch (err) {
        last = toConnectError(err, conn.resolved)
        if (conn.generation !== generation) return
        if (['EAUTH', 'EHOSTKEY', 'ECANCELLED'].includes(last.code)) break
      }
    }
    conn.attempt = undefined
    this.setState(conn, 'disconnected', last?.message ?? 'The connection was lost')
  }

  private setState(conn: Connection, status: ConnectionStatus, error?: string): void {
    conn.status = status
    conn.error = status === 'connected' ? undefined : error
    if (status !== 'reconnecting') conn.attempt = undefined
    this.deps.onState(stateOf(conn))
  }
}

function stateOf(conn: Connection): ConnectionState {
  return {
    profileId: conn.profile.id,
    status: conn.status,
    ...(conn.error ? { error: conn.error } : {}),
    ...(conn.attempt ? { attempt: conn.attempt } : {})
  }
}

function forwardOut(client: Client, host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
      if (err)
        reject(fail('ECONNECT', `The jump host could not reach ${host}:${port} (${err.message})`))
      else resolve(stream)
    })
  })
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const NETWORK_ERRORS: Record<string, (host: string, port: number) => string> = {
  ECONNREFUSED: (h, p) => `Connection refused by ${h}:${p}. Is an SSH server running there?`,
  ENOTFOUND: (h) => `Could not resolve the host name "${h}"`,
  EAI_AGAIN: (h) => `Could not resolve the host name "${h}"`,
  ETIMEDOUT: (h, p) => `Timed out connecting to ${h}:${p}`,
  EHOSTUNREACH: (h) => `Host "${h}" is unreachable`,
  ENETUNREACH: (h) => `Network unreachable while connecting to "${h}"`,
  ECONNRESET: (h) => `The connection to "${h}" was reset`
}

/** Turn whatever ssh2 or the network threw into an FsError with a message a person can act on. */
export function toConnectError(
  err: unknown,
  profile: Pick<ConnectionProfile, 'host' | 'port' | 'username'>
): FsError {
  if (err instanceof FsError) return err
  const e = err as { code?: string; level?: string; message?: string } | null
  const message = e?.message ?? String(err)

  if (e?.level === 'client-authentication') {
    return fail(
      'EAUTH',
      `Authentication failed for ${profile.username ? profile.username + '@' : ''}${profile.host}. Check your password or key.`
    )
  }
  const network = e?.code ? NETWORK_ERRORS[e.code] : undefined
  if (network) return fail('ECONNECT', network(profile.host, profile.port))
  if (e?.level === 'client-timeout' || /timed out/i.test(message)) {
    return fail('ECONNECT', `Timed out connecting to ${profile.host}:${profile.port}`)
  }
  if (/no matching|handshake failed/i.test(message)) {
    return fail(
      'ECONNECT',
      `Could not negotiate a secure connection with ${profile.host}: ${message}`
    )
  }
  return fail('EUNKNOWN', message)
}
