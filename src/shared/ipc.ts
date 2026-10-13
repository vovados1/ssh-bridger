import { z } from 'zod'

/**
 * Single source of truth for the renderer <-> main boundary.
 * Every channel declares a request and a response schema. Main validates requests
 * (the renderer is untrusted); the preload and renderer derive their types from here.
 */
export const ipcContract = {
  'fs:home': {
    request: z.undefined(),
    response: z.string()
  }
} as const

export type IpcContract = typeof ipcContract
export type IpcChannel = keyof IpcContract
export type IpcRequest<C extends IpcChannel> = z.input<IpcContract[C]['request']>
export type IpcResponse<C extends IpcChannel> = z.output<IpcContract[C]['response']>

/** The API the preload script exposes on `window.api`. */
export interface BridgerApi {
  fs: {
    home(): Promise<IpcResponse<'fs:home'>>
  }
}
