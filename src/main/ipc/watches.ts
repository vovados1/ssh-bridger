import type { MachineId } from '@shared/fs-types'
import type { MachineRegistry } from '../fs/registry'
import { coalesce, type Coalescer } from '../fs/coalesce'

/** A burst of changes (a build, an extraction) becomes one refresh. */
const QUIET_MS = 150
const MAX_WAIT_MS = 1000

interface Watch {
  stop: () => void
  coalescer: Coalescer
}

/**
 * Folder watches, one per (window, key). Each column owns a key, so re-watching with the
 * same key replaces that column's previous watch and closing a column drops it.
 */
export class WatchManager {
  private readonly watches = new Map<string, Watch>()

  constructor(private readonly machines: MachineRegistry) {}

  /** Returns false when the machine can't report changes or the watch can't be set up. */
  watch(
    ownerId: number,
    key: string,
    machineId: MachineId,
    dir: string,
    onChange: () => void
  ): boolean {
    this.unwatch(ownerId, key)
    const provider = this.machines.get(machineId)
    if (!provider.watch) return false

    const coalescer = coalesce(onChange, QUIET_MS, MAX_WAIT_MS)
    try {
      const stop = provider.watch(dir, () => coalescer.trigger())
      this.watches.set(slot(ownerId, key), { stop, coalescer })
      return true
    } catch {
      return false // e.g. the folder vanished or the inotify limit was hit; manual refresh still works
    }
  }

  unwatch(ownerId: number, key: string): void {
    const id = slot(ownerId, key)
    const existing = this.watches.get(id)
    if (!existing) return
    existing.coalescer.cancel()
    existing.stop()
    this.watches.delete(id)
  }

  /** Drop everything a closed window had open. */
  dropOwner(ownerId: number): void {
    for (const id of [...this.watches.keys()]) {
      if (id.startsWith(`${ownerId}:`)) {
        const w = this.watches.get(id)!
        w.coalescer.cancel()
        w.stop()
        this.watches.delete(id)
      }
    }
  }

  get size(): number {
    return this.watches.size
  }
}

const slot = (ownerId: number, key: string): string => `${ownerId}:${key}`
