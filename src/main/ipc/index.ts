import { homedir } from 'node:os'
import { handle } from './register'

export function registerIpcHandlers(): void {
  handle('fs:home', () => homedir())
}
