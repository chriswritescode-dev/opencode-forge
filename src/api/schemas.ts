import { tool } from '@opencode-ai/plugin'
import type { ZodType } from 'zod'
import { z as zod } from 'zod'
import { badRequest } from './errors'

const z = tool.schema

export const PlanWriteBody = z.object({
  content: z.string(),
})

export const PlanPatchBody = z.object({
  old_string: z.string(),
  new_string: z.string(),
})

export const PlanExecuteBody = z.object({
  mode: z.enum(['new-session', 'execute-here', 'loop', 'loop-worktree']),
  title: z.string(),
  executionModel: z.string().optional(),
  auditorModel: z.string().optional(),
  targetSessionId: z.string().optional(),
  plan: z.string().optional(), // optional override
})

export const LoopStartBody = z.object({
  plan: z.string(),
  title: z.string(),
  worktree: z.boolean().optional(),
  executionModel: z.string().optional(),
  auditorModel: z.string().optional(),
  hostSessionId: z.string().optional(),
})

export const ModelPrefsBody = z.object({
  mode: z
    .enum(['new-session', 'execute-here', 'loop', 'loop-worktree'])
    .optional(),
  executionModel: z.string().optional(),
  auditorModel: z.string().optional(),
})

export const FindingWriteBody = z.object({
  file: z.string(),
  line: z.number(),
  severity: z.enum(['bug', 'warning']),
  description: z.string(),
  scenario: z.string().optional(),
  branch: z.string().nullable().optional(),
})

export const LoopRestartBody = z.object({
  force: z.boolean().optional(),
})

type InferType<T extends ZodType> = zod.infer<T>

export type PlanWrite = InferType<typeof PlanWriteBody>
export type PlanPatch = InferType<typeof PlanPatchBody>
export type PlanExecute = InferType<typeof PlanExecuteBody>
export type LoopStart = InferType<typeof LoopStartBody>
export type ModelPrefs = InferType<typeof ModelPrefsBody>
export type FindingWrite = InferType<typeof FindingWriteBody>
export type LoopRestart = InferType<typeof LoopRestartBody>

export async function parseJsonBody<T>(
  req: Request,
  schema: ZodType<T>
): Promise<T> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw badRequest('invalid JSON body')
  }

  try {
    return schema.parse(body) as T
  } catch (err) {
    if (err instanceof zod.ZodError) {
      const message = err.issues.map((e) => e.message).join('; ')
      throw badRequest(message || 'invalid request body')
    }
    throw err
  }
}
