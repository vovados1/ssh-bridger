import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  utils,
  type AnyAuthMethod,
  type AuthHandlerMiddleware,
  type AuthenticationType,
  type NextAuthHandler,
  type ParsedKey
} from 'ssh2'
import { FsError } from '@shared/fs-types'
import type { ConnectionProfile } from '@shared/connections'
import { passphraseKey, passwordKey, type SecretStore } from '../store/secret-store'
import type { Prompter } from './prompter'

/** Credentials typed in during this connection's life, kept so a reconnect does not ask again. */
export class SessionCredentials {
  password: string | undefined
  readonly passphrases = new Map<string, string>()
  /** Things to save to the keyring once the connection has actually authenticated. */
  readonly rememberOnSuccess = new Map<string, string>()
}

export interface AuthDeps {
  profile: ConnectionProfile
  username: string
  prompter: Prompter
  secrets: SecretStore
  session: SessionCredentials
  agentSocket: string | undefined
  signal: AbortSignal
  /** False for automatic reconnects: use what we already have, never raise a prompt. */
  interactive: boolean
  homeDir?: string
  /** Injected for tests. */
  readFile?: (path: string) => Promise<Buffer>
}

const MAX_ATTEMPTS = 3
const DEFAULT_KEY_NAMES = ['id_ed25519', 'id_ecdsa', 'id_rsa']

/** ssh2 accepts `false` to say "no more methods", but its typings omit it. */
const giveUp = (next: NextAuthHandler): void => (next as unknown as (v: false) => void)(false)

const cancelled = (): FsError =>
  new FsError({ code: 'ECANCELLED', message: 'Connection cancelled' })

/** Which method name the server lists for ours: an agent signs publickey requests. */
function serverName(type: AuthenticationType): AuthenticationType {
  return type === 'agent' ? 'publickey' : type
}

/**
 * Private keys to try: the profile's explicit key, or the usual ones in ~/.ssh.
 * Encrypted keys ask for a passphrase (once per key, remembered for the session).
 */
async function loadKey(path: string, d: AuthDeps): Promise<ParsedKey | null> {
  const read = d.readFile ?? readFile
  let data: Buffer
  try {
    data = await read(path)
  } catch {
    return null // missing or unreadable: skip, as ssh does
  }

  let parsed = utils.parseKey(data)
  if (!(parsed instanceof Error)) return Array.isArray(parsed) ? (parsed[0] ?? null) : parsed
  if (!/encrypted|passphrase/i.test(parsed.message)) return null // not a key we can use

  let retry = false
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let passphrase =
      attempt === 0
        ? (d.session.passphrases.get(path) ?? d.secrets.get(passphraseKey(path)))
        : undefined
    let remember = false
    if (passphrase === undefined) {
      if (!d.interactive) return null
      const answer = await d.prompter.ask(
        {
          kind: 'passphrase',
          profileId: d.profile.id,
          profileName: d.profile.name,
          keyPath: path,
          retry,
          canRemember: d.secrets.available
        },
        d.signal
      )
      if (!answer || answer.kind !== 'passphrase') throw cancelled()
      passphrase = answer.value
      remember = answer.remember
    }
    parsed = utils.parseKey(data, passphrase)
    if (!(parsed instanceof Error)) {
      d.session.passphrases.set(path, passphrase)
      if (remember) d.session.rememberOnSuccess.set(passphraseKey(path), passphrase)
      return Array.isArray(parsed) ? (parsed[0] ?? null) : parsed
    }
    retry = true
  }
  return null
}

/**
 * The authentication methods to try, lazily and in the profile's order. Being lazy matters:
 * a password prompt only appears once the earlier methods (agent, keys) have failed.
 * Throws ECANCELLED if the user dismisses a prompt.
 */
export async function* authCandidates(
  d: AuthDeps,
  /** Whether the server lists this method; checked before prompting so we never ask for a credential it won't take. */
  allows: (type: AuthenticationType) => boolean = () => true
): AsyncGenerator<AnyAuthMethod, void> {
  const { profile, username } = d
  const home = d.homeDir ?? homedir()

  for (const method of profile.authMethods) {
    if (d.signal.aborted) throw cancelled()
    if (!allows(serverName(method))) continue

    if (method === 'agent') {
      if (d.agentSocket) yield { type: 'agent', username, agent: d.agentSocket }
    } else if (method === 'publickey') {
      const paths = profile.identityFile
        ? [profile.identityFile]
        : DEFAULT_KEY_NAMES.map((n) => join(home, '.ssh', n))
      for (const path of paths) {
        const key = await loadKey(path, d)
        if (key) yield { type: 'publickey', username, key }
      }
    } else if (method === 'password') {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let password =
          attempt === 0 ? (d.session.password ?? d.secrets.get(passwordKey(profile.id))) : undefined
        if (password === undefined) {
          if (!d.interactive) break
          const answer = await d.prompter.ask(
            {
              kind: 'password',
              profileId: profile.id,
              profileName: profile.name,
              username,
              host: profile.host,
              retry: attempt > 0,
              canRemember: d.secrets.available
            },
            d.signal
          )
          if (!answer || answer.kind !== 'password') throw cancelled()
          password = answer.value
          if (answer.remember) d.session.rememberOnSuccess.set(passwordKey(profile.id), password)
          else d.session.rememberOnSuccess.delete(passwordKey(profile.id))
        }
        d.session.password = password
        // The generator is only resumed when the server rejected this attempt.
        yield { type: 'password', username, password }
        d.session.password = undefined
        d.session.rememberOnSuccess.delete(passwordKey(profile.id)) // never save a rejected password
        await d.secrets.delete(passwordKey(profile.id)) // a stored password that fails is stale
      }
    } else if (method === 'keyboard-interactive') {
      if (!d.interactive && d.session.password === undefined) continue
      yield {
        type: 'keyboard-interactive',
        username,
        prompt: (name, instructions, _lang, prompts, finish) => {
          void answerKeyboardInteractive(d, name, instructions, prompts).then(finish, () =>
            finish([])
          )
        }
      }
    }
  }
}

async function answerKeyboardInteractive(
  d: AuthDeps,
  name: string,
  instructions: string,
  prompts: { prompt: string; echo?: boolean }[]
): Promise<string[]> {
  if (prompts.length === 0) return []
  // Many servers ask for the password this way; reuse one we already know instead of asking twice.
  const known = d.session.password ?? d.secrets.get(passwordKey(d.profile.id))
  if (known !== undefined && prompts.length === 1 && /password/i.test(prompts[0]!.prompt))
    return [known]
  if (!d.interactive) return prompts.map(() => '')

  const answer = await d.prompter.ask(
    {
      kind: 'keyboard-interactive',
      profileId: d.profile.id,
      profileName: d.profile.name,
      name,
      instructions,
      prompts: prompts.map((p) => ({ prompt: p.prompt, echo: p.echo ?? false }))
    },
    d.signal
  )
  if (!answer || answer.kind !== 'keyboard-interactive') throw cancelled()
  return answer.answers
}

/**
 * ssh2 `authHandler`: each time the server rejects (or at the start) take the next candidate
 * the server still accepts. `onFatal` receives errors that must abort the connection
 * (a cancelled prompt), after which no further method is offered.
 */
export function makeAuthHandler(
  d: AuthDeps,
  onFatal: (err: unknown) => void
): AuthHandlerMiddleware {
  /** What the server last said it accepts; null until it has told us. */
  let allowed: Set<AuthenticationType> | null = null
  const candidates = authCandidates(d, (type) => allowed === null || allowed.has(type))
  let probed = false

  return (authsLeft, _partialSuccess, next) => {
    // Like OpenSSH, first ask the server what it accepts ("none"), so we never prompt for
    // a password the server would refuse to take.
    if (!probed) {
      probed = true
      return next('none')
    }
    allowed = Array.isArray(authsLeft) && authsLeft.length > 0 ? new Set(authsLeft) : null

    candidates.next().then(
      ({ value, done }) => {
        if (done) giveUp(next)
        else next(value)
      },
      (err: unknown) => {
        onFatal(err)
        giveUp(next)
      }
    )
  }
}
