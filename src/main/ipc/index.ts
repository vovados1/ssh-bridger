import { clipboard, shell, type WebContents } from 'electron'
import { createRegistry } from '../fs/registry'
import { handle } from './register'
import { WatchManager } from './watches'

export function registerIpcHandlers(): void {
  const machines = createRegistry({ trash: (path) => shell.trashItem(path) })
  const watches = new WatchManager(machines)
  const tracked = new Set<number>()

  /** Clean up a window's watches once, when it goes away. */
  const trackOwner = (sender: WebContents): void => {
    if (tracked.has(sender.id)) return
    tracked.add(sender.id)
    sender.once('destroyed', () => {
      watches.dropOwner(sender.id)
      tracked.delete(sender.id)
    })
  }

  handle('fs:home', ({ machineId }) => machines.get(machineId).home())
  handle('fs:realpath', ({ machineId, path }) => machines.get(machineId).realpath(path))
  handle('fs:stat', ({ machineId, path }) => machines.get(machineId).stat(path))
  handle('fs:list', ({ machineId, path }) => machines.get(machineId).list(path))
  handle('fs:details', ({ machineId, path }) => machines.get(machineId).details(path))
  handle('fs:mkdir', ({ machineId, path }) => machines.get(machineId).mkdir(path))
  handle('fs:createFile', ({ machineId, path }) => machines.get(machineId).createFile(path))
  handle('fs:rename', ({ machineId, from, to }) => machines.get(machineId).rename(from, to))
  handle('fs:remove', ({ machineId, path, recursive, toTrash }) =>
    machines.get(machineId).remove(path, { recursive, toTrash })
  )
  handle('fs:chmod', ({ machineId, path, mode }) => machines.get(machineId).chmod(path, mode))

  handle('fs:watch', ({ machineId, path, key }, event) => {
    const sender = event.sender
    trackOwner(sender)
    return watches.watch(sender.id, key, machineId, path, () => {
      if (!sender.isDestroyed()) sender.send('fs:changed', { key })
    })
  })
  handle('fs:unwatch', ({ key }, event) => watches.unwatch(event.sender.id, key))

  handle('app:copyText', ({ text }) => clipboard.writeText(text))
}
