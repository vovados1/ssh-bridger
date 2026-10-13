import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const SSHD = ['/usr/bin/sshd', '/usr/sbin/sshd'].find(existsSync)
const SFTP_SERVER = [
  '/usr/lib/ssh/sftp-server',
  '/usr/lib/openssh/sftp-server',
  '/usr/libexec/openssh/sftp-server'
].find(existsSync)

/** True when a real OpenSSH server can be started for tests. Suites skip themselves otherwise. */
export const sshdAvailable = SSHD !== undefined && SFTP_SERVER !== undefined

export interface TestSshd {
  host: '127.0.0.1'
  port: number
  dir: string
  /** Private key that is accepted by the server (no passphrase). */
  clientKey: string
  /** Same identity, encrypted with `PASSPHRASE`. */
  encryptedClientKey: string
  /** A key the server does not know. */
  strangerKey: string
  /** `ssh-ed25519 AAAA...` of the server's host key. */
  hostKeyLine: string
  hostKeyPath: string
  stop(): Promise<void>
  /** Restart the server (drops every connection) on the same port with the same keys. */
  restart(): Promise<void>
}

export const PASSPHRASE = 'correct horse'

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

async function waitForPort(port: number, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect(port, '127.0.0.1')
      s.once('connect', () => (s.destroy(), resolve(true)))
      s.once('error', () => resolve(false))
    })
    if (ok) return
    if (Date.now() > deadline) throw new Error(`sshd did not start on port ${port}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function keygen(path: string, passphrase = ''): Promise<void> {
  await run('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    passphrase,
    '-C',
    'bridger-test',
    '-f',
    path
  ])
}

/**
 * A throwaway OpenSSH server on a random port, running as the current user with key-only auth
 * and the SFTP subsystem. Because it runs as you on this machine, files a test creates in a
 * temp folder are visible through it, which is what the provider contract tests rely on.
 */
export async function startSshd(): Promise<TestSshd> {
  if (!SSHD || !SFTP_SERVER) throw new Error('sshd is not available')
  const dir = await mkdtemp(join(tmpdir(), 'bridger-sshd-'))
  const port = await freePort()

  const hostKeyPath = join(dir, 'host_ed25519')
  const clientKey = join(dir, 'client')
  const encryptedClientKey = join(dir, 'client_enc')
  const strangerKey = join(dir, 'stranger')
  await Promise.all([
    keygen(hostKeyPath),
    keygen(clientKey),
    keygen(strangerKey),
    keygen(encryptedClientKey, PASSPHRASE)
  ])
  // The encrypted key is the same user, so authorize both.
  const authorized = join(dir, 'authorized_keys')
  const pubs = await Promise.all([
    readFile(`${clientKey}.pub`, 'utf8'),
    readFile(`${encryptedClientKey}.pub`, 'utf8')
  ])
  await writeFile(authorized, pubs.join(''))
  await chmod(authorized, 0o600)

  const config = join(dir, 'sshd_config')
  await writeFile(
    config,
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${hostKeyPath}`,
      `AuthorizedKeysFile ${authorized}`,
      `PidFile ${join(dir, 'sshd.pid')}`,
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'PubkeyAuthentication yes',
      'UsePAM no',
      'StrictModes no',
      'AllowTcpForwarding yes',
      `Subsystem sftp ${SFTP_SERVER}`,
      'LogLevel ERROR'
    ].join('\n') + '\n'
  )

  let child: ChildProcess | undefined
  const start = async (): Promise<void> => {
    // sshd daemonizes its log path relative to /, so everything is absolute.
    child = spawn(SSHD, ['-D', '-f', config, '-E', join(dir, 'sshd.log')], { stdio: 'ignore' })
    await waitForPort(port)
  }
  const stopChild = async (): Promise<void> => {
    const c = child
    if (!c || c.exitCode !== null) return
    await new Promise<void>((resolve) => {
      c.once('exit', () => resolve())
      c.kill('SIGKILL')
    })
    child = undefined
  }
  await start()

  const hostPub = (await readFile(`${hostKeyPath}.pub`, 'utf8')).trim().split(' ')
  return {
    host: '127.0.0.1',
    port,
    dir,
    clientKey,
    encryptedClientKey,
    strangerKey,
    hostKeyLine: `${hostPub[0]} ${hostPub[1]}`,
    hostKeyPath,
    async stop() {
      await stopChild()
      await rm(dir, { recursive: true, force: true })
    },
    async restart() {
      await stopChild()
      await start()
    }
  }
}
