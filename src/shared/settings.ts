export type ThemeChoice = 'system' | 'light' | 'dark'

/** User preferences, saved by main and applied live. */
export interface Settings {
  theme: ThemeChoice
  transfers: {
    /** Files copied at once within one transfer. Applies to transfers started afterwards. */
    filesPerTransfer: number
    /** Files copied at once across all transfers. */
    totalFiles: number
    /** Transfers running at once; the rest wait in the queue. */
    parallelTransfers: number
    /** Keep permissions and modification times on copies. */
    preserveAttributes: boolean
  }
  /** Seconds between refreshes of SSH folders (they can't push changes). 0 turns it off. */
  remotePollSeconds: number
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  transfers: { filesPerTransfer: 3, totalFiles: 6, parallelTransfers: 2, preserveAttributes: true },
  remotePollSeconds: 10
}

export const SETTING_LIMITS = {
  filesPerTransfer: { min: 1, max: 16 },
  totalFiles: { min: 1, max: 32 },
  parallelTransfers: { min: 1, max: 8 },
  remotePollSeconds: { min: 0, max: 600 }
} as const
