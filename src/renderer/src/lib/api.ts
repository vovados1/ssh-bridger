import { unwrap, type FsClient } from './fs-client'

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
  onChanged: (listener) => window.api.events.onFsChanged((e) => listener(e.key))
}

/** Copy text to the system clipboard (via main; the web clipboard API needs window focus). */
export const copyText = (text: string): Promise<void> => unwrap(window.api.app.copyText({ text }))
