import { contextBridge, ipcRenderer } from 'electron'
import type { BridgerApi, IpcChannel, IpcRequest, IpcResponse } from '@shared/ipc'

function invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>> {
  return ipcRenderer.invoke(channel, request) as Promise<IpcResponse<C>>
}

const api: BridgerApi = {
  fs: {
    home: () => invoke('fs:home', undefined)
  }
}

contextBridge.exposeInMainWorld('api', api)
