import { z } from 'zod'
import type { Entry, MachineId } from './fs-types'

export const MachineIdSchema = z.custom<MachineId>(
  (v) => typeof v === 'string' && (v === 'local' || /^ssh:.+/.test(v)),
  'Invalid machine id'
)

/** Absolute POSIX path. Provider-level checks (existence, permissions) happen in main. */
export const AbsPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith('/') && !p.includes('\0'), 'Path must be absolute')

export const EntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['file', 'dir', 'symlink', 'other']),
  size: z.number(),
  mtime: z.number(),
  mode: z.number(),
  linkTarget: z.string().optional(),
  linkTargetType: z.enum(['file', 'dir', 'other', 'broken']).optional()
}) satisfies z.ZodType<Entry>
