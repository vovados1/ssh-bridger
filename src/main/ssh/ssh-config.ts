import { homedir } from 'node:os'
import { join } from 'node:path'
// Named imports on purpose: the default export is not reachable when the main bundle is CommonJS.
import { LineType, parse } from 'ssh-config'
import {
  DEFAULT_SSH_PORT,
  type ConnectionProfile,
  type SshConfigCandidate
} from '@shared/connections'

/**
 * Reading ~/.ssh/config. Only what a file manager needs is understood: HostName, User, Port,
 * IdentityFile and ProxyJump, with `Host *` defaults and patterns applied the way ssh does.
 * `Include` and `Match` blocks are not followed.
 */

export interface ResolvedHost {
  hostName: string
  user?: string
  port: number
  identityFile?: string
  proxyJump?: string
}

function expandHome(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value

/** Merge every matching block for `alias`, as `ssh -G alias` would. */
export function resolveHost(text: string, alias: string, home = homedir()): ResolvedHost {
  const computed = parse(text).compute(alias)
  const identity = first(computed['IdentityFile'])
  const user = first(computed['User'])
  const port = Number(first(computed['Port']))
  const proxy = first(computed['ProxyJump'])
  return {
    hostName: first(computed['HostName']) ?? alias,
    ...(user ? { user } : {}),
    port: Number.isInteger(port) && port > 0 ? port : DEFAULT_SSH_PORT,
    ...(identity ? { identityFile: expandHome(identity, home) } : {}),
    ...(proxy && proxy.toLowerCase() !== 'none' ? { proxyJump: proxy } : {})
  }
}

/** Concrete aliases (no wildcards or negations) defined in the file, in file order. */
export function listAliases(text: string): string[] {
  const aliases: string[] = []
  for (const line of parse(text)) {
    if (line.type !== LineType.DIRECTIVE || line.param.toLowerCase() !== 'host') continue
    const values = Array.isArray(line.value) ? line.value.map((v) => v.val) : [String(line.value)]
    for (const v of values) {
      if (!/[*?!]/.test(v) && !aliases.includes(v)) aliases.push(v)
    }
  }
  return aliases
}

export function listCandidates(
  text: string,
  importedAliases: ReadonlySet<string>,
  home = homedir()
): SshConfigCandidate[] {
  return listAliases(text).map((alias) => {
    const r = resolveHost(text, alias, home)
    return {
      alias,
      hostName: r.hostName,
      port: r.port,
      imported: importedAliases.has(alias),
      ...(r.user ? { user: r.user } : {}),
      ...(r.identityFile ? { identityFile: r.identityFile } : {}),
      ...(r.proxyJump ? { proxyJump: r.proxyJump } : {})
    }
  })
}

/**
 * Overlay the current ssh config onto a profile linked to an alias, so edits to
 * ~/.ssh/config take effect on the next connect. Profile fields remain as fallbacks.
 */
export function applyAlias(
  profile: ConnectionProfile,
  configText: string | null,
  home = homedir()
): ConnectionProfile {
  if (!profile.sshAlias || configText === null) return profile
  const r = resolveHost(configText, profile.sshAlias, home)
  return {
    ...profile,
    host: r.hostName,
    port: r.port,
    username: r.user ?? profile.username,
    ...((r.identityFile ?? profile.identityFile)
      ? { identityFile: (r.identityFile ?? profile.identityFile)! }
      : {})
  }
}

/** First hop of a ProxyJump value (`[user@]host[:port]`, comma separated). Later hops are ignored. */
export function parseProxyJump(
  value: string
): { user?: string; host: string; port: number } | null {
  const hop = value.split(',')[0]?.trim()
  if (!hop) return null
  const m = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hop)
  if (!m) return null
  const host = m[2]!.replace(/^\[|\]$/g, '')
  return { ...(m[1] ? { user: m[1] } : {}), host, port: m[3] ? Number(m[3]) : DEFAULT_SSH_PORT }
}
