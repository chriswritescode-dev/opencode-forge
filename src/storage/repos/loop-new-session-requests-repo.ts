import type { Database } from 'bun:sqlite'

/**
 * Staged plan text for a cross-process `plan.execute.newSession` launch. The
 * TUI writes the row — keyed by the same per-launch request_nonce used by
 * outcomes/cancellations — into the shared Forge DB BEFORE dispatching the
 * host-agent instruction, so the host LLM passes only the nonce instead of
 * re-emitting the plan verbatim; the server-side execute-plan tool reads the
 * plan back by nonce. Decoupled from loop lifecycle (no FK) and pruned by the
 * TTL sweep.
 */
export interface LoopNewSessionRequestsRepo {
  /** Stage (idempotently on the primary key) the full plan text for this
   *  launch's nonce. Re-staging the same nonce simply overwrites the prior
   *  `plan_text` and `created_at`, so re-issuing the stage after a transient
   *  write failure is safe. */
  stagePlan(row: { projectId: string; requestNonce: string; planText: string }): void
  /** The lookup the server-side execute-plan tool consults: returns the staged
   *  plan text for this nonce, or null when nothing was staged. */
  findPlan(projectId: string, requestNonce: string): string | null
}

export function createLoopNewSessionRequestsRepo(db: Database): LoopNewSessionRequestsRepo {
  const stmtInsert = db.prepare(`
    INSERT INTO loop_new_session_requests
      (project_id, request_nonce, plan_text, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, request_nonce) DO UPDATE SET
      plan_text = excluded.plan_text,
      created_at = excluded.created_at
  `)

  const stmtFind = db.prepare(`
    SELECT plan_text
    FROM loop_new_session_requests
    WHERE project_id = ? AND request_nonce = ?
  `)

  return {
    stagePlan(row) {
      stmtInsert.run(row.projectId, row.requestNonce, row.planText, Date.now())
    },
    findPlan(projectId, requestNonce) {
      const row = stmtFind.get(projectId, requestNonce) as { plan_text: string } | undefined
      return row ? row.plan_text : null
    },
  }
}
