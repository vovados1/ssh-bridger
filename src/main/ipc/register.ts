import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  ipcContract,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcResult
} from '@shared/ipc'
import { toFsError } from '../fs/errors'

type Handler<C extends IpcChannel> = (
  request: IpcRequest<C>,
  event: IpcMainInvokeEvent
) => IpcResponse<C> | Promise<IpcResponse<C>>

/**
 * Only the app's own pages may call into main. In dev that is the Vite server,
 * in production the packaged file:// renderer.
 */
export function isTrustedUrl(url: string, devServerUrl: string | undefined): boolean {
  if (devServerUrl && url.startsWith(devServerUrl)) return true
  return url.startsWith('file://')
}

/** Validate a raw payload against the channel schema; throws on bad input. */
export function parseRequest<C extends IpcChannel>(channel: C, payload: unknown): IpcRequest<C> {
  return ipcContract[channel].request.parse(payload) as IpcRequest<C>
}

/**
 * Register a typed, validated handler for a contract channel.
 * Untrusted callers and malformed payloads throw (they are bugs or attacks);
 * failures inside the handler are returned as `{ ok: false }` data.
 */
export function handle<C extends IpcChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, async (event, payload: unknown): Promise<IpcResult<IpcResponse<C>>> => {
    const url = event.senderFrame?.url ?? ''
    if (!isTrustedUrl(url, process.env['ELECTRON_RENDERER_URL'])) {
      throw new Error(`Rejected IPC call on "${channel}" from untrusted origin`)
    }
    const request = parseRequest(channel, payload)
    try {
      const result = await handler(request, event)
      const value = ipcContract[channel].response.parse(result) as IpcResponse<C>
      return { ok: true, value }
    } catch (err) {
      return { ok: false, error: toFsError(err).toData() }
    }
  })
}
