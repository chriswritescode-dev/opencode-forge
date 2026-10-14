import { join } from 'path'
import { forgeWorktreesRoot } from '../workspace/forge-naming'

/** Default cap on how many chunks a single goal may run before it stops launching more. */
export const DEFAULT_GOAL_MAX_CHUNKS = 20

/** Hard upper bound for the `maxChunks` argument of a goal. */
export const MAX_GOAL_MAX_CHUNKS = 100

/**
 * Marker a chunk planner emits instead of a plan to declare the goal fully
 * accomplished. Detected on its own line, followed by a one-sentence justification.
 */
export const GOAL_COMPLETE_MARKER = '<!-- forge-goal:complete -->'

/** Cap on the completed-chunk summary carried into a later chunk's planner prompt. */
export const GOAL_CHUNK_SUMMARY_MAX_CHARS = 2000

/**
 * Detached, read-only planning checkout for one chunk. The leading dot keeps it
 * from ever colliding with a loop worktree slug, and keeping it under the
 * worktrees root means a plugin instance spawned there is treated as a child
 * forge-worktree instance rather than a second owner of the project.
 */
export function goalPlanningDir(dataDir: string, goalId: string, chunkIndex: number): string {
  return join(forgeWorktreesRoot(dataDir), `.goal-plan-${goalId}-${chunkIndex}`)
}
