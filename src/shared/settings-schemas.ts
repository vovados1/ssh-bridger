import { z } from 'zod'
import { DEFAULT_SETTINGS, SETTING_LIMITS as L, type Settings } from './settings'

const D = DEFAULT_SETTINGS
const int = (limits: { min: number; max: number }) =>
  z.number().int().min(limits.min).max(limits.max)

/**
 * Every field falls back to its default, so a settings file from an older or newer version,
 * or one with a single bad value, still loads.
 */
export const SettingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).catch(D.theme),
  transfers: z
    .object({
      filesPerTransfer: int(L.filesPerTransfer).catch(D.transfers.filesPerTransfer),
      totalFiles: int(L.totalFiles).catch(D.transfers.totalFiles),
      parallelTransfers: int(L.parallelTransfers).catch(D.transfers.parallelTransfers),
      preserveAttributes: z.boolean().catch(D.transfers.preserveAttributes)
    })
    .catch(D.transfers),
  remotePollSeconds: int(L.remotePollSeconds).catch(D.remotePollSeconds)
}) satisfies z.ZodType<Settings>
