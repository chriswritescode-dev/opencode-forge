import type { GoalChunkStage } from '../storage/repos/goals-repo'

/**
 * Chunk stages in which a goal has an active (current) chunk: the chunk is
 * being planned, is being launched, or its loop is running. A completed or
 * cancelled chunk is never current.
 */
export const GOAL_ACTIVE_CHUNK_STAGES: readonly GoalChunkStage[] = ['planning', 'launching', 'running']

interface GoalChunkStageCarrier {
  stage: GoalChunkStage
}

/**
 * The goal's current chunk: the first chunk in an active stage, or null when
 * every chunk is terminal (completed or cancelled). Single owner of the
 * "active chunk" rule shared by the goal tools and the dashboard.
 */
export function findCurrentGoalChunk<T extends GoalChunkStageCarrier>(chunks: readonly T[]): T | null {
  return chunks.find((chunk) => GOAL_ACTIVE_CHUNK_STAGES.includes(chunk.stage)) ?? null
}
