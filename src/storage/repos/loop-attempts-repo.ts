import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { statementChanges } from '../sqlite-open'
import type { Logger } from '../../types'
import type { ReviewFindingRow } from './review-findings-repo'

const storedFindingSchema = z.object({
  projectId: z.string().catch(''),
  file: z.string(),
  line: z.number(),
  severity: z.enum(['bug', 'warning']),
  description: z.string(),
  scenario: z.string().nullable().catch(null),
  loopName: z.string().nullable().catch(null),
  sectionIndex: z.number().nullable().catch(null),
  createdAt: z.number().catch(0),
})

const loopAttemptRowSchema = z.object({
  id: z.number(),
  project_id: z.string(),
  loop_name: z.string(),
  scope: z.string(),
  attempt_number: z.number(),
  source_session_id: z.string(),
  completion_key: z.string(),
  auditor_session_id: z.string().nullable(),
  iteration: z.number(),
  worktree_dir: z.string(),
  plan_hash: z.string(),
  coder_decisions: z.string().nullable(),
  snapshot_commit: z.string().nullable(),
  snapshot_ref: z.string().nullable(),
  previous_commit: z.string().nullable(),
  diff_summary: z.string().nullable(),
  fallback_reason: z.string().nullable(),
  findings_before: z.string().nullable(),
  findings_after: z.string().nullable(),
  outcome: z.string().nullable(),
  code_graph: z.string().nullable(),
  created_at: z.number(),
  audited_at: z.number().nullable(),
})
const loopAttemptRowsSchema = z.array(loopAttemptRowSchema)

const loopGuardRowSchema = z.object({ status: z.string(), current_session_id: z.string() })
const maxAttemptRowSchema = z.object({ max: z.number().nullable() })
const unfinishedAttemptRowSchema = z.object({ id: z.number(), auditor_session_id: z.string().nullable() })

export type LoopAttemptOutcome = 'clean' | 'dirty'

export type LoopAttemptRecordInput = Omit<
  LoopAttemptRow,
  'id' | 'attemptNumber' | 'auditorSessionId' | 'findingsAfter' | 'outcome' | 'codeGraph' | 'createdAt' | 'auditedAt'
>

export interface LoopAttemptRow {
  id: number
  projectId: string
  loopName: string
  scope: string
  attemptNumber: number
  sourceSessionId: string
  completionKey: string
  auditorSessionId: string | null
  iteration: number
  worktreeDir: string
  planHash: string
  coderDecisions: string | null
  snapshotCommit: string | null
  snapshotRef: string | null
  previousCommit: string | null
  diffSummary: string | null
  fallbackReason: string | null
  findingsBefore: ReviewFindingRow[]
  findingsAfter: ReviewFindingRow[] | null
  outcome: LoopAttemptOutcome | null
  codeGraph: string | null
  createdAt: number
  auditedAt: number | null
}

export interface LoopAttemptsRepo {
  record(input: LoopAttemptRecordInput): LoopAttemptRow | null
  list(projectId: string, loopName: string, scope?: string, limit?: number, beforeId?: number): LoopAttemptRow[]
  latest(projectId: string, loopName: string, scope: string): LoopAttemptRow | null
  bindAudit(projectId: string, loopName: string, scope: string, sourceSessionId: string, auditorSessionId: string, replaceSession?: () => void): void
  finishAudit(projectId: string, loopName: string, scope: string, auditorSessionId: string, outcome: LoopAttemptOutcome, findings: ReviewFindingRow[]): boolean
  setCodeGraph(projectId: string, loopName: string, id: number, text: string | null): void
  invalidateSnapshot(projectId: string, loopName: string, id: number, reason: string): void
}

const ATTEMPT_COLUMNS = `id, project_id, loop_name, scope, attempt_number, source_session_id,
  completion_key, auditor_session_id, iteration, worktree_dir, plan_hash, coder_decisions,
  snapshot_commit, snapshot_ref, previous_commit, diff_summary, fallback_reason,
  findings_before, findings_after, outcome, code_graph, created_at, audited_at`

function parseFindings(text: string): ReviewFindingRow[] | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return null
    const rows: ReviewFindingRow[] = []
    for (const item of parsed) {
      const finding = storedFindingSchema.safeParse(item)
      if (finding.success) rows.push(finding.data)
    }
    return rows
  } catch {
    return null
  }
}

function parseOutcome(value: string | null): LoopAttemptOutcome | null {
  return value === 'clean' || value === 'dirty' ? value : null
}

function mapRow(raw: z.infer<typeof loopAttemptRowSchema>): LoopAttemptRow {
  return {
    id: raw.id,
    projectId: raw.project_id,
    loopName: raw.loop_name,
    scope: raw.scope,
    attemptNumber: raw.attempt_number,
    sourceSessionId: raw.source_session_id,
    completionKey: raw.completion_key,
    auditorSessionId: raw.auditor_session_id,
    iteration: raw.iteration,
    worktreeDir: raw.worktree_dir,
    planHash: raw.plan_hash,
    coderDecisions: raw.coder_decisions,
    snapshotCommit: raw.snapshot_commit,
    snapshotRef: raw.snapshot_ref,
    previousCommit: raw.previous_commit,
    diffSummary: raw.diff_summary,
    fallbackReason: raw.fallback_reason,
    findingsBefore: raw.findings_before === null ? [] : parseFindings(raw.findings_before) ?? [],
    findingsAfter: raw.findings_after === null ? null : parseFindings(raw.findings_after),
    outcome: parseOutcome(raw.outcome),
    codeGraph: raw.code_graph,
    createdAt: raw.created_at,
    auditedAt: raw.audited_at,
  }
}

export function createLoopAttemptsRepo(db: Database, _logger?: Logger): LoopAttemptsRepo {
  const stmtLoopGuard = db.prepare(`
    SELECT status, current_session_id
    FROM loops
    WHERE project_id = ? AND loop_name = ?
  `)

  const stmtGetByKey = db.prepare(`
    SELECT ${ATTEMPT_COLUMNS}
    FROM loop_attempts
    WHERE project_id = ? AND loop_name = ? AND scope = ? AND completion_key = ?
  `)

  const stmtNextAttemptNumber = db.prepare(`
    SELECT MAX(attempt_number) AS max
    FROM loop_attempts
    WHERE project_id = ? AND loop_name = ? AND scope = ?
  `)

  const stmtInsert = db.prepare(`
    INSERT INTO loop_attempts (
      project_id, loop_name, scope, attempt_number, source_session_id, completion_key,
      iteration, worktree_dir, plan_hash, coder_decisions, snapshot_commit, snapshot_ref,
      previous_commit, diff_summary, fallback_reason, findings_before, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const stmtLatest = db.prepare(`
    SELECT ${ATTEMPT_COLUMNS}
    FROM loop_attempts
    WHERE project_id = ? AND loop_name = ? AND scope = ?
    ORDER BY id DESC
    LIMIT 1
  `)

  const stmtNewestUnfinished = db.prepare(`
    SELECT id, auditor_session_id
    FROM loop_attempts
    WHERE project_id = ? AND loop_name = ? AND scope = ? AND source_session_id = ? AND audited_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  `)

  const stmtBind = db.prepare(`
    UPDATE loop_attempts
    SET auditor_session_id = ?
    WHERE id = ? AND (auditor_session_id IS NULL OR auditor_session_id = ?)
  `)

  const stmtFinish = db.prepare(`
    UPDATE loop_attempts
    SET audited_at = ?, findings_after = ?, outcome = ?
    WHERE id = (
      SELECT id
      FROM loop_attempts
      WHERE project_id = ? AND loop_name = ? AND scope = ? AND auditor_session_id = ? AND audited_at IS NULL
      ORDER BY id DESC
      LIMIT 1
    )
  `)

  const stmtSetCodeGraph = db.prepare(`
    UPDATE loop_attempts
    SET code_graph = ?
    WHERE id = ? AND project_id = ? AND loop_name = ?
  `)

  const stmtInvalidate = db.prepare(`
    UPDATE loop_attempts
    SET previous_commit = NULL, diff_summary = NULL, fallback_reason = ?
    WHERE project_id = ? AND loop_name = ? AND id = ?
  `)

  function loopOwnedBy(loop: z.infer<typeof loopGuardRowSchema> | null | undefined, sessionId: string): boolean {
    return !!loop && loop.status === 'running' && loop.current_session_id === sessionId
  }

  function record(input: LoopAttemptRecordInput): LoopAttemptRow | null {
    return db.transaction(() => {
      const loop = loopGuardRowSchema.nullish().parse(stmtLoopGuard.get(input.projectId, input.loopName))
      if (!loopOwnedBy(loop, input.sourceSessionId)) return null

      const existing = loopAttemptRowSchema.nullish().parse(stmtGetByKey.get(input.projectId, input.loopName, input.scope, input.completionKey))
      if (existing) return mapRow(existing)

      const maxRow = maxAttemptRowSchema.parse(stmtNextAttemptNumber.get(input.projectId, input.loopName, input.scope))
      try {
        stmtInsert.run(
          input.projectId,
          input.loopName,
          input.scope,
          (maxRow?.max ?? 0) + 1,
          input.sourceSessionId,
          input.completionKey,
          input.iteration,
          input.worktreeDir,
          input.planHash,
          input.coderDecisions ?? null,
          input.snapshotCommit ?? null,
          input.snapshotRef ?? null,
          input.previousCommit ?? null,
          input.diffSummary ?? null,
          input.fallbackReason ?? null,
          JSON.stringify(input.findingsBefore ?? []),
          Date.now(),
        )
      } catch (err) {
        if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
          const raced = loopAttemptRowSchema.nullish().parse(stmtGetByKey.get(input.projectId, input.loopName, input.scope, input.completionKey))
          return raced ? mapRow(raced) : null
        }
        throw err
      }

      const inserted = loopAttemptRowSchema.parse(stmtGetByKey.get(input.projectId, input.loopName, input.scope, input.completionKey))
      return mapRow(inserted)
    })()
  }

  function bindAudit(projectId: string, loopName: string, scope: string, sourceSessionId: string, auditorSessionId: string, replaceSession?: () => void): void {
    db.transaction(() => {
      if (replaceSession) {
        const loop = loopGuardRowSchema.nullish().parse(stmtLoopGuard.get(projectId, loopName))
        if (!loopOwnedBy(loop, sourceSessionId)) throw new Error('Audit handoff source session is no longer active')
        replaceSession()
      }
      const row = unfinishedAttemptRowSchema.nullish().parse(stmtNewestUnfinished.get(projectId, loopName, scope, sourceSessionId))
      if (!row) return
      stmtBind.run(auditorSessionId, row.id, auditorSessionId)
    })()
  }

  function finishAudit(
    projectId: string,
    loopName: string,
    scope: string,
    auditorSessionId: string,
    outcome: LoopAttemptOutcome,
    findings: ReviewFindingRow[],
  ): boolean {
    return db.transaction(() => {
      const loop = loopGuardRowSchema.nullish().parse(stmtLoopGuard.get(projectId, loopName))
      if (!loopOwnedBy(loop, auditorSessionId)) return false
      const changes = statementChanges(stmtFinish.run(
        Date.now(),
        JSON.stringify(findings),
        outcome,
        projectId,
        loopName,
        scope,
        auditorSessionId,
      ))
      return changes > 0
    })()
  }

  function setCodeGraph(projectId: string, loopName: string, id: number, text: string | null): void {
    stmtSetCodeGraph.run(text, id, projectId, loopName)
  }

  function invalidateSnapshot(projectId: string, loopName: string, id: number, reason: string): void {
    db.transaction(() => {
      stmtInvalidate.run(reason, projectId, loopName, id)
    })()
  }

  return {
    record,
    list(projectId: string, loopName: string, scope?: string, limit?: number, beforeId?: number): LoopAttemptRow[] {
      const clamped = Math.min(100, Math.max(1, limit ?? 20))
      const conditions: string[] = ['project_id = ?', 'loop_name = ?']
      const params: (string | number)[] = [projectId, loopName]
      if (scope !== undefined) {
        conditions.push('scope = ?')
        params.push(scope)
      }
      if (beforeId !== undefined) {
        conditions.push('id < ?')
        params.push(beforeId)
      }
      const rows = loopAttemptRowsSchema.parse(
        db
          .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM loop_attempts WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ?`)
          .all(...params, clamped),
      )
      return rows.reverse().map(mapRow)
    },
    latest(projectId: string, loopName: string, scope: string): LoopAttemptRow | null {
      const row = loopAttemptRowSchema.nullish().parse(stmtLatest.get(projectId, loopName, scope))
      return row ? mapRow(row) : null
    },
    bindAudit,
    finishAudit,
    setCodeGraph,
    invalidateSnapshot,
  }
}
