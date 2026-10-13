import type { Entry, EntryDetails, MachineId } from '@shared/fs-types'

export interface RemoveOptions {
  /** Required to delete a non-empty folder. */
  recursive: boolean
  /** Move to the machine's Trash instead of deleting. Only the local machine has one. */
  toTrash: boolean
}

/**
 * One interface for every machine. The UI and the transfer engine only ever talk to this,
 * so local and SFTP behave the same.
 * Paths are absolute POSIX paths. Failures reject with `FsError`.
 */
export interface FileSystemProvider {
  readonly id: MachineId
  home(): Promise<string>
  realpath(path: string): Promise<string>
  /** Metadata of the entry itself (symlinks are not followed, but their target is described). */
  stat(path: string): Promise<Entry>
  /** `stat` plus owner, group and access times, for the Properties dialog. */
  details(path: string): Promise<EntryDetails>
  /** Unsorted children of a directory. Entries that vanish mid-listing are skipped. */
  list(dir: string): Promise<Entry[]>

  /** Create one folder; the parent must exist. EEXIST if the path is taken. */
  mkdir(path: string): Promise<void>
  /** Create an empty file. EEXIST if the path is taken. */
  createFile(path: string): Promise<void>
  /** Move or rename within the machine. Never overwrites: EEXIST if `to` exists. */
  rename(from: string, to: string): Promise<void>
  /** Never follows symlinks; deleting a link removes only the link. */
  remove(path: string, options: RemoveOptions): Promise<void>
  /** `mode` is permission bits including setuid/setgid/sticky (0..0o7777). */
  chmod(path: string, mode: number): Promise<void>

  /**
   * Call `onChange` (possibly often) when the contents of `dir` change; returns a stopper.
   * Absent when the machine can't report changes (SFTP); callers fall back to manual refresh.
   * Throws if the watch can't be established.
   */
  watch?(dir: string, onChange: () => void): () => void
}
