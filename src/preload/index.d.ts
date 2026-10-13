import type { BridgerApi } from '@shared/ipc'

declare global {
  interface Window {
    api: BridgerApi
  }
}
