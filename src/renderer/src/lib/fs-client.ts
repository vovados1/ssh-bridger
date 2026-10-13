import { FsError, type Entry, type EntryDetails, type MachineId } from '@shared/fs-types'
import type { IpcResult } from '@shared/ipc'

/** What the renderer needs from main. Faked in tests, backed by the preload bridge at runtime. */
export interface FsClient {
  home(machineId: MachineId): Promise<string>
  realpath(machineId: MachineId, path: string): Promise<string>
  stat(machineId: MachineId, path: string): Promise<Entry>
  list(machineId: MachineId, path: string): Promise<Entry[]>
  details(machineId: MachineId, path: string): Promise<EntryDetails>
  mkdir(machineId: MachineId, path: string): Promise<void>
  createFile(machineId: MachineId, path: string): Promise<void>
  /** Fails with EEXIST rather than overwriting `to`. */
  rename(machineId: MachineId, from: string, to: string): Promise<void>
  remove(
    machineId: MachineId,
    path: string,
    options: { recursive: boolean; toTrash: boolean }
  ): Promise<void>
  chmod(machineId: MachineId, path: string, mode: number): Promise<void>
  /** Watch a folder; `key` identifies the column. False if the machine can't watch. */
  watch(machineId: MachineId, path: string, key: string): Promise<boolean>
  unwatch(key: string): Promise<void>
  /** Called with the key of every watch whose folder changed. Returns an unsubscribe function. */
  onChanged(listener: (key: string) => void): () => void
}

/** Turn a bridge result back into a value, or throw the FsError it carries. */
export async function unwrap<T>(result: Promise<IpcResult<T>>): Promise<T> {
  const r = await result
  if (r.ok) return r.value
  throw new FsError(r.error)
}
