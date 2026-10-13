import { createRegistry } from '../fs/registry'
import { handle } from './register'

export function registerIpcHandlers(): void {
  const machines = createRegistry()

  handle('fs:home', ({ machineId }) => machines.get(machineId).home())
  handle('fs:realpath', ({ machineId, path }) => machines.get(machineId).realpath(path))
  handle('fs:stat', ({ machineId, path }) => machines.get(machineId).stat(path))
  handle('fs:list', ({ machineId, path }) => machines.get(machineId).list(path))
}
