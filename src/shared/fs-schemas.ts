import { z } from 'zod'
import type { Entry, EntryDetails, MachineId } from './fs-types'

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

export const EntryDetailsSchema = EntrySchema.extend({
  uid: z.number(),
  gid: z.number(),
  owner: z.string().optional(),
  group: z.string().optional(),
  atime: z.number(),
  ctime: z.number()
}) satisfies z.ZodType<EntryDetails>

/** Permission bits including setuid/setgid/sticky. */
export const ModeSchema = z.number().int().min(0).max(0o7777)
