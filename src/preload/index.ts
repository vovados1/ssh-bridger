import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { BridgerApi, IpcChannel, IpcRequest, IpcResponse, IpcResult } from '@shared/ipc'

function invoke<C extends IpcChannel>(
  channel: C,
  request: IpcRequest<C>
): Promise<IpcResult<IpcResponse<C>>> {
  return ipcRenderer.invoke(channel, request) as Promise<IpcResult<IpcResponse<C>>>
}

const api: BridgerApi = {
  fs: {
    home: (req) => invoke('fs:home', req),
    realpath: (req) => invoke('fs:realpath', req),
    stat: (req) => invoke('fs:stat', req),
    list: (req) => invoke('fs:list', req),
    details: (req) => invoke('fs:details', req),
    mkdir: (req) => invoke('fs:mkdir', req),
    createFile: (req) => invoke('fs:createFile', req),
    rename: (req) => invoke('fs:rename', req),
    remove: (req) => invoke('fs:remove', req),
    chmod: (req) => invoke('fs:chmod', req),
    watch: (req) => invoke('fs:watch', req),
    unwatch: (req) => invoke('fs:unwatch', req)
  },
  app: {
    copyText: (req) => invoke('app:copyText', req),
    capabilities: () => invoke('app:capabilities', undefined),
    pickFile: (req) => invoke('app:pickFile', req),
    pathsForFiles: (files) => files.map((f) => webUtils.getPathForFile(f)).filter((p) => p !== '')
  },
  transfer: {
    start: (req) => invoke('transfer:start', req),
    cancel: (req) => invoke('transfer:cancel', req),
    resolve: (req) => invoke('transfer:resolve', req),
    retry: (req) => invoke('transfer:retry', req),
    clear: (req) => invoke('transfer:clear', req),
    list: () => invoke('transfer:list', undefined)
  },
  layout: {
    load: () => invoke('layout:load', undefined),
    save: (req) => invoke('layout:save', req)
  },
  profiles: {
    list: () => invoke('profiles:list', undefined),
    save: (req) => invoke('profiles:save', req),
    delete: (req) => invoke('profiles:delete', req)
  },
  sshConfig: {
    list: () => invoke('sshconfig:list', undefined),
    import: (req) => invoke('sshconfig:import', req)
  },
  conn: {
    connect: (req) => invoke('conn:connect', req),
    disconnect: (req) => invoke('conn:disconnect', req),
    states: () => invoke('conn:states', undefined),
    respond: (req) => invoke('conn:respond', req)
  },
  events: {
    on(event, listener) {
      // Wrap so the renderer never receives Electron's IpcRendererEvent.
      const wrapped = (_event: IpcRendererEvent, payload: Parameters<typeof listener>[0]): void =>
        listener(payload)
      ipcRenderer.on(event, wrapped)
      return () => {
        ipcRenderer.removeListener(event, wrapped)
      }
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
