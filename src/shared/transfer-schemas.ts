import { z } from 'zod'
import { AbsPathSchema, MachineIdSchema } from './fs-schemas'
import type { Layout } from './layout'
import type { ConflictAnswer, JobSnapshot, TransferRequest } from './transfers'

export const TransferRequestSchema = z.object({
  source: z.object({
    machineId: MachineIdSchema,
    paths: z.array(AbsPathSchema).min(1).max(5000)
  }),
  dest: z.object({ machineId: MachineIdSchema, dir: AbsPathSchema }),
  mode: z.enum(['copy', 'move'])
}) satisfies z.ZodType<TransferRequest>

export const ConflictAnswerSchema = z.object({
  resolution: z.enum(['overwrite', 'skip', 'keepBoth', 'overwriteIfNewer']),
  applyToAll: z.boolean()
}) satisfies z.ZodType<ConflictAnswer>

export const JobSnapshotSchema = z.object({
  id: z.string(),
  mode: z.enum(['copy', 'move']),
  status: z.enum(['queued', 'scanning', 'running', 'waiting', 'done', 'error', 'cancelled']),
  source: z.object({ machineId: MachineIdSchema, paths: z.array(z.string()) }),
  dest: z.object({ machineId: MachineIdSchema, dir: z.string() }),
  filesTotal: z.number(),
  filesDone: z.number(),
  bytesTotal: z.number(),
  bytesDone: z.number(),
  skipped: z.number(),
  speed: z.number(),
  etaSeconds: z.number().nullable(),
  current: z.array(z.string()),
  errors: z.array(z.object({ path: z.string(), message: z.string() })),
  errorCount: z.number(),
  startedAt: z.number(),
  finishedAt: z.number().optional()
}) satisfies z.ZodType<JobSnapshot>

const LayoutColumnSchema = z.object({
  id: z.string().min(1).max(64),
  machineId: MachineIdSchema,
  profileId: z.string().max(64).optional(),
  cwd: AbsPathSchema.optional(),
  width: z.number().min(100).max(10_000).optional(),
  showHidden: z.boolean().optional(),
  sortKey: z.enum(['name', 'size', 'mtime', 'mode']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional()
})

export const LayoutSchema = z.object({
  columns: z.array(LayoutColumnSchema).max(40)
}) satisfies z.ZodType<Layout>
