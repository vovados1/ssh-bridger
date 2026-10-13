import { z } from 'zod'
import { AbsPathSchema, EntrySchema, MachineIdSchema } from './fs-schemas'
import type { FsErrorData } from './fs-types'

const onMachine = z.object({ machineId: MachineIdSchema })
const onPath = onMachine.extend({ path: AbsPathSchema })

/**
 * Single source of truth for the renderer <-> main boundary.
 * Every channel declares a request and a response schema. Main validates requests
 * (the renderer is untrusted); the preload and renderer derive their types from here.
 */
export const ipcContract = {
  'fs:home': { request: onMachine, response: AbsPathSchema },
  'fs:realpath': { request: onPath, response: AbsPathSchema },
  'fs:stat': { request: onPath, response: EntrySchema },
  'fs:list': { request: onPath, response: z.array(EntrySchema) }
} as const

export type IpcContract = typeof ipcContract
export type IpcChannel = keyof IpcContract
export type IpcRequest<C extends IpcChannel> = z.input<IpcContract[C]['request']>
export type IpcResponse<C extends IpcChannel> = z.output<IpcContract[C]['response']>

/**
 * What crosses the bridge. Filesystem failures travel as data (`ok: false`) so their
 * `code` survives; Electron would otherwise flatten a thrown error to its message.
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: FsErrorData }

/** The API the preload script exposes on `window.api`. */
export interface BridgerApi {
  fs: {
    home(req: IpcRequest<'fs:home'>): Promise<IpcResult<IpcResponse<'fs:home'>>>
    realpath(req: IpcRequest<'fs:realpath'>): Promise<IpcResult<IpcResponse<'fs:realpath'>>>
    stat(req: IpcRequest<'fs:stat'>): Promise<IpcResult<IpcResponse<'fs:stat'>>>
    list(req: IpcRequest<'fs:list'>): Promise<IpcResult<IpcResponse<'fs:list'>>>
  }
}
