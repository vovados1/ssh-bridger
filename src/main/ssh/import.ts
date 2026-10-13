import { DEFAULT_AUTH_METHODS, DEFAULT_SSH_PORT, type ConnectionProfile } from '@shared/connections'
import type { ProfileStore } from '../store/profile-store'
import { listAliases, parseProxyJump, resolveHost } from './ssh-config'

const MAX_JUMP_DEPTH = 5

/**
 * Create profiles linked to the given `Host` aliases of an ssh config. Aliases already
 * imported are left alone. A ProxyJump becomes the profile's jump host (imported too, if it
 * is itself an alias in the file; otherwise a plain profile for that host). Returns only
 * what was newly created, jump hosts included.
 */
export async function importAliases(
  store: ProfileStore,
  configText: string,
  aliases: readonly string[],
  home: string
): Promise<ConnectionProfile[]> {
  const known = new Set(listAliases(configText))
  const created: ConnectionProfile[] = []

  async function ensureAlias(alias: string, depth: number): Promise<ConnectionProfile> {
    const existing = store.findByAlias(alias)
    if (existing) return existing

    const r = resolveHost(configText, alias, home)
    let jumpHostId: string | undefined
    if (r.proxyJump && depth < MAX_JUMP_DEPTH) {
      const hop = parseProxyJump(r.proxyJump)
      if (hop) {
        const jump = known.has(hop.host)
          ? await ensureAlias(hop.host, depth + 1)
          : await ensureHost(hop.host, hop.port, hop.user ?? '')
        jumpHostId = jump.id
      }
    }

    const profile = await store.save({
      name: alias,
      host: r.hostName,
      port: r.port,
      username: r.user ?? '',
      authMethods: [...DEFAULT_AUTH_METHODS],
      sshAlias: alias,
      ...(r.identityFile ? { identityFile: r.identityFile } : {}),
      ...(jumpHostId ? { jumpHostId } : {})
    })
    created.push(profile)
    return profile
  }

  /** A jump host that is not described in the config: match an existing profile or make a bare one. */
  async function ensureHost(
    host: string,
    port: number,
    username: string
  ): Promise<ConnectionProfile> {
    const existing = store
      .list()
      .find(
        (p) => p.host === host && p.port === port && (username === '' || p.username === username)
      )
    if (existing) return existing
    const profile = await store.save({
      name: host,
      host,
      port: port || DEFAULT_SSH_PORT,
      username,
      authMethods: [...DEFAULT_AUTH_METHODS]
    })
    created.push(profile)
    return profile
  }

  for (const alias of aliases) {
    if (known.has(alias)) await ensureAlias(alias, 0)
  }
  return created
}
