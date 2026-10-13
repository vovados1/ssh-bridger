import { z } from 'zod'
import {
  AbsPathSchema,
  EntryDetailsSchema,
  EntrySchema,
  MachineIdSchema,
  ModeSchema
} from './fs-schemas'
import type { FsErrorData } from './fs-types'

const onMachine = z.object({ machineId: MachineIdSchema })
const onPath = onMachine.extend({ path: AbsPathSchema })
const done = z.void()
/** Identifies one column's watch so a column can replace or drop its own. */
const WatchKeySchema = z.string().min(1).max(64)

/**
 * Single source of truth for the renderer <-> main boundary.
 * Every channel declares a request and a response schema. Main validates requests
 * (the renderer is untrusted); the preload and renderer derive their types from here.
 */
export const ipcContract = {
  'fs:home': { request: onMachine, response: AbsPathSchema },
  'fs:realpath': { request: onPath, response: AbsPathSchema },
  'fs:stat': { request: onPath, response: EntrySchema },
  'fs:list': { request: onPath, response: z.array(EntrySchema) },
  'fs:details': { request: onPath, response: EntryDetailsSchema },
  'fs:mkdir': { request: onPath, response: done },
  'fs:createFile': { request: onPath, response: done },
  /** Fails with EEXIST instead of overwriting `to`. */
  'fs:rename': {
    request: onMachine.extend({ from: AbsPathSchema, to: AbsPathSchema }),
    response: done
  },
  'fs:remove': {
    request: onPath.extend({ recursive: z.boolean(), toTrash: z.boolean() }),
    response: done
  },
  'fs:chmod': { request: onPath.extend({ mode: ModeSchema }), response: done },
  /** Start (or replace) this key's watch on a folder. Resolves to false when the machine can't watch. */
  'fs:watch': { request: onPath.extend({ key: WatchKeySchema }), response: z.boolean() },
  'fs:unwatch': { request: z.object({ key: WatchKeySchema }), response: done },
  /** Put text on the system clipboard. Done in main: the web clipboard API needs window focus. */
  'app:copyText': { request: z.object({ text: z.string().max(1_000_000) }), response: done }
} as const

/** Messages main pushes to the renderer. */
export const ipcEvents = {
  /** The watched folder for `key` changed on disk. */
  'fs:changed': z.object({ key: WatchKeySchema })
} as const
export type IpcEvents = { [E in keyof typeof ipcEvents]: z.output<(typeof ipcEvents)[E]> }

export type IpcContract = typeof ipcContract
export type IpcChannel = keyof IpcContract
export type IpcRequest<C extends IpcChannel> = z.input<IpcContract[C]['request']>
export type IpcResponse<C extends IpcChannel> = z.output<IpcContract[C]['response']>

/**
 * What crosses the bridge. Filesystem failures travel as data (`ok: false`) so their
 * `code` survives; Electron would otherwise flatten a thrown error to its message.
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: FsErrorData }

type Call<C extends IpcChannel> = (req: IpcRequest<C>) => Promise<IpcResult<IpcResponse<C>>>

/** The API the preload script exposes on `window.api`. */
export interface BridgerApi {
  fs: {
    home: Call<'fs:home'>
    realpath: Call<'fs:realpath'>
    stat: Call<'fs:stat'>
    list: Call<'fs:list'>
    details: Call<'fs:details'>
    mkdir: Call<'fs:mkdir'>
    createFile: Call<'fs:createFile'>
    rename: Call<'fs:rename'>
    remove: Call<'fs:remove'>
    chmod: Call<'fs:chmod'>
    watch: Call<'fs:watch'>
    unwatch: Call<'fs:unwatch'>
  }
  app: {
    copyText: Call<'app:copyText'>
  }
  events: {
    /** Subscribe to watched-folder changes. Returns an unsubscribe function. */
    onFsChanged(listener: (event: IpcEvents['fs:changed']) => void): () => void
  }
}
