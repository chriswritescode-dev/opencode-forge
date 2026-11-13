import type { Database } from 'bun:sqlite'
import { z } from 'zod'

const sessionUsageRoleSchema = z.enum(['code', 'auditor', 'unknown'])

const loopSessionUsageRowSchema = z.object({
  project_id: z.string(),
  loop_name: z.string(),
  session_id: z.string(),
  role: sessionUsageRoleSchema,
  model: z.string(),
  cost: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  message_count: z.number(),
  captured_at: z.number(),
})
const loopSessionUsageRowsSchema = z.array(loopSessionUsageRowSchema)

const aggregateGroupRowSchema = z.object({
  role: sessionUsageRoleSchema,
  model: z.string(),
  cost: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  message_count: z.number(),
})
const aggregateGroupRowsSchema = z.array(aggregateGroupRowSchema)

const loopCostRowSchema = z.object({ loop_name: z.string(), cost: z.number() })
const loopCostRowsSchema = z.array(loopCostRowSchema)

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
  totalCostsByLoop(projectId: string): Map<string, number>
  listSessionUsage(projectId: string, loopName: string): LoopSessionUsageRow[]
  hasSession(projectId: string, loopName: string, sessionId: string): boolean
  deleteLoop(projectId: string, loopName: string): void
}

type UsageBucket = LoopUsageAggregate['byModel'][string]

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
  row: z.infer<typeof aggregateGroupRowSchema>,
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

function mapRow(row: z.infer<typeof loopSessionUsageRowSchema>): LoopSessionUsageRow {
  return {
    projectId: row.project_id,
    loopName: row.loop_name,
    sessionId: row.session_id,
    role: row.role,
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

  const totalCostsByLoopStmt = db.prepare(`
    SELECT loop_name, SUM(cost) AS cost
    FROM loop_session_usage
    WHERE project_id = ?
    GROUP BY loop_name
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
      const rows = aggregateGroupRowsSchema.parse(getAggregateStmt.all(projectId, loopName))

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
        accumulateUsageBucket(aggregate.byRole, row.role, row)
      }

      return aggregate
    },

    totalCostsByLoop(projectId: string): Map<string, number> {
      const rows = loopCostRowsSchema.parse(totalCostsByLoopStmt.all(projectId))
      return new Map(rows.map((row) => [row.loop_name, row.cost]))
    },

    listSessionUsage(projectId: string, loopName: string): LoopSessionUsageRow[] {
      const rows = loopSessionUsageRowsSchema.parse(listSessionUsageStmt.all(projectId, loopName))
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
