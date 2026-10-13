import { z } from 'zod'
import type { ConnectionProfileInput, PromptResponse } from './connections'

export const AuthMethodSchema = z.enum(['agent', 'publickey', 'password', 'keyboard-interactive'])

export const ConnectionProfileInputSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1, 'Give the connection a name').max(100),
  host: z
    .string()
    .trim()
    .min(1, 'Host is required')
    .max(255)
    .refine((h) => !/\s/.test(h), 'Host cannot contain spaces'),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().max(64),
  authMethods: z.array(AuthMethodSchema).min(1, 'Pick at least one authentication method').max(4),
  identityFile: z.string().max(4096).optional(),
  jumpHostId: z.string().max(64).optional(),
  defaultPath: z
    .string()
    .max(4096)
    .refine((p) => p.trim() === '' || p.trim().startsWith('/'), {
      message: 'Default folder must be an absolute path'
    })
    .optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  sshAlias: z.string().max(255).optional()
}) satisfies z.ZodType<ConnectionProfileInput, unknown>

export const ConnectionProfileSchema = ConnectionProfileInputSchema.extend({
  id: z.string().min(1).max(64)
})

export const PromptResponseSchema = z.union([
  z.object({
    kind: z.enum(['password', 'passphrase']),
    value: z.string().max(10_000),
    remember: z.boolean()
  }),
  z.object({ kind: z.literal('keyboard-interactive'), answers: z.array(z.string().max(10_000)) }),
  z.object({ kind: z.literal('hostkey'), accept: z.boolean(), remember: z.boolean() })
]) satisfies z.ZodType<PromptResponse>

export const ConnectionStateSchema = z.object({
  profileId: z.string(),
  status: z.enum(['connecting', 'connected', 'reconnecting', 'disconnected', 'error']),
  error: z.string().optional(),
  attempt: z.number().optional()
})

export const SshConfigCandidateSchema = z.object({
  alias: z.string(),
  hostName: z.string(),
  user: z.string().optional(),
  port: z.number(),
  identityFile: z.string().optional(),
  proxyJump: z.string().optional(),
  imported: z.boolean()
})

const OPTIONAL_TEXT_FIELDS = ['identityFile', 'jumpHostId', 'defaultPath', 'sshAlias'] as const

/** Trim optional text fields and drop the ones left empty, so "" never means a value. */
export function normalizeProfileInput(input: ConnectionProfileInput): ConnectionProfileInput {
  const out: ConnectionProfileInput = { ...input }
  for (const field of OPTIONAL_TEXT_FIELDS) {
    const trimmed = out[field]?.trim()
    if (trimmed) out[field] = trimmed
    else delete out[field]
  }
  return out
}
