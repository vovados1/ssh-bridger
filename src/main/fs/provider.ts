import type { Entry, MachineId } from '@shared/fs-types'

/**
 * One interface for every machine. The UI and the transfer engine only ever talk to this,
 * so local and SFTP behave the same. Mutating operations arrive in M2.
 * Paths are absolute POSIX paths. Failures reject with `FsError`.
 */
export interface FileSystemProvider {
  readonly id: MachineId
  home(): Promise<string>
  realpath(path: string): Promise<string>
  /** Metadata of the entry itself (symlinks are not followed, but their target is described). */
  stat(path: string): Promise<Entry>
  /** Unsorted children of a directory. Entries that vanish mid-listing are skipped. */
  list(dir: string): Promise<Entry[]>
}
