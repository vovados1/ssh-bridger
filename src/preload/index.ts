import { contextBridge, ipcRenderer } from 'electron'
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
    list: (req) => invoke('fs:list', req)
  }
}

contextBridge.exposeInMainWorld('api', api)
