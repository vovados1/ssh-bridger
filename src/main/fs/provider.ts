import type { Readable, Writable } from 'node:stream'
import type { Entry, EntryDetails, MachineId } from '@shared/fs-types'

export interface RenameOptions {
  overwrite?: boolean
}

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
  /**
   * Move or rename within the machine. Refuses to replace an existing `to` (EEXIST) unless
   * `overwrite` is set, which atomically replaces a file where the machine allows it.
   */
  rename(from: string, to: string, options?: RenameOptions): Promise<void>
  /** Never follows symlinks; deleting a link removes only the link. */
  remove(path: string, options: RemoveOptions): Promise<void>
  /** `mode` is permission bits including setuid/setgid/sticky (0..0o7777). */
  chmod(path: string, mode: number): Promise<void>

  /** Open a file for reading from byte `start`. Rejects if it can't be opened. */
  openRead(path: string, options?: { start?: number }): Promise<Readable>
  /**
   * Open a file for writing from the start (truncating). `exclusive` fails with EEXIST if the
   * path is taken. `mode` applies when the file is created.
   */
  openWrite(path: string, options?: { mode?: number; exclusive?: boolean }): Promise<Writable>
  /** Set the modification time (ms since epoch) and leave the access time alone where possible. */
  setTimes(path: string, mtimeMs: number): Promise<void>
  /** Create a symbolic link at `path` pointing to `target` (stored as given). */
  symlink(target: string, path: string): Promise<void>

  /**
   * Call `onChange` (possibly often) when the contents of `dir` change; returns a stopper.
   * Absent when the machine can't report changes (SFTP); callers fall back to manual refresh.
   * Throws if the watch can't be established.
   */
  watch?(dir: string, onChange: () => void): () => void
}
