import type { Database } from 'bun:sqlite'
import type { Logger } from '../../types'
import type { ReviewFindingRow } from './review-findings-repo'

export type LoopAttemptOutcome = 'clean' | 'dirty'

export type LoopAttemptRecordInput = Omit<
  LoopAttemptRow,
  'id' | 'attemptNumber' | 'auditorSessionId' | 'findingsAfter' | 'outcome' | 'createdAt' | 'auditedAt'
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
  createdAt: number
  auditedAt: number | null
}

export interface LoopAttemptsRepo {
  record(input: LoopAttemptRecordInput): LoopAttemptRow | null
  list(projectId: string, loopName: string, scope?: string, limit?: number, beforeId?: number): LoopAttemptRow[]
  latest(projectId: string, loopName: string, scope: string): LoopAttemptRow | null
  bindAudit(projectId: string, loopName: string, scope: string, sourceSessionId: string, auditorSessionId: string, replaceSession?: () => void): void
  finishAudit(projectId: string, loopName: string, scope: string, auditorSessionId: string, outcome: LoopAttemptOutcome, findings: ReviewFindingRow[]): boolean
  invalidateSnapshot(projectId: string, loopName: string, id: number, reason: string): void
}

interface LoopAttemptRowRaw {
  id: number
  project_id: string
  loop_name: string
  scope: string
  attempt_number: number
  source_session_id: string
  completion_key: string
  auditor_session_id: string | null
  iteration: number
  worktree_dir: string
  plan_hash: string
  coder_decisions: string | null
  snapshot_commit: string | null
  snapshot_ref: string | null
  previous_commit: string | null
  diff_summary: string | null
  fallback_reason: string | null
  findings_before: string | null
  findings_after: string | null
  outcome: string | null
  created_at: number
  audited_at: number | null
}

const ATTEMPT_COLUMNS = `id, project_id, loop_name, scope, attempt_number, source_session_id,
  completion_key, auditor_session_id, iteration, worktree_dir, plan_hash, coder_decisions,
  snapshot_commit, snapshot_ref, previous_commit, diff_summary, fallback_reason,
  findings_before, findings_after, outcome, created_at, audited_at`

function parseFinding(value: unknown): ReviewFindingRow | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  if (typeof o.file !== 'string' || typeof o.line !== 'number') return null
  if (o.severity !== 'bug' && o.severity !== 'warning') return null
  if (typeof o.description !== 'string') return null
  return {
    projectId: typeof o.projectId === 'string' ? o.projectId : '',
    file: o.file,
    line: o.line,
    severity: o.severity,
    description: o.description,
    scenario: typeof o.scenario === 'string' ? o.scenario : null,
    loopName: typeof o.loopName === 'string' ? o.loopName : null,
    sectionIndex: typeof o.sectionIndex === 'number' ? o.sectionIndex : null,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
  }
}

function parseFindings(text: string): ReviewFindingRow[] | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!Array.isArray(parsed)) return null
    const rows: ReviewFindingRow[] = []
    for (const item of parsed) {
      const finding = parseFinding(item)
      if (finding) rows.push(finding)
    }
    return rows
  } catch {
    return null
  }
}

function parseOutcome(value: string | null): LoopAttemptOutcome | null {
  return value === 'clean' || value === 'dirty' ? value : null
}

function mapRow(raw: LoopAttemptRowRaw): LoopAttemptRow {
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

  const stmtInvalidate = db.prepare(`
    UPDATE loop_attempts
    SET previous_commit = NULL, diff_summary = NULL, fallback_reason = ?
    WHERE project_id = ? AND loop_name = ? AND id = ?
  `)

  function loopOwnedBy(loop: { status: string; current_session_id: string } | null | undefined, sessionId: string): boolean {
    return !!loop && loop.status === 'running' && loop.current_session_id === sessionId
  }

  function record(input: LoopAttemptRecordInput): LoopAttemptRow | null {
    return db.transaction(() => {
      const loop = stmtLoopGuard.get(input.projectId, input.loopName) as { status: string; current_session_id: string } | undefined
      if (!loopOwnedBy(loop, input.sourceSessionId)) return null

      const existing = stmtGetByKey.get(input.projectId, input.loopName, input.scope, input.completionKey) as LoopAttemptRowRaw | undefined
      if (existing) return mapRow(existing)

      const maxRow = stmtNextAttemptNumber.get(input.projectId, input.loopName, input.scope) as { max: number | null }
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
          const raced = stmtGetByKey.get(input.projectId, input.loopName, input.scope, input.completionKey) as LoopAttemptRowRaw | undefined
          return raced ? mapRow(raced) : null
        }
        throw err
      }

      const inserted = stmtGetByKey.get(input.projectId, input.loopName, input.scope, input.completionKey) as LoopAttemptRowRaw
      return mapRow(inserted)
    })()
  }

  function bindAudit(projectId: string, loopName: string, scope: string, sourceSessionId: string, auditorSessionId: string, replaceSession?: () => void): void {
    db.transaction(() => {
      if (replaceSession) {
        const loop = stmtLoopGuard.get(projectId, loopName) as { status: string; current_session_id: string } | undefined
        if (!loopOwnedBy(loop, sourceSessionId)) throw new Error('Audit handoff source session is no longer active')
        replaceSession()
      }
      const row = stmtNewestUnfinished.get(projectId, loopName, scope, sourceSessionId) as { id: number; auditor_session_id: string | null } | undefined
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
      const loop = stmtLoopGuard.get(projectId, loopName) as { status: string; current_session_id: string } | undefined
      if (!loopOwnedBy(loop, auditorSessionId)) return false
      const result = stmtFinish.run(
        Date.now(),
        JSON.stringify(findings),
        outcome,
        projectId,
        loopName,
        scope,
        auditorSessionId,
      ) as unknown as { changes: number }
      return result.changes > 0
    })()
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
      const rows = db
        .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM loop_attempts WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ?`)
        .all(...params, clamped) as LoopAttemptRowRaw[]
      return rows.reverse().map(mapRow)
    },
    latest(projectId: string, loopName: string, scope: string): LoopAttemptRow | null {
      const row = stmtLatest.get(projectId, loopName, scope) as LoopAttemptRowRaw | undefined
      return row ? mapRow(row) : null
    },
    bindAudit,
    finishAudit,
    invalidateSnapshot,
  }
}
