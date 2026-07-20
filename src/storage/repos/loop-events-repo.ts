import type { Database } from 'bun:sqlite'

export type LoopEventType =
  | 'coding_done'
  | 'audit_done'
  | 'final_audit_done'
  | 'post_action_done'
  | 'loop_terminated'

export type LoopEventVerdict = 'clean' | 'dirty' | null

export type LoopEventRole = 'code' | 'auditor' | null

export interface LoopEventRow {
  id?: number
  projectId: string
  loopName: string
  runStartedAt: number
  eventType: LoopEventType
  outcome: string | null
  verdict: LoopEventVerdict
  iteration: number | null
  sectionIndex: number | null
  sessionId: string | null
  role: LoopEventRole
  model: string | null
  cost: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  messageCount: number
  findingsTotal: number | null
  findingsBugs: number | null
  detail: string | null
  createdAt: number
}

export interface LoopRunAuditCounts {
  cleanAudits: number
  dirtyAudits: number
  sectionRetries: number
}

export interface LoopEventsRepo {
  insert(row: Omit<LoopEventRow, 'id'>): void
  listByLoop(projectId: string, loopName: string, runStartedAt?: number): LoopEventRow[]
  auditCountsForRun(projectId: string, loopName: string, runStartedAt: number): LoopRunAuditCounts
  sweepOlderThan(cutoffMs: number): number
}

interface LoopEventRowRaw {
  id: number
  project_id: string
  loop_name: string
  run_started_at: number
  event_type: string
  outcome: string | null
  verdict: string | null
  iteration: number | null
  section_index: number | null
  session_id: string | null
  role: string | null
  model: string | null
  cost: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  message_count: number
  findings_total: number | null
  findings_bugs: number | null
  detail: string | null
  created_at: number
}

function mapRow(row: LoopEventRowRaw): LoopEventRow {
  return {
    id: row.id,
    projectId: row.project_id,
    loopName: row.loop_name,
    runStartedAt: row.run_started_at,
    eventType: row.event_type as LoopEventType,
    outcome: row.outcome,
    verdict: row.verdict as LoopEventVerdict,
    iteration: row.iteration,
    sectionIndex: row.section_index,
    sessionId: row.session_id,
    role: row.role as LoopEventRole,
    model: row.model,
    cost: row.cost,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    messageCount: row.message_count,
    findingsTotal: row.findings_total,
    findingsBugs: row.findings_bugs,
    detail: row.detail,
    createdAt: row.created_at,
  }
}

export function createLoopEventsRepo(db: Database): LoopEventsRepo {
  const insertStmt = db.prepare(`
    INSERT INTO loop_events (
      project_id, loop_name, run_started_at, event_type, outcome, verdict,
      iteration, section_index, session_id, role, model,
      cost, input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, message_count,
      findings_total, findings_bugs, detail, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const listByLoopStmt = db.prepare(`
    SELECT id, project_id, loop_name, run_started_at, event_type, outcome, verdict,
           iteration, section_index, session_id, role, model,
           cost, input_tokens, output_tokens, reasoning_tokens,
           cache_read_tokens, cache_write_tokens, message_count,
           findings_total, findings_bugs, detail, created_at
    FROM loop_events
    WHERE project_id = ? AND loop_name = ?
    ORDER BY id ASC
  `)

  const listByLoopRunStmt = db.prepare(`
    SELECT id, project_id, loop_name, run_started_at, event_type, outcome, verdict,
           iteration, section_index, session_id, role, model,
           cost, input_tokens, output_tokens, reasoning_tokens,
           cache_read_tokens, cache_write_tokens, message_count,
           findings_total, findings_bugs, detail, created_at
    FROM loop_events
    WHERE project_id = ? AND loop_name = ? AND run_started_at = ?
    ORDER BY id ASC
  `)

  const auditCountsStmt = db.prepare(`
    SELECT
      SUM(CASE WHEN event_type IN ('audit_done','final_audit_done') AND verdict = 'clean' THEN 1 ELSE 0 END) AS clean_audits,
      SUM(CASE WHEN event_type IN ('audit_done','final_audit_done') AND verdict = 'dirty' THEN 1 ELSE 0 END) AS dirty_audits,
      SUM(CASE WHEN outcome = 'section_retry' THEN 1 ELSE 0 END) AS section_retries
    FROM loop_events
    WHERE project_id = ? AND loop_name = ? AND run_started_at = ?
  `)

  const sweepStmt = db.prepare('DELETE FROM loop_events WHERE created_at < ?')

  return {
    insert(row: Omit<LoopEventRow, 'id'>): void {
      insertStmt.run(
        row.projectId,
        row.loopName,
        row.runStartedAt,
        row.eventType,
        row.outcome,
        row.verdict,
        row.iteration,
        row.sectionIndex,
        row.sessionId,
        row.role,
        row.model,
        row.cost,
        row.inputTokens,
        row.outputTokens,
        row.reasoningTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens,
        row.messageCount,
        row.findingsTotal,
        row.findingsBugs,
        row.detail,
        row.createdAt,
      )
    },

    listByLoop(projectId: string, loopName: string, runStartedAt?: number): LoopEventRow[] {
      const raw = runStartedAt === undefined
        ? (listByLoopStmt.all(projectId, loopName) as LoopEventRowRaw[])
        : (listByLoopRunStmt.all(projectId, loopName, runStartedAt) as LoopEventRowRaw[])
      return raw.map(mapRow)
    },

    auditCountsForRun(projectId: string, loopName: string, runStartedAt: number): LoopRunAuditCounts {
      const row = auditCountsStmt.get(projectId, loopName, runStartedAt) as
        | { clean_audits: number | null; dirty_audits: number | null; section_retries: number | null }
        | null
      return {
        cleanAudits: row?.clean_audits ?? 0,
        dirtyAudits: row?.dirty_audits ?? 0,
        sectionRetries: row?.section_retries ?? 0,
      }
    },

    sweepOlderThan(cutoffMs: number): number {
      const result = sweepStmt.run(cutoffMs) as unknown as { changes: number }
      return result.changes
    },
  }
}
