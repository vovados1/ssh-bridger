import { unwrap, type FsClient } from './fs-client'

/** The real FsClient, backed by the preload bridge. Renderer code should not touch `window.api`. */
export const fsClient: FsClient = {
  home: (machineId) => unwrap(window.api.fs.home({ machineId })),
  realpath: (machineId, path) => unwrap(window.api.fs.realpath({ machineId, path })),
  stat: (machineId, path) => unwrap(window.api.fs.stat({ machineId, path })),
  list: (machineId, path) => unwrap(window.api.fs.list({ machineId, path }))
}
