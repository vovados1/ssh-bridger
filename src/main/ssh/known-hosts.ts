import { createHash, createHmac } from 'node:crypto'
import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Reading and writing OpenSSH's known_hosts, so hosts you already trust in a terminal are
 * trusted here and vice versa.
 */

export interface KnownHostEntry {
  marker?: 'cert-authority' | 'revoked'
  /** Plain patterns (`host`, `[host]:port`, wildcards, `!negations`), or one hashed entry. */
  patterns: string[]
  hashed?: { salt: Buffer; hash: Buffer }
  keyType: string
  /** Base64 of the public key blob, exactly as written in the file. */
  key: string
}

export type HostKeyVerdict =
  /** This exact key is on file. */
  | 'trusted'
  /** Nothing on file for this host. Ask the user. */
  | 'unknown'
  /** The host is on file with different key(s): possible man-in-the-middle. Never accept silently. */
  | 'changed'
  /** The key is explicitly marked @revoked. */
  | 'revoked'

export function parseKnownHosts(text: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const fields = line.split(/\s+/)
    let marker: KnownHostEntry['marker']
    if (fields[0] === '@cert-authority') marker = 'cert-authority'
    else if (fields[0] === '@revoked') marker = 'revoked'
    if (marker) fields.shift()

    const [hosts, keyType, key] = fields
    if (!hosts || !keyType || !key) continue

    const entry: KnownHostEntry = { patterns: [], keyType, key, ...(marker ? { marker } : {}) }
    if (hosts.startsWith('|1|')) {
      const [, , salt, hash] = hosts.split('|')
      if (!salt || !hash) continue
      entry.hashed = { salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') }
    } else {
      entry.patterns = hosts.split(',')
    }
    entries.push(entry)
  }
  return entries
}

/** How OpenSSH writes a host in known_hosts: bare for port 22, `[host]:port` otherwise. */
export function hostToken(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

/** Glob match with `*` and `?`, case-insensitive like host names. */
function globMatch(pattern: string, text: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .toLowerCase()
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$'
  )
  return re.test(text.toLowerCase())
}

function entryMatchesHost(entry: KnownHostEntry, token: string): boolean {
  if (entry.hashed) {
    const digest = createHmac('sha1', entry.hashed.salt).update(token).digest()
    return digest.length === entry.hashed.hash.length && digest.equals(entry.hashed.hash)
  }
  let matched = false
  for (const pattern of entry.patterns) {
    if (pattern.startsWith('!')) {
      if (globMatch(pattern.slice(1), token)) return false // negation wins over any positive match
    } else if (globMatch(pattern, token)) {
      matched = true
    }
  }
  return matched
}

export function verifyHostKey(
  entries: readonly KnownHostEntry[],
  host: string,
  port: number,
  keyType: string,
  keyBase64: string
): HostKeyVerdict {
  const token = hostToken(host, port)
  // CA-signed hosts are not supported yet, so those lines say nothing about plain keys.
  const relevant = entries.filter(
    (e) => e.marker !== 'cert-authority' && entryMatchesHost(e, token)
  )

  const same = (e: KnownHostEntry): boolean => e.keyType === keyType && e.key === keyBase64
  if (relevant.some((e) => e.marker === 'revoked' && same(e))) return 'revoked'

  const live = relevant.filter((e) => e.marker !== 'revoked')
  if (live.some(same)) return 'trusted'
  return live.length > 0 ? 'changed' : 'unknown'
}

/** SSH key types we have on file for this host, in file order; used to steer algorithm choice. */
export function knownKeyTypes(
  entries: readonly KnownHostEntry[],
  host: string,
  port: number
): string[] {
  const token = hostToken(host, port)
  const types = entries
    .filter(
      (e) => e.marker !== 'cert-authority' && e.marker !== 'revoked' && entryMatchesHost(e, token)
    )
    .map((e) => e.keyType)
  return [...new Set(types)]
}

/** Key type and `SHA256:` fingerprint of a wire-format public key blob. */
export function describeKey(blob: Buffer): {
  keyType: string
  keyBase64: string
  fingerprint: string
} {
  const length = blob.readUInt32BE(0)
  const keyType = blob.subarray(4, 4 + length).toString('ascii')
  const fingerprint =
    'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
  return { keyType, keyBase64: blob.toString('base64'), fingerprint }
}

/** Host key algorithms ssh2 can negotiate. Offering anything else makes it throw. */
export const SUPPORTED_HOST_KEY_ALGORITHMS = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa'
] as const
export type HostKeyAlgorithm = (typeof SUPPORTED_HOST_KEY_ALGORITHMS)[number]

/**
 * Algorithms to ask for first, given the key types on file for a host, so the server presents a
 * key we can actually compare (an RSA entry means `rsa-sha2-*` signatures, as in OpenSSH).
 */
export function preferredAlgorithms(keyTypes: readonly string[]): HostKeyAlgorithm[] {
  const wanted = keyTypes.flatMap((t) =>
    t === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [t]
  )
  return SUPPORTED_HOST_KEY_ALGORITHMS.filter((a) => wanted.includes(a))
}

export class KnownHostsFile {
  constructor(readonly path: string) {}

  async load(): Promise<KnownHostEntry[]> {
    try {
      return parseKnownHosts(await readFile(this.path, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  /** Append a trusted key the way `ssh` would (plain host name, private file permissions). */
  async add(host: string, port: number, keyType: string, keyBase64: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    let prefix = ''
    try {
      const existing = await readFile(this.path, 'utf8')
      if (existing !== '' && !existing.endsWith('\n')) prefix = '\n'
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    await appendFile(this.path, `${prefix}${hostToken(host, port)} ${keyType} ${keyBase64}\n`, {
      mode: 0o600
    })
    await chmod(this.path, 0o600).catch(() => {})
  }
}
