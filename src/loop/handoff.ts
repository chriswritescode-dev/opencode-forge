import { z } from 'zod'

const nonBlank = z.string().refine((value) => value.trim().length > 0, { message: 'must not be blank' })

const coderChangeSchema = z.object({
  summary: nonBlank,
  reason: nonBlank,
})

const coderDeviationSchema = z.object({
  planItem: nonBlank,
  actual: nonBlank,
  reason: nonBlank,
})

const coderVerificationSchema = z.object({
  command: nonBlank,
  cwd: nonBlank,
  outcome: z.enum(['pass', 'fail', 'not-run']),
  changedAfter: z.boolean(),
})

export const coderHandoffFields = {
  changes: z.array(coderChangeSchema).min(1),
  deviations: z.array(coderDeviationSchema).default([]),
  verification: z.array(coderVerificationSchema).min(1),
  notes: z.string().optional(),
}

export const coderHandoffSchema = z.object(coderHandoffFields).strict()

const auditorHandoffSummarySchema = z.object({
  done: z.array(nonBlank).min(1),
  deviations: z.array(nonBlank).default([]),
  followUps: z.array(nonBlank).default([]),
})

export const auditorHandoffFields = {
  summary: auditorHandoffSummarySchema.optional(),
  notes: z.string().optional(),
}

export const auditorHandoffSchema = z.object(auditorHandoffFields).strict()

export const postActionCompleteFields = {
  outcome: z.enum(['completed', 'completed_with_issues', 'failed']),
  steps: z.array(z.object({
    name: nonBlank,
    status: z.enum(['done', 'skipped', 'failed']),
    detail: z.string().optional(),
  })).min(1),
  followUps: z.array(nonBlank).default([]),
  notes: z.string().optional(),
}

export const postActionCompleteSchema = z.object(postActionCompleteFields).strict()

export type CoderHandoffPayload = z.infer<typeof coderHandoffSchema>
type AuditorHandoffSummary = z.infer<typeof auditorHandoffSummarySchema>
export type AuditorHandoffPayload = z.infer<typeof auditorHandoffSchema>
export type PostActionCompletePayload = z.infer<typeof postActionCompleteSchema>

export const LOOP_HANDOFF_ROLES = ['coder', 'auditor', 'post_action'] as const
export const LOOP_HANDOFF_PHASES = ['coding', 'auditing', 'post_action'] as const
export const LOOP_HANDOFF_STATUSES = ['pending', 'applied', 'discarded'] as const

export type LoopHandoffRole = (typeof LOOP_HANDOFF_ROLES)[number]
export type LoopHandoffPhase = (typeof LOOP_HANDOFF_PHASES)[number]
export type LoopHandoffStatus = (typeof LOOP_HANDOFF_STATUSES)[number]

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

export type LoopHandoffRecordFor<R extends LoopHandoffRole> = LoopHandoffRecordBase & {
  role: R
  payload: LoopHandoffPayloadByRole[R]
}

export type LoopHandoffRecord = { [R in LoopHandoffRole]: LoopHandoffRecordFor<R> }[LoopHandoffRole]

export interface LoopHandoffInputBase {
  loopName: string
  sessionId: string
  phase: LoopHandoffPhase
  sectionIndex: number | null
  iteration: number
}

export type LoopHandoffWriteInputFor<R extends LoopHandoffRole> = LoopHandoffInputBase & {
  role: R
  payload: LoopHandoffPayloadByRole[R]
}

export type LoopHandoffWriteInput = { [R in LoopHandoffRole]: LoopHandoffWriteInputFor<R> }[LoopHandoffRole]

export interface HandoffArgs {
  changes?: unknown
  deviations?: unknown
  verification?: unknown
  summary?: unknown
  steps?: unknown
  outcome?: unknown
  notes?: unknown
}

export type ParsedHandoffWriteInput =
  | { ok: true; input: LoopHandoffWriteInputFor<'coder'> }
  | { ok: true; input: LoopHandoffWriteInputFor<'auditor'> }
  | { ok: true; input: LoopHandoffWriteInputFor<'post_action'> }
  | { ok: false; error: z.ZodError }

export function handoffSchemaForRole<R extends LoopHandoffRole>(role: R): (typeof handoffSchemas)[R] {
  return handoffSchemas[role]
}

export function parseHandoffWriteInput(
  role: LoopHandoffRole,
  base: LoopHandoffInputBase,
  raw: HandoffArgs,
): ParsedHandoffWriteInput {
  switch (role) {
    case 'coder': {
      const parsed = coderHandoffSchema.safeParse(raw)
      return parsed.success
        ? { ok: true, input: { ...base, role, payload: parsed.data } }
        : { ok: false, error: parsed.error }
    }
    case 'auditor': {
      const parsed = auditorHandoffSchema.safeParse(raw)
      return parsed.success
        ? { ok: true, input: { ...base, role, payload: parsed.data } }
        : { ok: false, error: parsed.error }
    }
    case 'post_action': {
      const parsed = postActionCompleteSchema.safeParse(raw)
      return parsed.success
        ? { ok: true, input: { ...base, role, payload: parsed.data } }
        : { ok: false, error: parsed.error }
    }
  }
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

export interface SectionSummaryLines {
  done: string
  deviations: string
  followUps: string
}

export function formatSectionSummary(summary: AuditorHandoffSummary): SectionSummaryLines {
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
