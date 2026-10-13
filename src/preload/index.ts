import { contextBridge, ipcRenderer } from 'electron'
import type {
  BridgerApi,
  IpcChannel,
  IpcEvents,
  IpcRequest,
  IpcResponse,
  IpcResult
} from '@shared/ipc'

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
    copyText: (req) => invoke('app:copyText', req)
  },
  events: {
    onFsChanged(listener) {
      // Wrap so the renderer never receives Electron's IpcRendererEvent.
      const wrapped = (_event: unknown, payload: IpcEvents['fs:changed']): void => listener(payload)
      ipcRenderer.on('fs:changed', wrapped)
      return () => {
        ipcRenderer.removeListener('fs:changed', wrapped)
      }
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
