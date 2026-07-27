import type { Database } from 'bun:sqlite'

export interface LoopSessionUsageRow {
  projectId: string
  loopName: string
  sessionId: string
  role: 'code' | 'auditor' | 'unknown'
  model: string
  cost: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  messageCount: number
  capturedAt: number
}

export interface LoopUsageAggregate {
  loopName: string
  totalCost: number
  totalInputTokens: number
  totalOutputTokens: number
  totalReasoningTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalMessageCount: number
  byModel: Record<string, {
    cost: number
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    messageCount: number
  }>
  byRole: Partial<Record<LoopSessionUsageRow['role'], {
    cost: number
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    messageCount: number
  }>>
}

export interface LoopSessionUsageRepo {
  upsertSessionUsage(rows: LoopSessionUsageRow | LoopSessionUsageRow[]): void
  getAggregate(projectId: string, loopName: string): LoopUsageAggregate | null
  listSessionUsage(projectId: string, loopName: string): LoopSessionUsageRow[]
  hasSession(projectId: string, loopName: string, sessionId: string): boolean
  deleteLoop(projectId: string, loopName: string): void
}

interface LoopSessionUsageRowRaw {
  project_id: string
  loop_name: string
  session_id: string
  role: string
  model: string
  cost: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  message_count: number
  captured_at: number
}

type UsageBucket = LoopUsageAggregate['byModel'][string]

interface AggregateGroupRow {
  role: string
  model: string
  cost: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  message_count: number
}

function emptyUsageBucket(): UsageBucket {
  return {
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    messageCount: 0,
  }
}

function accumulateUsageBucket<K extends string>(
  buckets: Partial<Record<K, UsageBucket>>,
  key: K,
  row: AggregateGroupRow,
): void {
  const bucket = (buckets[key] ??= emptyUsageBucket())
  bucket.cost += row.cost
  bucket.inputTokens += row.input_tokens
  bucket.outputTokens += row.output_tokens
  bucket.reasoningTokens += row.reasoning_tokens
  bucket.cacheReadTokens += row.cache_read_tokens
  bucket.cacheWriteTokens += row.cache_write_tokens
  bucket.messageCount += row.message_count
}

function mapRow(row: LoopSessionUsageRowRaw): LoopSessionUsageRow {
  return {
    projectId: row.project_id,
    loopName: row.loop_name,
    sessionId: row.session_id,
    role: row.role as LoopSessionUsageRow['role'],
    model: row.model,
    cost: row.cost,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    messageCount: row.message_count,
    capturedAt: row.captured_at,
  }
}

export function createLoopSessionUsageRepo(db: Database): LoopSessionUsageRepo {
  const upsertStmt = db.prepare(`
    INSERT INTO loop_session_usage (
      project_id, loop_name, session_id, role, model,
      cost, input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, message_count, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const deleteSessionStmt = db.prepare(`
    DELETE FROM loop_session_usage
    WHERE project_id = ? AND loop_name = ? AND session_id = ?
  `)

  // One scan of idx_loop_session_usage_project_loop produces the totals, the
  // per-model split and the per-role split; the dashboard poll calls this once
  // per loop, so a statement per shape tripled the work for no extra data.
  const getAggregateStmt = db.prepare(`
    SELECT
      role,
      model,
      SUM(cost) as cost,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(reasoning_tokens) as reasoning_tokens,
      SUM(cache_read_tokens) as cache_read_tokens,
      SUM(cache_write_tokens) as cache_write_tokens,
      SUM(message_count) as message_count
    FROM loop_session_usage
    WHERE project_id = ? AND loop_name = ?
    GROUP BY role, model
  `)

  const listSessionUsageStmt = db.prepare(`
    SELECT project_id, loop_name, session_id, role, model,
           cost, input_tokens, output_tokens, reasoning_tokens,
           cache_read_tokens, cache_write_tokens, message_count, captured_at
    FROM loop_session_usage
    WHERE project_id = ? AND loop_name = ?
    ORDER BY session_id, model
  `)

  const hasSessionStmt = db.prepare(`
    SELECT 1 FROM loop_session_usage
    WHERE project_id = ? AND loop_name = ? AND session_id = ?
    LIMIT 1
  `)

  const deleteLoopStmt = db.prepare(`
    DELETE FROM loop_session_usage
    WHERE project_id = ? AND loop_name = ?
  `)

  return {
    upsertSessionUsage(rows: LoopSessionUsageRow | LoopSessionUsageRow[]): void {
      const rowsArray = Array.isArray(rows) ? rows : [rows]
      if (rowsArray.length === 0) return

      const runTxn = db.transaction(() => {
        const { projectId, loopName, sessionId } = rowsArray[0]
        deleteSessionStmt.run(projectId, loopName, sessionId)
        for (const row of rowsArray) {
          upsertStmt.run(
            row.projectId,
            row.loopName,
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
            row.capturedAt,
          )
        }
      })
      runTxn()
    },

    getAggregate(projectId: string, loopName: string): LoopUsageAggregate | null {
      const rows = getAggregateStmt.all(projectId, loopName) as AggregateGroupRow[]

      if (rows.length === 0) return null

      const aggregate: LoopUsageAggregate = {
        loopName,
        totalCost: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalReasoningTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        totalMessageCount: 0,
        byModel: {},
        byRole: {},
      }

      for (const row of rows) {
        aggregate.totalCost += row.cost
        aggregate.totalInputTokens += row.input_tokens
        aggregate.totalOutputTokens += row.output_tokens
        aggregate.totalReasoningTokens += row.reasoning_tokens
        aggregate.totalCacheReadTokens += row.cache_read_tokens
        aggregate.totalCacheWriteTokens += row.cache_write_tokens
        aggregate.totalMessageCount += row.message_count

        accumulateUsageBucket(aggregate.byModel, row.model, row)
        accumulateUsageBucket(aggregate.byRole, row.role as LoopSessionUsageRow['role'], row)
      }

      return aggregate
    },

    listSessionUsage(projectId: string, loopName: string): LoopSessionUsageRow[] {
      const rows = listSessionUsageStmt.all(projectId, loopName) as LoopSessionUsageRowRaw[]
      return rows.map(mapRow)
    },

    hasSession(projectId: string, loopName: string, sessionId: string): boolean {
      const result = hasSessionStmt.get(projectId, loopName, sessionId)
      return result !== undefined && result !== null
    },

    deleteLoop(projectId: string, loopName: string): void {
      deleteLoopStmt.run(projectId, loopName)
    },
  }
}
