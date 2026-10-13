import { readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  safeStorage,
  shell,
  type WebContents
} from 'electron'
import type { IpcEvents } from '@shared/ipc'
import { createRegistry } from '../fs/registry'
import { ConnectionManager } from '../ssh/connection-manager'
import { importAliases } from '../ssh/import'
import { KnownHostsFile } from '../ssh/known-hosts'
import { PromptBroker } from '../ssh/prompter'
import { listCandidates } from '../ssh/ssh-config'
import { LayoutStore } from '../store/layout-store'
import { ProfileStore } from '../store/profile-store'
import { SecretStore, type Cipher } from '../store/secret-store'
import { TransferManager } from '../transfer/transfer-manager'
import { handle } from './register'
import { WatchManager } from './watches'

/** Electron's keyring wrapper. On Linux without a keyring it silently falls back to a plaintext store; refuse that. */
const keyringCipher: Cipher = {
  isAvailable: () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' ||
      !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (data) => safeStorage.decryptString(data)
}

function broadcast<E extends keyof IpcEvents>(event: E, payload: IpcEvents[E]): boolean {
  const windows = BrowserWindow.getAllWindows()
  for (const w of windows) w.webContents.send(event, payload)
  return windows.length > 0
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Wire up every IPC channel. Resolves to a function that tears connections down at quit. */
export async function registerIpcHandlers(): Promise<() => Promise<void>> {
  const machines = createRegistry({ trash: (path) => shell.trashItem(path) })
  const watches = new WatchManager(machines)
  const tracked = new Set<number>()

  const dataDir = app.getPath('userData')
  const profiles = new ProfileStore(join(dataDir, 'profiles.json'))
  const secrets = new SecretStore(join(dataDir, 'secrets.json'), keyringCipher)
  await Promise.all([profiles.load(), secrets.load()])

  const sshDir = join(homedir(), '.ssh')
  const sshConfigPath = join(sshDir, 'config')
  const prompts = new PromptBroker(
    (request) => broadcast('conn:prompt', request),
    (id) => void broadcast('conn:promptCancel', { id })
  )
  const connections = new ConnectionManager({
    profiles,
    secrets,
    prompter: prompts,
    knownHosts: new KnownHostsFile(join(sshDir, 'known_hosts')),
    registry: machines,
    readSshConfig: () => readIfExists(sshConfigPath),
    agentSocket: process.env['SSH_AUTH_SOCK'],
    localUsername: userInfo().username,
    homeDir: homedir(),
    onState: (state) => void broadcast('conn:state', state)
  })

  const layout = new LayoutStore(join(dataDir, 'layout.json'))
  const transfers = new TransferManager({
    machines: machines,
    emitUpdate: (jobs) => void broadcast('transfer:update', { jobs }),
    emitConflict: (prompt) => void broadcast('transfer:conflict', prompt),
    emitConflictCancel: (id) => void broadcast('transfer:conflictCancel', { id })
  })

  /** Clean up a window's watches once, when it goes away. */
  const trackOwner = (sender: WebContents): void => {
    if (tracked.has(sender.id)) return
    tracked.add(sender.id)
    sender.once('destroyed', () => {
      watches.dropOwner(sender.id)
      tracked.delete(sender.id)
    })
  }

  // ---- filesystem ----
  handle('fs:home', ({ machineId }) => machines.get(machineId).home())
  handle('fs:realpath', ({ machineId, path }) => machines.get(machineId).realpath(path))
  handle('fs:stat', ({ machineId, path }) => machines.get(machineId).stat(path))
  handle('fs:list', ({ machineId, path }) => machines.get(machineId).list(path))
  handle('fs:details', ({ machineId, path }) => machines.get(machineId).details(path))
  handle('fs:mkdir', ({ machineId, path }) => machines.get(machineId).mkdir(path))
  handle('fs:createFile', ({ machineId, path }) => machines.get(machineId).createFile(path))
  handle('fs:rename', ({ machineId, from, to }) => machines.get(machineId).rename(from, to))
  handle('fs:remove', ({ machineId, path, recursive, toTrash }) =>
    machines.get(machineId).remove(path, { recursive, toTrash })
  )
  handle('fs:chmod', ({ machineId, path, mode }) => machines.get(machineId).chmod(path, mode))

  handle('fs:watch', ({ machineId, path, key }, event) => {
    const sender = event.sender
    trackOwner(sender)
    return watches.watch(sender.id, key, machineId, path, () => {
      if (!sender.isDestroyed()) sender.send('fs:changed', { key })
    })
  })
  handle('fs:unwatch', ({ key }, event) => watches.unwatch(event.sender.id, key))

  // ---- app ----
  handle('app:copyText', ({ text }) => clipboard.writeText(text))
  handle('app:capabilities', () => ({ secureStorage: secrets.available }))
  handle('app:pickFile', async ({ title, startIn }, event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title,
      defaultPath: startIn ?? sshDir,
      properties: ['openFile' as const, 'showHiddenFiles' as const]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // ---- saved connections ----
  handle('profiles:list', () => profiles.list())
  handle('profiles:save', (input) => profiles.save(input))
  handle('profiles:delete', async ({ id }) => {
    await profiles.delete(id) // refuses while it is somebody's jump host
    await connections.disconnect(id)
    await secrets.deleteProfile(id)
  })
  handle('sshconfig:list', async () => {
    const text = await readIfExists(sshConfigPath)
    const imported = new Set(profiles.list().flatMap((p) => (p.sshAlias ? [p.sshAlias] : [])))
    return text === null ? [] : listCandidates(text, imported, homedir())
  })
  handle('sshconfig:import', async ({ aliases }) => {
    const text = await readIfExists(sshConfigPath)
    return text === null ? [] : importAliases(profiles, text, aliases, homedir())
  })

  // ---- connections ----
  handle('conn:connect', ({ profileId }) => connections.connect(profileId))
  handle('conn:disconnect', ({ profileId }) => connections.disconnect(profileId))
  handle('conn:states', () => connections.states())
  handle('conn:respond', ({ id, response }) => prompts.respond(id, response))

  // ---- transfers ----
  handle('transfer:start', async (request) => ({ jobId: await transfers.start(request) }))
  handle('transfer:cancel', ({ jobId }) => transfers.cancel(jobId))
  handle('transfer:resolve', ({ conflictId, resolution, applyToAll }) =>
    transfers.resolveConflict(conflictId, { resolution, applyToAll })
  )
  handle('transfer:retry', async ({ jobId }) => ({ jobId: await transfers.retry(jobId) }))
  handle('transfer:clear', ({ jobId }) => transfers.clear(jobId))
  handle('transfer:list', () => transfers.list())

  // ---- layout ----
  handle('layout:load', () => layout.load())
  handle('layout:save', (value) => layout.save(value))

  return async () => {
    transfers.shutdown()
    await connections.shutdown()
  }
}
