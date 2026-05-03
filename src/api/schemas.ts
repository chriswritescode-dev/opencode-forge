import { tool } from '@opencode-ai/plugin'

const z = tool.schema

type Schema<T> = {
  parse(input: unknown): T
}

type ExecutionMode = 'new-session' | 'execute-here' | 'loop' | 'loop-worktree'

export const PlanWriteBody: Schema<{ content: string }> = z.object({
  content: z.string(),
})

export const PlanPatchBody: Schema<{ old_string: string; new_string: string }> = z.object({
  old_string: z.string(),
  new_string: z.string(),
})

export const PlanExecuteBody: Schema<{
  mode: ExecutionMode
  title: string
  executionModel?: string
  auditorModel?: string
  targetSessionId?: string
  plan?: string
}> = z.object({
  mode: z.enum(['new-session', 'execute-here', 'loop', 'loop-worktree']),
  title: z.string(),
  executionModel: z.string().optional(),
  auditorModel: z.string().optional(),
  targetSessionId: z.string().optional(),
  plan: z.string().optional(), // optional override
})

export const LoopStartBody: Schema<{
  plan: string
  title: string
  worktree?: boolean
  executionModel?: string
  auditorModel?: string
  hostSessionId?: string
}> = z.object({
  plan: z.string(),
  title: z.string(),
  worktree: z.boolean().optional(),
  executionModel: z.string().optional(),
  auditorModel: z.string().optional(),
  hostSessionId: z.string().optional(),
})

export const ModelPrefsBody: Schema<ModelPrefs> = z.object({
  mode: z
    .enum(['new-session', 'execute-here', 'loop', 'loop-worktree'])
    .optional(),
  executionModel: z.string().optional(),
  auditorModel: z.string().optional(),
})

export const FindingWriteBody: Schema<{
  file: string
  line: number
  severity: 'bug' | 'warning'
  description: string
  scenario?: string
  branch?: string | null
}> = z.object({
  file: z.string(),
  line: z.number(),
  severity: z.enum(['bug', 'warning']),
  description: z.string(),
  scenario: z.string().optional(),
  branch: z.string().nullable().optional(),
})

export const LoopRestartBody: Schema<{ force?: boolean }> = z.object({
  force: z.boolean().optional(),
})

export type ModelPrefs = {
  mode?: ExecutionMode
  executionModel?: string
  auditorModel?: string
}
