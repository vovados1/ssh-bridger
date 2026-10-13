import { unwrap, type FsClient } from './fs-client'
import type { ConnectionsClient } from './connections-client'

/** The real FsClient, backed by the preload bridge. Renderer code should not touch `window.api`. */
export const fsClient: FsClient = {
  home: (machineId) => unwrap(window.api.fs.home({ machineId })),
  realpath: (machineId, path) => unwrap(window.api.fs.realpath({ machineId, path })),
  stat: (machineId, path) => unwrap(window.api.fs.stat({ machineId, path })),
  list: (machineId, path) => unwrap(window.api.fs.list({ machineId, path })),
  details: (machineId, path) => unwrap(window.api.fs.details({ machineId, path })),
  mkdir: (machineId, path) => unwrap(window.api.fs.mkdir({ machineId, path })),
  createFile: (machineId, path) => unwrap(window.api.fs.createFile({ machineId, path })),
  rename: (machineId, from, to) => unwrap(window.api.fs.rename({ machineId, from, to })),
  remove: (machineId, path, { recursive, toTrash }) =>
    unwrap(window.api.fs.remove({ machineId, path, recursive, toTrash })),
  chmod: (machineId, path, mode) => unwrap(window.api.fs.chmod({ machineId, path, mode })),
  watch: (machineId, path, key) => unwrap(window.api.fs.watch({ machineId, path, key })),
  unwatch: (key) => unwrap(window.api.fs.unwatch({ key })),
  onChanged: (listener) => window.api.events.on('fs:changed', (e) => listener(e.key))
}

/** Copy text to the system clipboard (via main; the web clipboard API needs window focus). */
export const copyText = (text: string): Promise<void> => unwrap(window.api.app.copyText({ text }))

export const connectionsClient: ConnectionsClient = {
  listProfiles: () => unwrap(window.api.profiles.list()),
  saveProfile: (input) => unwrap(window.api.profiles.save(input)),
  deleteProfile: (id) => unwrap(window.api.profiles.delete({ id })),
  listSshConfig: () => unwrap(window.api.sshConfig.list()),
  importSshConfig: (aliases) => unwrap(window.api.sshConfig.import({ aliases })),
  connect: (profileId) => unwrap(window.api.conn.connect({ profileId })),
  disconnect: (profileId) => unwrap(window.api.conn.disconnect({ profileId })),
  states: () => unwrap(window.api.conn.states()),
  respond: (id, response) => unwrap(window.api.conn.respond({ id, response })),
  capabilities: () => unwrap(window.api.app.capabilities()),
  pickFile: (title, startIn) =>
    unwrap(window.api.app.pickFile({ title, ...(startIn ? { startIn } : {}) })),
  onState: (listener) => window.api.events.on('conn:state', listener),
  onPrompt: (listener) => window.api.events.on('conn:prompt', listener),
  onPromptCancel: (listener) => window.api.events.on('conn:promptCancel', (e) => listener(e.id))
}
