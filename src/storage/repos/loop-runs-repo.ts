import type { Database } from 'bun:sqlite'

export interface LoopRunRow {
  projectId: string
  loopName: string
  startedAt: number
  completedAt: number | null
  status: string
  terminationReason: string | null
  loopKind: 'plan' | 'goal'
  executionModel: string | null
  auditorModel: string | null
  executionVariant: string | null
  auditorVariant: string | null
  iterations: number
  auditCount: number
  errorCount: number
  totalSections: number
  sectionRetries: number
  cleanAudits: number
  dirtyAudits: number
  cost: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  messageCount: number
  durationMs: number | null
  createdAt: number
}

export interface LoopRunsRepo {
  upsert(row: LoopRunRow): void
  listByProject(projectId: string): LoopRunRow[]
  listProjectIds(): string[]
  sweepOlderThan(cutoffMs: number): number
}

interface LoopRunRowRaw {
  project_id: string
  loop_name: string
  started_at: number
  completed_at: number | null
  status: string
  termination_reason: string | null
  loop_kind: string
  execution_model: string | null
  auditor_model: string | null
  execution_variant: string | null
  auditor_variant: string | null
  iterations: number
  audit_count: number
  error_count: number
  total_sections: number
  section_retries: number
  clean_audits: number
  dirty_audits: number
  cost: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  message_count: number
  duration_ms: number | null
  created_at: number
}

function mapRow(row: LoopRunRowRaw): LoopRunRow {
  return {
    projectId: row.project_id,
    loopName: row.loop_name,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    terminationReason: row.termination_reason,
    loopKind: row.loop_kind as 'plan' | 'goal',
    executionModel: row.execution_model,
    auditorModel: row.auditor_model,
    executionVariant: row.execution_variant,
    auditorVariant: row.auditor_variant,
    iterations: row.iterations,
    auditCount: row.audit_count,
    errorCount: row.error_count,
    totalSections: row.total_sections,
    sectionRetries: row.section_retries,
    cleanAudits: row.clean_audits,
    dirtyAudits: row.dirty_audits,
    cost: row.cost,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    messageCount: row.message_count,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  }
}

export function createLoopRunsRepo(db: Database): LoopRunsRepo {
  const upsertStmt = db.prepare(`
    INSERT OR REPLACE INTO loop_runs (
      project_id, loop_name, started_at, completed_at, status, termination_reason,
      loop_kind, execution_model, auditor_model, execution_variant, auditor_variant,
      iterations, audit_count, error_count, total_sections, section_retries,
      clean_audits, dirty_audits, cost, input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, message_count, duration_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const listByProjectStmt = db.prepare(`
    SELECT project_id, loop_name, started_at, completed_at, status, termination_reason,
           loop_kind, execution_model, auditor_model, execution_variant, auditor_variant,
           iterations, audit_count, error_count, total_sections, section_retries,
           clean_audits, dirty_audits, cost, input_tokens, output_tokens, reasoning_tokens,
           cache_read_tokens, cache_write_tokens, message_count, duration_ms, created_at
    FROM loop_runs
    WHERE project_id = ?
    ORDER BY started_at DESC
  `)

  const listProjectIdsStmt = db.prepare('SELECT DISTINCT project_id FROM loop_runs')

  const sweepStmt = db.prepare('DELETE FROM loop_runs WHERE created_at < ?')

  return {
    upsert(row: LoopRunRow): void {
      upsertStmt.run(
        row.projectId,
        row.loopName,
        row.startedAt,
        row.completedAt,
        row.status,
        row.terminationReason,
        row.loopKind,
        row.executionModel,
        row.auditorModel,
        row.executionVariant,
        row.auditorVariant,
        row.iterations,
        row.auditCount,
        row.errorCount,
        row.totalSections,
        row.sectionRetries,
        row.cleanAudits,
        row.dirtyAudits,
        row.cost,
        row.inputTokens,
        row.outputTokens,
        row.reasoningTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens,
        row.messageCount,
        row.durationMs,
        row.createdAt,
      )
    },

    listByProject(projectId: string): LoopRunRow[] {
      const raw = listByProjectStmt.all(projectId) as LoopRunRowRaw[]
      return raw.map(mapRow)
    },

    listProjectIds(): string[] {
      const raw = listProjectIdsStmt.all() as Array<{ project_id: string }>
      return raw.map((r) => r.project_id)
    },

    sweepOlderThan(cutoffMs: number): number {
      const result = sweepStmt.run(cutoffMs) as unknown as { changes: number }
      return result.changes
    },
  }
}
