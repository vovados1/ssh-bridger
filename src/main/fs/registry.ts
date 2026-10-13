import { FsError, type MachineId } from '@shared/fs-types'
import { LocalProvider } from './local-provider'
import type { FileSystemProvider } from './provider'

/** Maps a machine id to its provider. SSH providers register here from M3. */
export class MachineRegistry {
  private readonly providers = new Map<MachineId, FileSystemProvider>()

  register(provider: FileSystemProvider): void {
    this.providers.set(provider.id, provider)
  }

  get(id: MachineId): FileSystemProvider {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new FsError({ code: 'EDISCONNECTED', message: `Machine "${id}" is not connected` })
    }
    return provider
  }
}

export function createRegistry(): MachineRegistry {
  const registry = new MachineRegistry()
  registry.register(new LocalProvider())
  return registry
}
