import { z } from 'zod'

const nonBlank = z.string().refine((value) => value.trim().length > 0, { message: 'must not be blank' })

export const coderHandoffSchema = z.object({
  changes: z.array(z.object({
    summary: nonBlank,
    reason: nonBlank,
  })).min(1),
  deviations: z.array(z.object({
    planItem: nonBlank,
    actual: nonBlank,
    reason: nonBlank,
  })).default([]),
  verification: z.array(z.object({
    command: nonBlank,
    cwd: nonBlank,
    outcome: z.enum(['pass', 'fail', 'not-run']),
    changedAfter: z.boolean(),
  })).min(1),
  notes: z.string().optional(),
}).strict()

export const auditorHandoffSummarySchema = z.object({
  done: z.array(nonBlank).min(1),
  deviations: z.array(nonBlank).default([]),
  followUps: z.array(nonBlank).default([]),
})

export const auditorHandoffSchema = z.object({
  summary: auditorHandoffSummarySchema.optional(),
  notes: z.string().optional(),
}).strict()

export const postActionCompleteSchema = z.object({
  outcome: z.enum(['completed', 'completed_with_issues', 'failed']),
  steps: z.array(z.object({
    name: nonBlank,
    status: z.enum(['done', 'skipped', 'failed']),
    detail: z.string().optional(),
  })).min(1),
  followUps: z.array(nonBlank).default([]),
  notes: z.string().optional(),
}).strict()

export type CoderHandoffPayload = z.infer<typeof coderHandoffSchema>
export type AuditorHandoffSummary = z.infer<typeof auditorHandoffSummarySchema>
export type AuditorHandoffPayload = z.infer<typeof auditorHandoffSchema>
export type PostActionCompletePayload = z.infer<typeof postActionCompleteSchema>

export type LoopHandoffRole = 'coder' | 'auditor' | 'post_action'
export type LoopHandoffPhase = 'coding' | 'auditing' | 'post_action'
export type LoopHandoffStatus = 'pending' | 'applied' | 'discarded'

const handoffSchemas = {
  coder: coderHandoffSchema,
  auditor: auditorHandoffSchema,
  post_action: postActionCompleteSchema,
} as const

export type LoopHandoffPayloadByRole = {
  [R in LoopHandoffRole]: z.infer<(typeof handoffSchemas)[R]>
}

interface LoopHandoffRecordBase {
  id: number
  projectId: string
  loopName: string
  sessionId: string
  phase: LoopHandoffPhase
  sectionIndex: number | null
  iteration: number
  status: LoopHandoffStatus
  createdAt: number
  resolvedAt: number | null
}

export type LoopHandoffRecord = {
  [R in LoopHandoffRole]: LoopHandoffRecordBase & {
    role: R
    payload: LoopHandoffPayloadByRole[R]
  }
}[LoopHandoffRole]

interface LoopHandoffInputBase {
  loopName: string
  sessionId: string
  phase: LoopHandoffPhase
  sectionIndex: number | null
  iteration: number
}

export type LoopHandoffWriteInput = {
  [R in LoopHandoffRole]: LoopHandoffInputBase & {
    role: R
    payload: LoopHandoffPayloadByRole[R]
  }
}[LoopHandoffRole]

export function handoffSchemaForRole<R extends LoopHandoffRole>(role: R): (typeof handoffSchemas)[R] {
  return handoffSchemas[role]
}

export function handoffRoleForPhase(phase: string): LoopHandoffRole | null {
  switch (phase) {
    case 'coding':
      return 'coder'
    case 'auditing':
      return 'auditor'
    case 'post_action':
      return 'post_action'
    default:
      return null
  }
}

function bulletList(items: readonly string[] | undefined): string[] {
  if (!items || items.length === 0) return ['none']
  return items.map((item) => `- ${item}`)
}

export function formatCoderHandoff(payload: CoderHandoffPayload): string {
  return [
    '### Decisions',
    ...payload.changes.map((change) => `- ${change.summary} — ${change.reason}`),
    '### Deviations',
    ...(payload.deviations.length === 0
      ? ['none']
      : payload.deviations.map((deviation) => `- ${deviation.planItem} — ${deviation.actual} (${deviation.reason})`)),
    '### Verification',
    ...payload.verification.map((check) => {
      const changed = check.changedAfter ? ' (code changed afterwards)' : ''
      return `- \`${check.command}\` in \`${check.cwd}\` — ${check.outcome}${changed}`
    }),
    '### Notes for auditor',
    payload.notes && payload.notes.trim().length > 0 ? payload.notes : 'none',
  ].join('\n')
}

export function formatSectionSummary(summary: AuditorHandoffSummary): { done: string; deviations: string; followUps: string } {
  return {
    done: bulletList(summary.done).join('\n'),
    deviations: bulletList(summary.deviations).join('\n'),
    followUps: bulletList(summary.followUps).join('\n'),
  }
}

export function formatAuditHandoffResult(
  payload: AuditorHandoffPayload,
  verdict: { clean: boolean; blockingBugs: number; sectionIndex: number | null },
): string {
  return [
    `Verdict: ${verdict.clean ? 'clean' : 'dirty'}`,
    `Blocking bugs: ${verdict.blockingBugs}`,
    `Section: ${verdict.sectionIndex === null ? 'plan' : String(verdict.sectionIndex)}`,
    '### Done',
    ...bulletList(payload.summary?.done),
    '### Deviations',
    ...bulletList(payload.summary?.deviations),
    '### Follow-ups',
    ...bulletList(payload.summary?.followUps),
    '### Notes',
    payload.notes && payload.notes.trim().length > 0 ? payload.notes : 'none',
  ].join('\n')
}

export function formatPostActionReport(payload: PostActionCompletePayload): string {
  return [
    `Outcome: ${payload.outcome}`,
    '### Steps',
    '| Step | Status | Detail |',
    '| --- | --- | --- |',
    ...payload.steps.map((step) => `| ${step.name} | ${step.status} | ${step.detail ?? ''} |`),
    '### Follow-ups',
    ...bulletList(payload.followUps),
    '### Notes',
    payload.notes && payload.notes.trim().length > 0 ? payload.notes : 'none',
  ].join('\n')
}

export function formatPostActionSummary(payload: PostActionCompletePayload): string {
  const done = payload.steps.filter((step) => step.status === 'done').length
  const skipped = payload.steps.filter((step) => step.status === 'skipped').length
  const failed = payload.steps.filter((step) => step.status === 'failed').length
  return `${payload.outcome} — ${done}/${payload.steps.length} steps done, ${skipped} skipped, ${failed} failed`
}

export function handoffCompletionKey(record: Pick<LoopHandoffRecord, 'id'>): string {
  return `handoff:${record.id}`
}
