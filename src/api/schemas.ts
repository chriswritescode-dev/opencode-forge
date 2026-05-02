import { tool } from '@opencode-ai/plugin'
import { z as zod } from 'zod'

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

export type ModelPrefs = zod.infer<typeof ModelPrefsBody>
