import type { Logger, LoopSandboxSettings } from '../types'
import type { LoopState } from '../loop/state'
import type { GitService } from '../utils/git-service'
import type { ArchitectAutoPlanner } from './architect-auto-planner'
import type { GoalChunkRow, GoalRow, GoalsRepo } from '../storage/repos/goals-repo'
import { GOAL_CHUNK_SUMMARY_MAX_CHARS, GOAL_COMPLETE_MARKER, goalPlanningDir } from '../constants/goal'
import { classifyArchitectOutput } from '../utils/architect-auto-output'
import { processShared } from '../utils/process-shared'

/**
 * The launch settings a chunk loop starts with, snapshotted from the goal so
 * every chunk of one goal runs with the same models, variants, sandbox, and
 * iteration cap.
 */
export interface GoalStartLoopInput {
  plannerSessionId: string
  projectDir: string
  hostSessionId: string
  baseRef: string
  executionModel?: string
  auditorModel?: string
  executionVariant?: string
  auditorVariant?: string
  sandbox?: LoopSandboxSettings
  maxIterations?: number
}

export type GoalStartLoopResult =
  | { ok: true; loopName: string; branch: string | null; title: string | null }
  | { ok: false; error: string }

/** Dependencies of the goal orchestrator, injected so the runtime can be tested in isolation. */
export interface GoalOrchestratorDeps {
  projectId: string
  dataDir: string
  goalsRepo: GoalsRepo
  planner: ArchitectAutoPlanner
  git: GitService
  getLoopState(loopName: string): LoopState | null
  startLoop(input: GoalStartLoopInput): Promise<GoalStartLoopResult>
  cancelLoop(loopName: string): Promise<void>
  deleteSession(sessionId: string, directory: string): Promise<void>
  deletePlanForSession(sessionId: string): void
  removeCheckout(projectDir: string, dir: string): Promise<void>
  logger: Logger
  onChange?(goalId: string): void
}

/**
 * Drives a goal's sequential chunk loops. When a chunk's loop settles as
 * completed the orchestrator plans the next chunk in a detached checkout and
 * launches it from that exact commit; the planner may instead declare the goal
 * complete. Every failure pauses the goal — nothing is retried automatically,
 * and recovery is an explicit restart.
 */
export interface GoalOrchestrator {
  /** Handles a settled loop: advances the goal when its chunk loop completed, otherwise pauses it. */
  onLoopSettled(loopName: string): Promise<void>
  /** Handles a planner session going idle: launches the chunk, declares the goal complete, or abandons the plan. */
  onPlannerIdle(sessionId: string): Promise<void>
  /** User-facing recovery: cleans a stale planning chunk or resumes a paused goal. Returns a status message. */
  restart(goalId: string, opts?: { maxChunks?: number; force?: boolean }): Promise<string>
  /** Cancels a goal, cleaning up planning chunks and optionally cancelling running loops. Returns a status message. */
  cancel(goalId: string, opts?: { cancelRunningLoops?: boolean }): Promise<string>
}

/** Builds the planner prompt for the next chunk of a goal. */
export function buildGoalChunkPlannerPrompt(input: {
  goal: GoalRow
  completedChunks: GoalChunkRow[]
  chunkIndex: number
}): string {
  const { goal, completedChunks, chunkIndex } = input
  const lines: string[] = []
  lines.push(`You are planning chunk ${chunkIndex + 1} of a multi-chunk goal.`)
  lines.push('')
  lines.push(
    "The checkout already contains the work of every completed chunk: each completed chunk's commits are visible in `git log`, and the working tree is the tip of the previous chunk's branch.",
  )
  lines.push('')
  lines.push(`Goal: ${goal.title}`)
  lines.push(`Objective: ${goal.objective}`)
  lines.push('')
  if (goal.tasks.length > 0) {
    lines.push('Ordered task list:')
    for (const task of goal.tasks) {
      const ref = task.ref ? `[${task.ref}] ` : ''
      const details = task.details ? ` — ${task.details}` : ''
      lines.push(`- ${ref}${task.title}${details}`)
    }
  } else {
    lines.push('This goal has no ordered task list. Plan the next coherent chunk of work toward the objective.')
  }
  lines.push('')
  if (completedChunks.length > 0) {
    lines.push('Completed chunks:')
    completedChunks.forEach((chunk, index) => {
      const label = chunk.title ?? chunk.loopName ?? `chunk ${chunk.chunkIndex + 1}`
      const branch = chunk.branch ?? '(no branch)'
      const summary = chunk.summary ? ` — ${chunk.summary.slice(0, GOAL_CHUNK_SUMMARY_MAX_CHARS)}` : ''
      lines.push(`${index + 1}. ${label} (branch ${branch})${summary}`)
    })
  } else {
    lines.push('No chunks have completed yet.')
  }
  lines.push('')
  lines.push('Instructions:')
  lines.push('- Determine which tasks remain from the completed chunks and the current code.')
  lines.push('- Plan exactly the next remaining task — one task per chunk — and reference its ref in the Objective.')
  lines.push('- Without a task list, plan the next coherent chunk of work toward the objective.')
  lines.push('- Never modify tickets or issues in any external tracker.')
  lines.push(
    `- If the objective is fully accomplished and no task remains, output exactly one line: \`${GOAL_COMPLETE_MARKER} <one-sentence justification>\` and write no plan.`,
  )
  lines.push('- Otherwise, write the stored plan for this chunk per your schema.')
  return lines.join('\n')
}

const goalPlanningInFlight = processShared('goal-planning-inflight.v1', () => new Set<string>())

function inflightKey(projectId: string, goalId: string, chunkIndex: number): string {
  return `${projectId}\u0000${goalId}\u0000${chunkIndex}`
}

export function createGoalOrchestrator(deps: GoalOrchestratorDeps): GoalOrchestrator {
  const {
    projectId,
    dataDir,
    goalsRepo,
    planner,
    git,
    getLoopState,
    startLoop,
    cancelLoop,
    deleteSession,
    deletePlanForSession,
    removeCheckout,
    logger,
    onChange,
  } = deps

  function findChunk(goalId: string, chunkIndex: number): GoalChunkRow | null {
    return goalsRepo.listChunks(projectId, goalId).find((chunk) => chunk.chunkIndex === chunkIndex) ?? null
  }

  function pauseGoal(goalId: string, error: string): void {
    goalsRepo.updateStatus(projectId, goalId, ['running'], 'paused', { error })
    onChange?.(goalId)
  }

  async function cleanupPlanningResources(chunk: GoalChunkRow, goal: GoalRow): Promise<void> {
    goalPlanningInFlight.delete(inflightKey(projectId, chunk.goalId, chunk.chunkIndex))
    if (chunk.plannerSessionId) {
      const directory = chunk.planningDir ?? goal.projectDir ?? ''
      try {
        await deleteSession(chunk.plannerSessionId, directory)
      } catch (err) {
        logger.error('goal-orchestrator: failed to delete planner session', err as Error)
      }
      try {
        deletePlanForSession(chunk.plannerSessionId)
      } catch (err) {
        logger.error('goal-orchestrator: failed to delete planner session plan row', err as Error)
      }
    }
    if (chunk.planningDir) {
      try {
        await removeCheckout(goal.projectDir ?? '', chunk.planningDir)
      } catch (err) {
        logger.error('goal-orchestrator: failed to remove planning checkout', err as Error)
      }
    }
  }

  async function discardPlanning(chunk: GoalChunkRow, goal: GoalRow): Promise<void> {
    await cleanupPlanningResources(chunk, goal)
    goalsRepo.deleteChunk(projectId, chunk.goalId, chunk.chunkIndex)
  }

  async function abandonPlanning(chunk: GoalChunkRow, reason: string): Promise<void> {
    const goal = goalsRepo.getGoal(projectId, chunk.goalId)
    if (!goal) return
    await discardPlanning(chunk, goal)
    pauseGoal(chunk.goalId, reason)
  }

  async function advance(goalId: string): Promise<void> {
    const goal = goalsRepo.getGoal(projectId, goalId)
    if (!goal || goal.status !== 'running') return
    if (!goal.projectDir) {
      pauseGoal(goalId, 'Goal has no project directory recorded. Restart the goal to recover.')
      return
    }

    const chunks = goalsRepo.listChunks(projectId, goalId)
    if (chunks.some((chunk) => chunk.stage === 'planning' || chunk.stage === 'launching' || chunk.stage === 'running')) {
      return
    }

    const nextIndex = chunks.length
    if (nextIndex >= goal.maxChunks) {
      pauseGoal(goalId, `Reached the chunk limit (${goal.maxChunks}). Raise it with goal-status restart and maxChunks to continue.`)
      return
    }

    const completed = chunks.filter((chunk) => chunk.stage === 'completed').sort((a, b) => a.chunkIndex - b.chunkIndex)
    const previous = completed.at(-1)
    if (!previous || !previous.branch) {
      pauseGoal(goalId, `Chunk ${(previous?.chunkIndex ?? nextIndex - 1) + 1} has no branch to base the next chunk on. Restart the goal after fixing it.`)
      return
    }

    const parsed = git.revParse(goal.projectDir, previous.branch)
    if (!parsed.ok) {
      pauseGoal(goalId, `Could not resolve branch "${previous.branch}" for chunk ${previous.chunkIndex + 1}. Restart the goal after fixing it.`)
      return
    }
    const baseCommit = parsed.stdout.trim()

    const planningDir = goalPlanningDir(dataDir, goalId, nextIndex)
    if (!goalsRepo.insertPlanningChunk(projectId, goalId, nextIndex, { planningDir, baseCommit })) return
    const chunk = findChunk(goalId, nextIndex)
    if (!chunk) return

    try {
      await removeCheckout(goal.projectDir, planningDir)
      const added = git.worktreeAddDetached(goal.projectDir, planningDir, baseCommit)
      if (!added.ok) {
        await abandonPlanning(
          chunk,
          `Could not create the planning checkout for chunk ${nextIndex + 1}: ${added.stderr.trim() || 'git worktree add failed'}`,
        )
        return
      }

      const { sessionId } = await planner.spawn({
        title: `Goal ${goal.title}: plan chunk ${nextIndex + 1}`,
        prompt: buildGoalChunkPlannerPrompt({ goal, completedChunks: completed, chunkIndex: nextIndex }),
        directory: planningDir,
        model: goal.auditorModel ?? undefined,
        variant: goal.auditorVariant ?? undefined,
      })
      goalsRepo.setChunkPlanner(projectId, goalId, nextIndex, sessionId)
      goalPlanningInFlight.add(inflightKey(projectId, goalId, nextIndex))
      onChange?.(goalId)
    } catch (err) {
      await abandonPlanning(chunk, `Could not start planning chunk ${nextIndex + 1}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function onLoopSettled(loopName: string): Promise<void> {
    const chunk = goalsRepo.getChunkByLoopName(projectId, loopName)
    if (!chunk || chunk.stage !== 'running') return
    const goal = goalsRepo.getGoal(projectId, chunk.goalId)
    if (!goal) return
    if (goal.status !== 'running' && goal.status !== 'paused') return

    const state = getLoopState(loopName)
    if (!state || state.status !== 'completed') {
      const status = state?.status ?? 'missing'
      const reason = state?.terminationReason ?? 'unknown'
      pauseGoal(
        chunk.goalId,
        `Chunk ${chunk.chunkIndex + 1} loop ${loopName} ended ${status} (${reason}). Restart it with loop-status restart=true; the goal resumes when it completes.`,
      )
      return
    }

    const rawSummary = state.completionSummary ?? state.postActionReport ?? null
    const summary = rawSummary ? rawSummary.slice(0, GOAL_CHUNK_SUMMARY_MAX_CHARS) : null
    if (!goalsRepo.completeChunk(projectId, chunk.goalId, chunk.chunkIndex, summary)) return

    if (goal.status === 'paused') {
      goalsRepo.updateStatus(projectId, chunk.goalId, ['paused'], 'running', { error: null })
    }
    onChange?.(chunk.goalId)
    await advance(chunk.goalId)
  }

  async function onPlannerIdle(sessionId: string): Promise<void> {
    const chunk = goalsRepo.getChunkByPlannerSession(projectId, sessionId)
    if (!chunk || chunk.stage !== 'planning') return
    const goal = goalsRepo.getGoal(projectId, chunk.goalId)
    if (!goal) return
    if (goal.status !== 'running') return

    const planningDir = chunk.planningDir ?? goalPlanningDir(dataDir, chunk.goalId, chunk.chunkIndex)
    const text = await planner.latestAssistantText(sessionId, planningDir)

    if (text !== null && text.includes(GOAL_COMPLETE_MARKER)) {
      await cleanupPlanningResources(chunk, goal)
      goalsRepo.deleteChunk(projectId, chunk.goalId, chunk.chunkIndex)
      goalsRepo.updateStatus(projectId, chunk.goalId, ['running'], 'completed', { error: null, completedAt: Date.now() })
      onChange?.(chunk.goalId)
      return
    }

    const readiness = await planner.capturePlan(sessionId, planningDir)
    if (text === null) {
      if (!readiness.ready) return
    } else if (!readiness.ready) {
      const classified = classifyArchitectOutput(text)
      const reason = classified.kind === 'insufficient' ? classified.reason : readiness.reason
      await abandonPlanning(chunk, `Planner could not plan chunk ${chunk.chunkIndex + 1}: ${reason}`)
      return
    }

    const claimed = goalsRepo.claimChunkStage(projectId, chunk.goalId, chunk.chunkIndex, 'planning', 'launching')
    if (!claimed) return

    const result = await startLoop({
      plannerSessionId: sessionId,
      projectDir: goal.projectDir ?? '',
      hostSessionId: goal.hostSessionId,
      baseRef: chunk.baseCommit ?? '',
      executionModel: goal.executionModel ?? undefined,
      auditorModel: goal.auditorModel ?? undefined,
      executionVariant: goal.executionVariant ?? undefined,
      auditorVariant: goal.auditorVariant ?? undefined,
      sandbox: goal.sandboxSettings ?? undefined,
      maxIterations: goal.maxIterations ?? undefined,
    })

    if (!result.ok) {
      await abandonPlanning(chunk, result.error)
      return
    }

    const marked = goalsRepo.markChunkRunning(projectId, chunk.goalId, chunk.chunkIndex, {
      loopName: result.loopName,
      branch: result.branch,
      title: result.title,
    })
    if (!marked) {
      try {
        await cancelLoop(result.loopName)
      } catch (err) {
        logger.error('goal-orchestrator: failed to cancel orphaned chunk loop', err as Error)
      }
    }
    await cleanupPlanningResources(chunk, goal)
    onChange?.(chunk.goalId)
  }

  async function restart(goalId: string, opts?: { maxChunks?: number; force?: boolean }): Promise<string> {
    const goal = goalsRepo.getGoal(projectId, goalId)
    if (!goal) return `Goal ${goalId} not found.`
    if (goal.status !== 'running' && goal.status !== 'paused') {
      return `Goal ${goalId} is ${goal.status}; only a running or paused goal can be restarted.`
    }

    if (opts?.maxChunks !== undefined) {
      goalsRepo.setMaxChunks(projectId, goalId, opts.maxChunks)
    }

    const chunks = goalsRepo.listChunks(projectId, goalId)
    const planningChunk = chunks.find((chunk) => chunk.stage === 'planning' || chunk.stage === 'launching')
    if (planningChunk) {
      if (goalPlanningInFlight.has(inflightKey(projectId, goalId, planningChunk.chunkIndex)) && !opts?.force) {
        return `Chunk ${planningChunk.chunkIndex + 1} is still being planned.`
      }
      await discardPlanning(planningChunk, goal)
      onChange?.(goalId)
    }

    const runningChunk = chunks.find((chunk) => chunk.stage === 'running' && chunk.loopName)
    if (runningChunk && runningChunk.loopName) {
      const state = getLoopState(runningChunk.loopName)
      if (state?.status === 'running') {
        return `Chunk ${runningChunk.chunkIndex + 1} loop ${runningChunk.loopName} is running; the goal continues when it completes.`
      }
      if (state?.status === 'completed') {
        await onLoopSettled(runningChunk.loopName)
        return `Chunk ${runningChunk.chunkIndex + 1} loop ${runningChunk.loopName} already completed; the goal advanced.`
      }
      return `Chunk ${runningChunk.chunkIndex + 1} loop ${runningChunk.loopName} is ${state?.status ?? 'missing'}. Restart it with loop-status restart=true; the goal resumes when it completes.`
    }

    const resumed = goal.status === 'paused'
    if (resumed) {
      goalsRepo.updateStatus(projectId, goalId, ['paused'], 'running', { error: null })
    }
    await advance(goalId)

    const after = goalsRepo.getGoal(projectId, goalId)
    if (after?.status === 'paused') {
      return `Goal ${goalId} is paused: ${after.error ?? 'unknown reason'}`
    }
    return resumed ? `Goal ${goalId} resumed.` : `Goal ${goalId} restarted.`
  }

  async function cancel(goalId: string, opts?: { cancelRunningLoops?: boolean }): Promise<string> {
    const goal = goalsRepo.getGoal(projectId, goalId)
    const result = goalsRepo.cancelGoal(projectId, goalId)
    if (!result.cancelled) return `Goal ${goalId} is not cancellable.`

    const parts = [`Goal ${goalId} cancelled.`]

    for (const chunk of result.planningChunks) {
      if (goal) {
        await cleanupPlanningResources(chunk, goal)
      } else {
        goalPlanningInFlight.delete(inflightKey(projectId, chunk.goalId, chunk.chunkIndex))
      }
    }
    if (result.planningChunks.length > 0) {
      parts.push(`Cleaned up ${result.planningChunks.length} planning chunk(s).`)
    }

    if (opts?.cancelRunningLoops && result.runningLoopNames.length > 0) {
      for (const loopName of result.runningLoopNames) {
        try {
          await cancelLoop(loopName)
        } catch (err) {
          logger.error(`goal-orchestrator: failed to cancel loop ${loopName}`, err as Error)
        }
      }
      parts.push(`Cancelled ${result.runningLoopNames.length} running loop(s).`)
    }

    onChange?.(goalId)
    return parts.join(' ')
  }

  return { onLoopSettled, onPlannerIdle, restart, cancel }
}
