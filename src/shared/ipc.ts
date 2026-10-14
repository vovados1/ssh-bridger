import { z } from 'zod'
import {
  AbsPathSchema,
  EntryDetailsSchema,
  EntrySchema,
  MachineIdSchema,
  ModeSchema
} from './fs-schemas'
import {
  ConnectionProfileInputSchema,
  ConnectionProfileSchema,
  ConnectionStateSchema,
  PromptResponseSchema,
  SshConfigCandidateSchema
} from './connection-schemas'
import type { ConnectionState, PromptRequest } from './connections'
import {
  ConflictAnswerSchema,
  JobSnapshotSchema,
  LayoutSchema,
  TransferRequestSchema
} from './transfer-schemas'
import type { ConflictPrompt, JobSnapshot } from './transfers'
import { SettingsSchema } from './settings-schemas'
import type { Settings } from './settings'
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
  'app:copyText': { request: z.object({ text: z.string().max(1_000_000) }), response: done },
  'app:capabilities': {
    request: z.void(),
    /** `secureStorage`: the OS keyring is usable, so passwords may be remembered. */
    response: z.object({ secureStorage: z.boolean() })
  },
  /** Native file picker for choosing a private key. Null when cancelled. */
  'app:pickFile': {
    request: z.object({ title: z.string().max(200), startIn: z.string().max(4096).optional() }),
    response: z.string().nullable()
  },

  'profiles:list': { request: z.void(), response: z.array(ConnectionProfileSchema) },
  'profiles:save': { request: ConnectionProfileInputSchema, response: ConnectionProfileSchema },
  /** Refused while another profile uses this one as its jump host. */
  'profiles:delete': { request: z.object({ id: z.string().min(1) }), response: done },
  'sshconfig:list': { request: z.void(), response: z.array(SshConfigCandidateSchema) },
  'sshconfig:import': {
    request: z.object({ aliases: z.array(z.string().min(1).max(255)).min(1).max(500) }),
    response: z.array(ConnectionProfileSchema)
  },

  /** Start copying or moving files. Resolves once the job is queued; progress arrives as events. */
  'transfer:start': { request: TransferRequestSchema, response: z.object({ jobId: z.string() }) },
  'transfer:cancel': { request: z.object({ jobId: z.string().min(1) }), response: done },
  /** Answer a `transfer:conflict` question. */
  'transfer:resolve': {
    request: ConflictAnswerSchema.extend({ conflictId: z.string().min(1) }),
    response: done
  },
  /** Run a finished job again, skipping what is already up to date. */
  'transfer:retry': {
    request: z.object({ jobId: z.string().min(1) }),
    response: z.object({ jobId: z.string() })
  },
  /** Forget finished jobs; all of them when no id is given. */
  'transfer:clear': { request: z.object({ jobId: z.string().min(1).optional() }), response: done },
  'transfer:list': { request: z.void(), response: z.array(JobSnapshotSchema) },

  'layout:load': { request: z.void(), response: LayoutSchema.nullable() },
  'layout:save': { request: LayoutSchema, response: done },

  'settings:load': { request: z.void(), response: SettingsSchema },
  /** Applies at once; resolves to what was stored (bad values are replaced by defaults). */
  'settings:save': { request: SettingsSchema, response: SettingsSchema },

  /** Resolves once connected; rejects with EAUTH / ECONNECT / EHOSTKEY / ECANCELLED otherwise. */
  'conn:connect': { request: z.object({ profileId: z.string().min(1) }), response: done },
  'conn:disconnect': { request: z.object({ profileId: z.string().min(1) }), response: done },
  'conn:states': { request: z.void(), response: z.array(ConnectionStateSchema) },
  /** Answer a prompt raised by `conn:prompt`; null means the user cancelled. */
  'conn:respond': {
    request: z.object({ id: z.string().min(1), response: PromptResponseSchema.nullable() }),
    response: done
  }
} as const

/** Messages main pushes to the renderer. */
export interface IpcEvents {
  /** The watched folder for `key` changed on disk. */
  'fs:changed': { key: string }
  'conn:state': ConnectionState
  'conn:prompt': PromptRequest
  /** A prompt is no longer needed (the connection attempt ended). */
  'conn:promptCancel': { id: string }
  /** Jobs whose progress or state changed (batched, at most every 100 ms). */
  'transfer:update': { jobs: JobSnapshot[] }
  'transfer:conflict': ConflictPrompt
  /** A conflict question is moot (job cancelled, or answered for all). */
  'transfer:conflictCancel': { id: string }
  'settings:changed': Settings
}

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
    capabilities: Call<'app:capabilities'>
    pickFile: Call<'app:pickFile'>
    /** Real paths of files dropped from the desktop. Resolved in the preload; never sent over IPC. */
    pathsForFiles(files: File[]): string[]
  }
  profiles: {
    list: Call<'profiles:list'>
    save: Call<'profiles:save'>
    delete: Call<'profiles:delete'>
  }
  sshConfig: {
    list: Call<'sshconfig:list'>
    import: Call<'sshconfig:import'>
  }
  conn: {
    connect: Call<'conn:connect'>
    disconnect: Call<'conn:disconnect'>
    states: Call<'conn:states'>
    respond: Call<'conn:respond'>
  }
  transfer: {
    start: Call<'transfer:start'>
    cancel: Call<'transfer:cancel'>
    resolve: Call<'transfer:resolve'>
    retry: Call<'transfer:retry'>
    clear: Call<'transfer:clear'>
    list: Call<'transfer:list'>
  }
  layout: {
    load: Call<'layout:load'>
    save: Call<'layout:save'>
  }
  settings: {
    load: Call<'settings:load'>
    save: Call<'settings:save'>
  }
  events: {
    /** Subscribe to a main-to-renderer message. Returns an unsubscribe function. */
    on<E extends keyof IpcEvents>(event: E, listener: (payload: IpcEvents[E]) => void): () => void
  }
}
