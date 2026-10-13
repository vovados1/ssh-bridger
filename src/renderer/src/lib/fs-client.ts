import { FsError, type Entry, type MachineId } from '@shared/fs-types'
import type { IpcResult } from '@shared/ipc'

/** What the renderer needs from main. Faked in tests, backed by the preload bridge at runtime. */
export interface FsClient {
  home(machineId: MachineId): Promise<string>
  realpath(machineId: MachineId, path: string): Promise<string>
  stat(machineId: MachineId, path: string): Promise<Entry>
  list(machineId: MachineId, path: string): Promise<Entry[]>
}

/** Turn a bridge result back into a value, or throw the FsError it carries. */
export async function unwrap<T>(result: Promise<IpcResult<T>>): Promise<T> {
  const r = await result
  if (r.ok) return r.value
  throw new FsError(r.error)
}
