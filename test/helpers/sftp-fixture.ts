import { mkdtemp } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { sshMachineId } from '@shared/connections'
import type { MachineId } from '@shared/fs-types'
import type { FileSystemProvider } from '../../src/main/fs/provider'
import { MachineRegistry } from '../../src/main/fs/registry'
import { ConnectionManager } from '../../src/main/ssh/connection-manager'
import { KnownHostsFile } from '../../src/main/ssh/known-hosts'
import { silentPrompter } from '../../src/main/ssh/prompter'
import { ProfileStore } from '../../src/main/store/profile-store'
import { SecretStore } from '../../src/main/store/secret-store'
import type { TestSshd } from './sshd'

export interface SftpConnection {
  provider: FileSystemProvider
  machineId: MachineId
  teardown(): Promise<void>
  manager: ConnectionManager
  registry: MachineRegistry
}

/** Connect a real SftpProvider (key auth, host key pre-trusted) to a test server, directly or via a proxy port. */
export async function connectSftp(
  server: TestSshd,
  scratchRoot: string,
  port = server.port
): Promise<SftpConnection> {
  const dir = await mkdtemp(join(scratchRoot, 'sftp-'))
  const profiles = new ProfileStore(join(dir, 'profiles.json'))
  await profiles.load()
  const knownHosts = new KnownHostsFile(join(dir, 'known_hosts'))
  await knownHosts.add('127.0.0.1', port, 'ssh-ed25519', server.hostKeyLine.split(' ')[1]!)
  const registry = new MachineRegistry()
  const manager = new ConnectionManager({
    profiles,
    secrets: new SecretStore(join(dir, 'secrets.json'), {
      isAvailable: () => false,
      encrypt: () => Buffer.alloc(0),
      decrypt: () => ''
    }),
    prompter: silentPrompter,
    knownHosts,
    registry,
    readSshConfig: async () => null,
    agentSocket: undefined,
    localUsername: userInfo().username,
    homeDir: dir,
    onState: () => {},
    reconnectDelaysMs: [30, 60, 120]
  })
  const profile = await profiles.save({
    name: 'fixture',
    host: '127.0.0.1',
    port,
    username: userInfo().username,
    authMethods: ['publickey'],
    identityFile: server.clientKey
  })
  await manager.connect(profile.id)
  const machineId = sshMachineId(profile.id)
  return {
    provider: registry.get(machineId),
    machineId,
    teardown: () => manager.shutdown(),
    manager,
    registry
  }
}

/** A scratch folder that exists on this machine, for tests that use `tmpdir`. */
export const scratch = (prefix: string): Promise<string> => mkdtemp(join(tmpdir(), prefix))
