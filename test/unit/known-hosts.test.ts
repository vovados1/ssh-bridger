import { createHmac } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  KnownHostsFile,
  describeKey,
  hostToken,
  knownKeyTypes,
  parseKnownHosts,
  preferredAlgorithms,
  verifyHostKey
} from '../../src/main/ssh/known-hosts'

const KEY_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const KEY_B = 'AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const RSA = 'AAAAB3NzaC1yc2EAAAADAQABAAABAQC7'

/** Build a hashed entry the way ssh-keygen -H does. */
function hashed(
  token: string,
  type: string,
  key: string,
  salt = Buffer.from('0123456789abcdefghij')
): string {
  const hash = createHmac('sha1', salt).update(token).digest()
  return `|1|${salt.toString('base64')}|${hash.toString('base64')} ${type} ${key}`
}

describe('parseKnownHosts', () => {
  it('reads plain, marker, hashed and comma-separated lines and skips junk', () => {
    const entries = parseKnownHosts(
      [
        '# comment',
        '',
        `example.com ssh-ed25519 ${KEY_A} trailing comment`,
        `a.example.com,10.0.0.1 ssh-rsa ${RSA}`,
        `@revoked bad.example.com ssh-ed25519 ${KEY_B}`,
        `@cert-authority *.corp ssh-ed25519 ${KEY_A}`,
        hashed('h.example.com', 'ssh-ed25519', KEY_A),
        'garbage',
        'only two'
      ].join('\n')
    )
    expect(entries).toHaveLength(5)
    expect(entries[1]!.patterns).toEqual(['a.example.com', '10.0.0.1'])
    expect(entries[2]!.marker).toBe('revoked')
    expect(entries[3]!.marker).toBe('cert-authority')
    expect(entries[4]!.hashed).toBeDefined()
  })
})

describe('hostToken', () => {
  it('brackets non-default ports like OpenSSH', () => {
    expect(hostToken('h', 22)).toBe('h')
    expect(hostToken('h', 2222)).toBe('[h]:2222')
  })
})

describe('verifyHostKey', () => {
  const verify = (text: string, host: string, port: number, type = 'ssh-ed25519', key = KEY_A) =>
    verifyHostKey(parseKnownHosts(text), host, port, type, key)

  it('trusts an exact match and treats an empty file as unknown', () => {
    expect(verify(`h ssh-ed25519 ${KEY_A}`, 'h', 22)).toBe('trusted')
    expect(verify('', 'h', 22)).toBe('unknown')
    expect(verify(`other ssh-ed25519 ${KEY_A}`, 'h', 22)).toBe('unknown')
  })

  it('flags a different key for a known host as changed', () => {
    expect(verify(`h ssh-ed25519 ${KEY_B}`, 'h', 22)).toBe('changed')
  })

  it('also flags a known host presenting a different key type', () => {
    expect(verify(`h ssh-rsa ${RSA}`, 'h', 22)).toBe('changed')
  })

  it('trusts any one matching line when several keys are on file', () => {
    expect(verify(`h ssh-rsa ${RSA}\nh ssh-ed25519 ${KEY_A}`, 'h', 22)).toBe('trusted')
  })

  it('keys non-default ports separately', () => {
    const file = `[h]:2222 ssh-ed25519 ${KEY_A}`
    expect(verify(file, 'h', 2222)).toBe('trusted')
    expect(verify(file, 'h', 22)).toBe('unknown')
    expect(verify(`h ssh-ed25519 ${KEY_A}`, 'h', 2222)).toBe('unknown')
  })

  it('supports wildcards, case-insensitivity and negation', () => {
    expect(verify(`*.example.com ssh-ed25519 ${KEY_A}`, 'web.Example.com', 22)).toBe('trusted')
    expect(verify(`10.0.?.* ssh-ed25519 ${KEY_A}`, '10.0.1.55', 22)).toBe('trusted')
    expect(
      verify(`*.example.com,!bad.example.com ssh-ed25519 ${KEY_A}`, 'bad.example.com', 22)
    ).toBe('unknown')
    expect(
      verify(`*.example.com,!bad.example.com ssh-ed25519 ${KEY_A}`, 'ok.example.com', 22)
    ).toBe('trusted')
  })

  it('does not treat regex characters in patterns as wildcards', () => {
    expect(verify(`a.b ssh-ed25519 ${KEY_A}`, 'axb', 22)).toBe('unknown')
  })

  it('matches hashed entries, including with a port', () => {
    expect(verify(hashed('h.example.com', 'ssh-ed25519', KEY_A), 'h.example.com', 22)).toBe(
      'trusted'
    )
    expect(
      verify(hashed('[h.example.com]:2200', 'ssh-ed25519', KEY_A), 'h.example.com', 2200)
    ).toBe('trusted')
    expect(verify(hashed('h.example.com', 'ssh-ed25519', KEY_A), 'other.example.com', 22)).toBe(
      'unknown'
    )
    expect(verify(hashed('h.example.com', 'ssh-ed25519', KEY_B), 'h.example.com', 22)).toBe(
      'changed'
    )
  })

  it('refuses revoked keys but is unaffected by revocations of other keys', () => {
    expect(verify(`@revoked h ssh-ed25519 ${KEY_A}`, 'h', 22)).toBe('revoked')
    expect(verify(`@revoked h ssh-ed25519 ${KEY_A}\nh ssh-ed25519 ${KEY_A}`, 'h', 22)).toBe(
      'revoked'
    )
    expect(verify(`@revoked h ssh-ed25519 ${KEY_B}\nh ssh-ed25519 ${KEY_A}`, 'h', 22)).toBe(
      'trusted'
    )
  })

  it('ignores @cert-authority lines: they say nothing about plain keys', () => {
    expect(verify(`@cert-authority * ssh-ed25519 ${KEY_A}`, 'h', 22)).toBe('unknown')
  })
})

describe('knownKeyTypes / preferredAlgorithms', () => {
  it('lists distinct key types on file for a host', () => {
    const entries = parseKnownHosts(
      `h ssh-rsa ${RSA}\nh ssh-ed25519 ${KEY_A}\nh ssh-ed25519 ${KEY_B}\nz ssh-ecdsa ${KEY_A}`
    )
    expect(knownKeyTypes(entries, 'h', 22)).toEqual(['ssh-rsa', 'ssh-ed25519'])
  })

  it('maps types to negotiable algorithms, expanding RSA and dropping unsupported ones', () => {
    expect(preferredAlgorithms(['ssh-rsa'])).toEqual(['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'])
    expect(preferredAlgorithms(['sk-ssh-ed25519@openssh.com'])).toEqual([])
    expect(preferredAlgorithms(['ssh-ed25519'])).toEqual(['ssh-ed25519'])
  })
})

describe('describeKey', () => {
  it('derives type, base64 and an OpenSSH-style SHA256 fingerprint', () => {
    const blob = Buffer.from(KEY_A, 'base64')
    const d = describeKey(blob)
    expect(d.keyType).toBe('ssh-ed25519')
    expect(d.keyBase64).toBe(KEY_A)
    expect(d.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
  })
})

describe('KnownHostsFile', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bridger-kh-'))
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it('loads nothing from a missing file and creates it privately on first add', async () => {
    const file = new KnownHostsFile(join(dir, 'fresh', '.ssh', 'known_hosts'))
    expect(await file.load()).toEqual([])
    await file.add('example.com', 22, 'ssh-ed25519', KEY_A)
    expect((await stat(file.path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'fresh', '.ssh'))).mode & 0o777).toBe(0o700)
    expect(await readFile(file.path, 'utf8')).toBe(`example.com ssh-ed25519 ${KEY_A}\n`)
  })

  it('appends in OpenSSH format, round-trips through verify, and mends a missing final newline', async () => {
    const path = join(dir, 'known_hosts')
    await writeFile(path, `old ssh-ed25519 ${KEY_B}`) // no trailing newline
    const file = new KnownHostsFile(path)
    await file.add('h.example.com', 2222, 'ssh-ed25519', KEY_A)
    const text = await readFile(path, 'utf8')
    expect(text).toBe(`old ssh-ed25519 ${KEY_B}\n[h.example.com]:2222 ssh-ed25519 ${KEY_A}\n`)
    const entries = await file.load()
    expect(verifyHostKey(entries, 'h.example.com', 2222, 'ssh-ed25519', KEY_A)).toBe('trusted')
    expect(verifyHostKey(entries, 'old', 22, 'ssh-ed25519', KEY_B)).toBe('trusted')
  })
})
