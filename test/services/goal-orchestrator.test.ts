import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { createGoalsRepo } from '../../src/storage/repos/goals-repo'
import type { GoalLaunchSnapshot, GoalTask } from '../../src/storage/repos/goals-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import {
  createGoalOrchestrator,
  buildGoalChunkPlannerPrompt,
  type GoalOrchestratorDeps,
  type GoalStartLoopInput,
  type GoalStartLoopResult,
} from '../../src/services/goal-orchestrator'
import type { ArchitectAutoPlanner, ArchitectAutoSpawnInput } from '../../src/services/architect-auto-planner'
import { GOAL_CHUNK_SUMMARY_MAX_CHARS, GOAL_COMPLETE_MARKER, goalPlanningDir } from '../../src/constants/goal'
import { processShared } from '../../src/utils/process-shared'
import type { LoopState } from '../../src/loop/state'
import type { Logger } from '../../src/types'
import { createFakeGitService } from '../helpers/fake-git'
import { setupLoopsTestDb } from '../helpers/test-db'

const PROJECT = 'test-project'
const HOST = 'host-session'
const GOAL = 'goal-1'
const DATA_DIR = '/tmp/goal-data'
const PROJECT_DIR = '/tmp/goal-project'

const TASKS: GoalTask[] = [
  { ref: 'GH-1', title: 'First ticket', details: 'do the first thing' },
  { title: 'Second ticket' },
]

const SNAPSHOT: GoalLaunchSnapshot = {
  projectDir: PROJECT_DIR,
  executionModel: 'provider/exec',
  auditorModel: 'provider/audit',
  executionVariant: 'high',
  auditorVariant: 'low',
  sandboxSettings: { enabled: true },
  maxIterations: 7,
}

const silentLogger: Logger = { log: () => {}, error: () => {}, debug: () => {} }

function loopState(overrides: Partial<LoopState> & { status: LoopState['status'] }): LoopState {
  return {
    active: false,
    sessionId: 'ses-loop',
    loopName: 'chunk-0-loop',
    worktreeDir: '/tmp/wt',
    iteration: 1,
    maxIterations: 10,
    startedAt: new Date().toISOString(),
    errorCount: 0,
    auditCount: 0,
    currentSectionIndex: 0,
    totalSections: 0,
    phase: 'coding',
    ...overrides,
  } as LoopState
}

function createHarness(overrides: Partial<GoalOrchestratorDeps> = {}) {
  const db = new Database(':memory:')
  setupLoopsTestDb(db)
  const goalsRepo = createGoalsRepo(db)
  const plansRepo = createPlansRepo(db)
  const git = createFakeGitService({
    revParse: vi.fn(() => ({ ok: true, status: 0, stdout: 'resolved-base-commit\n', stderr: '' })),
    worktreeAddDetached: vi.fn(() => ({ ok: true, status: 0, stdout: '', stderr: '' })),
  })

  const loopStates = new Map<string, LoopState | null>()
  const spawnCalls: ArchitectAutoSpawnInput[] = []
  let spawnCounter = 0

  const planner: ArchitectAutoPlanner = {
    spawn: vi.fn(async (input: ArchitectAutoSpawnInput) => {
      spawnCalls.push(input)
      spawnCounter += 1
      return { sessionId: `planner-session-${spawnCounter}` }
    }),
    capturePlan: vi.fn(async () => ({ ready: true as const })),
    latestAssistantText: vi.fn(async () => null),
  }

  const startLoop = vi.fn(
    async (_input: GoalStartLoopInput): Promise<GoalStartLoopResult> => ({
      ok: true,
      loopName: 'chunk-1-loop',
      branch: 'forge/chunk-1',
      title: 'Chunk 1',
    }),
  )
  const cancelLoop = vi.fn(async (_loopName: string) => {})
  const deleteSession = vi.fn(async (_sessionId: string, _directory: string) => {})
  const deletePlanForSession = vi.fn((sessionId: string) => {
    plansRepo.deleteForSession(PROJECT, sessionId)
  })
  const removeCheckout = vi.fn(async (_projectDir: string, _dir: string) => {})

  const orchestrator = createGoalOrchestrator({
    projectId: PROJECT,
    dataDir: DATA_DIR,
    goalsRepo,
    planner,
    git,
    getLoopState: (loopName) => loopStates.get(loopName) ?? null,
    startLoop,
    cancelLoop,
    deleteSession,
    deletePlanForSession,
    removeCheckout,
    logger: silentLogger,
    ...overrides,
  })

  function seedRunningGoal(opts: { maxChunks?: number; tasks?: GoalTask[] } = {}) {
    const goal = goalsRepo.saveDraft({
      projectId: PROJECT,
      goalId: GOAL,
      title: 'Ship it',
      objective: 'Deliver the whole feature',
      tasks: opts.tasks ?? TASKS,
      hostSessionId: HOST,
      maxChunks: opts.maxChunks ?? 3,
    })
    goalsRepo.attachFirstChunk(PROJECT, HOST, SNAPSHOT, {
      loopName: 'chunk-0-loop',
      branch: 'forge/chunk-0',
      title: 'Chunk 0',
      baseCommit: 'sha-0',
    })
    return goal
  }

  return {
    db,
    goalsRepo,
    plansRepo,
    git,
    planner,
    startLoop,
    cancelLoop,
    deleteSession,
    deletePlanForSession,
    removeCheckout,
    loopStates,
    orchestrator,
    spawnCalls,
    seedRunningGoal,
  }
}

const inflight = processShared('goal-planning-inflight.v1', () => new Set<string>())

describe('createGoalOrchestrator', () => {
  let h: ReturnType<typeof createHarness>

  beforeEach(() => {
    inflight.clear()
  })

  afterEach(() => {
    h.db.close()
  })

  describe('onLoopSettled', () => {
    test('completes the chunk and starts planning the next one from the completed branch', async () => {
      h = createHarness()
      h.seedRunningGoal()
      h.loopStates.set('chunk-0-loop', loopState({ status: 'completed', completionSummary: 'chunk zero done' }))

      await h.orchestrator.onLoopSettled('chunk-0-loop')

      const chunks = h.goalsRepo.listChunks(PROJECT, GOAL)
      expect(chunks).toHaveLength(2)
      expect(chunks[0].stage).toBe('completed')
      expect(chunks[0].summary).toBe('chunk zero done')
      expect(chunks[1].stage).toBe('planning')
      expect(chunks[1].baseCommit).toBe('resolved-base-commit')
      expect(chunks[1].planningDir).toBe(goalPlanningDir(DATA_DIR, GOAL, 1))

      expect(vi.mocked(h.git.revParse)).toHaveBeenCalledWith(PROJECT_DIR, 'forge/chunk-0')
      expect(vi.mocked(h.git.worktreeAddDetached)).toHaveBeenCalledWith(
        PROJECT_DIR,
        goalPlanningDir(DATA_DIR, GOAL, 1),
        'resolved-base-commit',
      )

      expect(h.spawnCalls).toHaveLength(1)
      expect(h.spawnCalls[0].directory).toBe(goalPlanningDir(DATA_DIR, GOAL, 1))
      expect(h.spawnCalls[0].model).toBe('provider/audit')
      expect(h.spawnCalls[0].variant).toBe('low')
      expect(h.spawnCalls[0].title).toBe('Goal Ship it: plan chunk 2')
      expect(h.spawnCalls[0].prompt).toContain('chunk 2 of a multi-chunk goal')
      expect(h.spawnCalls[0].prompt).toContain('Deliver the whole feature')
      expect(h.spawnCalls[0].prompt).toContain('[GH-1] First ticket')
      expect(h.spawnCalls[0].prompt).toContain('chunk zero done')

      expect(chunks[1].plannerSessionId).toBe('planner-session-1')
      expect(inflight.has(`${PROJECT}\u0000${GOAL}\u00001`)).toBe(true)
    })

    test('truncates a long completion summary to the chunk summary cap', async () => {
      h = createHarness()
      h.seedRunningGoal()
      h.loopStates.set(
        'chunk-0-loop',
        loopState({ status: 'completed', completionSummary: 'x'.repeat(GOAL_CHUNK_SUMMARY_MAX_CHARS + 500) }),
      )

      await h.orchestrator.onLoopSettled('chunk-0-loop')

      expect(h.goalsRepo.listChunks(PROJECT, GOAL)[0].summary).toHaveLength(GOAL_CHUNK_SUMMARY_MAX_CHARS)
    })

    test('falls back to the post-action report when no completion summary exists', async () => {
      h = createHarness()
      h.seedRunningGoal()
      h.loopStates.set('chunk-0-loop', loopState({ status: 'completed', postActionReport: 'post action report' }))

      await h.orchestrator.onLoopSettled('chunk-0-loop')

      expect(h.goalsRepo.listChunks(PROJECT, GOAL)[0].summary).toBe('post action report')
    })

    test('pauses the goal with a restart hint when the chunk loop did not complete', async () => {
      h = createHarness()
      h.seedRunningGoal()
      h.loopStates.set(
        'chunk-0-loop',
        loopState({ status: 'errored', terminationReason: 'stall_timeout' }),
      )

      await h.orchestrator.onLoopSettled('chunk-0-loop')

      const goal = h.goalsRepo.getGoal(PROJECT, GOAL)
      expect(goal?.status).toBe('paused')
      expect(goal?.error).toContain('ended errored')
      expect(goal?.error).toContain('stall_timeout')
      expect(goal?.error).toContain('loop-status restart=true')
      expect(h.goalsRepo.listChunks(PROJECT, GOAL)).toHaveLength(1)
    })

    test('pauses when the loop state is missing', async () => {
      h = createHarness()
      h.seedRunningGoal()

      await h.orchestrator.onLoopSettled('chunk-0-loop')

      const goal = h.goalsRepo.getGoal(PROJECT, GOAL)
      expect(goal?.status).toBe('paused')
      expect(goal?.error).toContain('ended missing')
    })

    test('is a no-op for an unknown loop', async () => {
      h = createHarness()
      h.seedRunningGoal()

      await h.orchestrator.onLoopSettled('not-a-loop')

      expect(h.goalsRepo.getGoal(PROJECT, GOAL)?.status).toBe('running')
      expect(h.goalsRepo.listChunks(PROJECT, GOAL)).toHaveLength(1)
      expect(h.startLoop).not.toHaveBeenCalled()
    })

    test('is a no-op when the chunk is not running', async () => {
      h = createHarness()
      h.seedRunningGoal()
      h.goalsRepo.completeChunk(PROJECT, GOAL, 0, 'already done')
      h.loopStates.set('chunk-0-loop', loopState({ status: 'completed', completionSummary: 'ignored' }))

      await h.orchestrator.onLoopSettled('chunk-0-loop')

      expect(h.goalsRepo.listChunks(PROJECT, GOAL)).toHaveLength(1)
      expect(vi.mocked(h.git.revParse)).not.toHaveBeenCalled()
    })

    test('resumes a paused goal when its completed chunk settles', async () => {
      h = createHarness()
      h.seedRunningGoal()
      h.goalsRepo.updateStatus(PROJECT, GOAL, ['running'], 'paused', { error: 'paused earlier' })
      h.loopStates.set('chunk-0-loop', loopState({ status: 'completed', completionSummary: 'done' }))

      await h.orchestrator.onLoopSettled('chunk-0-loop')

      const goal = h.goalsRepo.getGoal(PROJECT, GOAL)
      expect(goal?.status).toBe('running')
      expect(goal?.error).toBeNull()
      expect(h.goalsRepo.listChunks(PROJECT, GOAL)[1].stage).toBe('planning')
    })

    test('pauses at the chunk limit instead of planning another chunk', async () => {
      h = createHarness()
      h.seedRunningGoal({ maxChunks: 1 })
      h.loopStates.set('chunk-0-loop', loopState({ status: 'completed', completionSummary: 'done' }))

      await h.orchestrator.onLoopSettled('chunk-0-loop')

      const goal = h.goalsRepo.getGoal(PROJECT, GOAL)
      expect(goal?.status).toBe('paused')
      expect(goal?.error).toContain('Reached the chunk limit (1)')
      expect(h.goalsRepo.listChunks(PROJECT, GOAL)).toHaveLength(1)
      expect(h.spawnCalls).toHaveLength(0)
    })

    test('pauses when the previous branch cannot be resolved', async () => {
      h = createHarness()
      h.seedRunningGoal()
      vi.mocked(h.git.revParse).mockReturnValue({ ok: false, status: 1, stdout: '', stderr: 'bad ref' })
      h.loopStates.set('chunk-0-loop', loopState({ status: 'completed', completionSummary: 'done' }))

      await h.orchestrator.onLoopSettled('chunk-0-loop')

      const goal = h.goalsRepo.getGoal(PROJECT, GOAL)
      expect(goal?.status).toBe('paused')
      expect(goal?.error).toContain('forge/chunk-0')
      expect(h.goalsRepo.listChunks(PROJECT, GOAL)).toHaveLength(1)
      expect(vi.mocked(h.git.worktreeAddDetached)).not.toHaveBeenCalled()
    })

    test('pauses and discards the chunk when the planning checkout cannot be created', async () => {
      h = createHarness()
      h.seedRunningGoal()
      vi.mocked(h.git.worktreeAddDetached).mockReturnValue({ ok: false, status: 1, stdout: '', stderr: 'boom' })
      h.loopStates.set('chunk-0-loop', loopState({ status: 'completed', completionSummary: 'done' }))

      await h.orchestrator.onLoopSettled('chunk-0-loop')

      const goal = h.goalsRepo.getGoal(PROJECT, GOAL)
      expect(goal?.status).toBe('paused')
      expect(goal?.error).toContain('Could not create the planning checkout')
      expect(h.goalsRepo.listChunks(PROJECT, GOAL)).toHaveLength(1)
    })
  })

  describe('onPlannerIdle', () => {
    async function setupPlanningChunk() {
      h.seedRunningGoal()
      h.loopStates.set('chunk-0-loop', loopState({ status: 'completed', completionSummary: 'done' }))
      await h.orchestrator.onLoopSettled('chunk-0-loop')
      h.plansRepo.writeForSession(PROJECT, 'planner-session-1', '# stored plan')
    }

    test('marks the goal complete when the planner emits the complete marker', async () => {
      h = createHarness()
      await setupPlanningChunk()
      vi.mocked(h.planner.latestAssistantText).mockResolvedValue(`${GOAL_COMPLETE_MARKER} everything shipped`)

      await h.orchestrator.onPlannerIdle('planner-session-1')

      const goal = h.goalsRepo.getGoal(PROJECT, GOAL)
      expect(goal?.status).toBe('completed')
      expect(goal?.completedAt).not.toBeNull()
      expect(h.goalsRepo.listChunks(PROJECT, GOAL)).toHaveLength(1)
      expect(h.deleteSession).toHaveBeenCalledWith('planner-session-1', goalPlanningDir(DATA_DIR, GOAL, 1))
      expect(h.plansRepo.getForSession(PROJECT, 'planner-session-1')).toBeNull()
      expect(h.removeCheckout).toHaveBeenCalledWith(PROJECT_DIR, goalPlanningDir(DATA_DIR, GOAL, 1))
      expect(h.startLoop).not.toHaveBeenCalled()
    })

    test('abandons the chunk and pauses the goal on a premature idle with no text and no stored plan', async () => {
      h = createHarness()
      await setupPlanningChunk()
      vi.mocked(h.planner.latestAssistantText).mockResolvedValue(null)
      vi.mocked(h.planner.capturePlan).mockResolvedValue({ ready: false, reason: 'no plan yet' })

      await h.orchestrator.onPlannerIdle('planner-session-1')

      const goal = h.goalsRepo.getGoal(PROJECT, GOAL)
      expect(goal?.status).toBe('paused')
      expect(goal?.error).toContain('Planner could not plan chunk 2')
      expect(h.goalsRepo.listChunks(PROJECT, GOAL)).toHaveLength(1)
      expect(h.deleteSession).toHaveBeenCalledWith('planner-session-1', goalPlanningDir(DATA_DIR, GOAL, 1))
      expect(h.startLoop).not.toHaveBeenCalled()
    })

    test('launches the next loop from the ready plan with the snapshotted settings', async () => {
      h = createHarness()
      await setupPlanningChunk()
      vi.mocked(h.planner.latestAssistantText).mockResolvedValue('here is the plan')
      vi.mocked(h.planner.capturePlan).mockResolvedValue({ ready: true })

      await h.orchestrator.onPlannerIdle('planner-session-1')

      expect(h.startLoop).toHaveBeenCalledTimes(1)
      const input = h.startLoop.mock.calls[0][0]
      expect(input).toMatchObject({
        plannerSessionId: 'planner-session-1',
        projectDir: PROJECT_DIR,
        hostSessionId: HOST,
        baseRef: 'resolved-base-commit',
        executionModel: 'provider/exec',
        auditorModel: 'provider/audit',
        executionVariant: 'high',
        auditorVariant: 'low',
        sandbox: { enabled: true },
        maxIterations: 7,
      })

      const chunk = h.goalsRepo.listChunks(PROJECT, GOAL)[1]
      expect(chunk.stage).toBe('running')
      expect(chunk.loopName).toBe('chunk-1-loop')
      expect(chunk.branch).toBe('forge/chunk-1')
      expect(chunk.title).toBe('Chunk 1')

      expect(h.deleteSession).toHaveBeenCalledWith('planner-session-1', goalPlanningDir(DATA_DIR, GOAL, 1))
      expect(h.plansRepo.getForSession(PROJECT, 'planner-session-1')).toBeNull()
      expect(h.removeCheckout).toHaveBeenCalledWith(PROJECT_DIR, goalPlanningDir(DATA_DIR, GOAL, 1))
      expect(h.cancelLoop).not.toHaveBeenCalled()
    })

    test('abandons the chunk and pauses the goal when the loop start fails', async () => {
      h = createHarness()
      await setupPlanningChunk()
      vi.mocked(h.planner.latestAssistantText).mockResolvedValue('plan text')
      vi.mocked(h.planner.capturePlan).mockResolvedValue({ ready: true })
      h.startLoop.mockResolvedValue({ ok: false, error: 'loop start exploded' })

      await h.orchestrator.onPlannerIdle('planner-session-1')

      const goal = h.goalsRepo.getGoal(PROJECT, GOAL)
      expect(goal?.status).toBe('paused')
      expect(goal?.error).toBe('loop start exploded')
      expect(h.goalsRepo.listChunks(PROJECT, GOAL)).toHaveLength(1)
      expect(h.removeCheckout).toHaveBeenCalled()
    })

    test('abandons the chunk with the insufficient reason when the planner produced no plan', async () => {
      h = createHarness()
      await setupPlanningChunk()
      vi.mocked(h.planner.latestAssistantText).mockResolvedValue('I cannot plan this')
      vi.mocked(h.planner.capturePlan).mockResolvedValue({ ready: false, reason: 'Stored plan is incomplete' })

      await h.orchestrator.onPlannerIdle('planner-session-1')

      const goal = h.goalsRepo.getGoal(PROJECT, GOAL)
      expect(goal?.status).toBe('paused')
      expect(goal?.error).toContain('Planner could not plan chunk 2')
      expect(goal?.error).toContain('Stored plan is incomplete')
      expect(h.goalsRepo.listChunks(PROJECT, GOAL)).toHaveLength(1)
      expect(h.startLoop).not.toHaveBeenCalled()
    })

    test('cancels the launched loop when the goal was cancelled before the chunk was marked running', async () => {
      h = createHarness()
      await setupPlanningChunk()
      vi.mocked(h.planner.latestAssistantText).mockResolvedValue('plan text')
      vi.mocked(h.planner.capturePlan).mockResolvedValue({ ready: true })
      h.startLoop.mockImplementation(async () => {
        h.goalsRepo.cancelGoal(PROJECT, GOAL)
        return { ok: true, loopName: 'chunk-1-loop', branch: 'forge/chunk-1', title: 'Chunk 1' }
      })

      await h.orchestrator.onPlannerIdle('planner-session-1')

      expect(h.cancelLoop).toHaveBeenCalledWith('chunk-1-loop')
    })

    test('cancels the started loop and pauses when the chunk cannot be marked running', async () => {
      h = createHarness()
      await setupPlanningChunk()
      vi.mocked(h.planner.latestAssistantText).mockResolvedValue('plan text')
      vi.mocked(h.planner.capturePlan).mockResolvedValue({ ready: true })
      vi.spyOn(h.goalsRepo, 'markChunkRunning').mockImplementation(() => {
        throw new Error('UNIQUE constraint failed: goal_chunks.project_id, goal_chunks.loop_name')
      })

      await h.orchestrator.onPlannerIdle('planner-session-1')

      expect(h.cancelLoop).toHaveBeenCalledWith('chunk-1-loop')
      const goal = h.goalsRepo.getGoal(PROJECT, GOAL)
      expect(goal?.status).toBe('paused')
      expect(goal?.error).toContain('Could not record chunk 2 loop chunk-1-loop')
      expect(goal?.error).toContain('UNIQUE constraint failed')
      expect(h.goalsRepo.listChunks(PROJECT, GOAL)).toHaveLength(1)
    })

    test('ignores a planner session that is not in the planning stage', async () => {
      h = createHarness()
      await setupPlanningChunk()
      h.goalsRepo.claimChunkStage(PROJECT, GOAL, 1, 'planning', 'launching')
      vi.mocked(h.planner.latestAssistantText).mockResolvedValue('plan text')

      await h.orchestrator.onPlannerIdle('planner-session-1')

      expect(h.startLoop).not.toHaveBeenCalled()
      expect(vi.mocked(h.planner.latestAssistantText)).not.toHaveBeenCalled()
    })
  })

  describe('onPlannerError', () => {
    async function setupPlanningChunk() {
      h.seedRunningGoal()
      h.loopStates.set('chunk-0-loop', loopState({ status: 'completed', completionSummary: 'done' }))
      await h.orchestrator.onLoopSettled('chunk-0-loop')
      h.plansRepo.writeForSession(PROJECT, 'planner-session-1', '# stored plan')
    }

    test('keeps the planning chunk, session, and checkout and pauses the goal with the planner failure', async () => {
      h = createHarness()
      await setupPlanningChunk()
      h.removeCheckout.mockClear()

      await h.orchestrator.onPlannerError('planner-session-1', 'provider exploded')

      const goal = h.goalsRepo.getGoal(PROJECT, GOAL)
      expect(goal?.status).toBe('paused')
      expect(goal?.error?.startsWith('Planner failed for chunk 2: provider exploded')).toBe(true)
      expect(goal?.error).toContain('planner-session-1')
      expect(goal?.error).toContain(goalPlanningDir(DATA_DIR, GOAL, 1))

      const chunks = h.goalsRepo.listChunks(PROJECT, GOAL)
      expect(chunks).toHaveLength(2)
      expect(chunks[1].stage).toBe('planning')
      expect(chunks[1].plannerSessionId).toBe('planner-session-1')

      expect(h.deleteSession).not.toHaveBeenCalled()
      expect(h.removeCheckout).not.toHaveBeenCalled()
      expect(h.plansRepo.getForSession(PROJECT, 'planner-session-1')).not.toBeNull()
      expect(h.startLoop).not.toHaveBeenCalled()
    })

    test('makes a later idle for the failed planner session a no-op', async () => {
      h = createHarness()
      await setupPlanningChunk()

      await h.orchestrator.onPlannerError('planner-session-1', 'provider exploded')
      vi.mocked(h.planner.latestAssistantText).mockClear()
      await h.orchestrator.onPlannerIdle('planner-session-1')

      expect(h.startLoop).not.toHaveBeenCalled()
      expect(h.planner.latestAssistantText).not.toHaveBeenCalled()
    })

    test('restart discards the kept planning chunk and re-plans it', async () => {
      h = createHarness()
      await setupPlanningChunk()

      await h.orchestrator.onPlannerError('planner-session-1', 'provider exploded')

      await expect(h.orchestrator.restart(GOAL)).resolves.toBe(`Goal ${GOAL} resumed.`)

      expect(h.deleteSession).toHaveBeenCalledWith('planner-session-1', goalPlanningDir(DATA_DIR, GOAL, 1))
      expect(h.removeCheckout).toHaveBeenCalledWith(PROJECT_DIR, goalPlanningDir(DATA_DIR, GOAL, 1))
      expect(h.plansRepo.getForSession(PROJECT, 'planner-session-1')).toBeNull()
      expect(h.goalsRepo.getGoal(PROJECT, GOAL)?.status).toBe('running')

      const chunks = h.goalsRepo.listChunks(PROJECT, GOAL)
      expect(chunks).toHaveLength(2)
      expect(chunks[1].stage).toBe('planning')
      expect(chunks[1].plannerSessionId).toBe('planner-session-2')
    })

    test('cancel cleans up the kept planning chunk', async () => {
      h = createHarness()
      await setupPlanningChunk()

      await h.orchestrator.onPlannerError('planner-session-1', 'provider exploded')

      const message = await h.orchestrator.cancel(GOAL)

      expect(message).toContain('cancelled')
      expect(h.goalsRepo.getGoal(PROJECT, GOAL)?.status).toBe('cancelled')
      expect(h.deleteSession).toHaveBeenCalledWith('planner-session-1', goalPlanningDir(DATA_DIR, GOAL, 1))
      expect(h.removeCheckout).toHaveBeenCalledWith(PROJECT_DIR, goalPlanningDir(DATA_DIR, GOAL, 1))
    })

    test('ignores a session error for a session that is not planning', async () => {
      h = createHarness()
      h.seedRunningGoal()

      await h.orchestrator.onPlannerError('not-a-planner', 'boom')

      expect(h.goalsRepo.getGoal(PROJECT, GOAL)?.status).toBe('running')
      expect(h.goalsRepo.listChunks(PROJECT, GOAL)).toHaveLength(1)
    })
  })

  describe('restart', () => {
    test('reports an in-flight planning chunk and re-plans it under force', async () => {
      h = createHarness()
      h.seedRunningGoal()
      h.loopStates.set('chunk-0-loop', loopState({ status: 'completed', completionSummary: 'done' }))
      await h.orchestrator.onLoopSettled('chunk-0-loop')

      await expect(h.orchestrator.restart(GOAL)).resolves.toBe('Chunk 2 is still being planned.')

      await expect(h.orchestrator.restart(GOAL, { force: true })).resolves.toBe(`Goal ${GOAL} restarted.`)
      const chunks = h.goalsRepo.listChunks(PROJECT, GOAL)
      expect(chunks).toHaveLength(2)
      expect(chunks[1].stage).toBe('planning')
      expect(chunks[1].plannerSessionId).toBe('planner-session-2')
    })

    test('reports a running chunk loop', async () => {
      h = createHarness()
      h.seedRunningGoal()
      h.loopStates.set('chunk-0-loop', loopState({ status: 'running', active: true }))

      await expect(h.orchestrator.restart(GOAL)).resolves.toContain('is running')
    })

    test('catches up a chunk whose loop already completed', async () => {
      h = createHarness()
      h.seedRunningGoal()
      h.loopStates.set('chunk-0-loop', loopState({ status: 'completed', completionSummary: 'done' }))

      const message = await h.orchestrator.restart(GOAL)

      expect(message).toContain('already completed')
      expect(h.goalsRepo.listChunks(PROJECT, GOAL)[0].stage).toBe('completed')
      expect(h.goalsRepo.listChunks(PROJECT, GOAL)[1].stage).toBe('planning')
    })

    test('reports a chunk loop that needs an explicit loop restart', async () => {
      h = createHarness()
      h.seedRunningGoal()
      h.loopStates.set('chunk-0-loop', loopState({ status: 'errored', terminationReason: 'stall_timeout' }))

      await expect(h.orchestrator.restart(GOAL)).resolves.toContain('loop-status restart=true')
    })

    test('cancels a running chunk whose loop is missing and advances from the last completed chunk', async () => {
      h = createHarness()
      h.seedRunningGoal()
      h.goalsRepo.completeChunk(PROJECT, GOAL, 0, 'done')
      h.goalsRepo.insertPlanningChunk(PROJECT, GOAL, 1, {
        planningDir: goalPlanningDir(DATA_DIR, GOAL, 1),
        baseCommit: 'sha-1',
      })
      h.goalsRepo.claimChunkStage(PROJECT, GOAL, 1, 'planning', 'launching')
      h.goalsRepo.markChunkRunning(PROJECT, GOAL, 1, {
        loopName: 'chunk-1-loop',
        branch: 'forge/chunk-1',
        title: 'Chunk 1',
      })
      h.goalsRepo.updateStatus(PROJECT, GOAL, ['running'], 'paused', { error: 'paused' })

      const message = await h.orchestrator.restart(GOAL)

      expect(message).toContain('chunk-1-loop')
      expect(message).toContain('forge/chunk-1')
      const chunks = h.goalsRepo.listChunks(PROJECT, GOAL)
      expect(chunks.find((chunk) => chunk.chunkIndex === 1)?.stage).toBe('cancelled')
      expect(chunks.find((chunk) => chunk.chunkIndex === 2)?.stage).toBe('planning')
      expect(h.goalsRepo.getGoal(PROJECT, GOAL)?.status).toBe('running')
    })

    test('resumes a paused goal and advances it', async () => {
      h = createHarness()
      h.seedRunningGoal()
      h.goalsRepo.completeChunk(PROJECT, GOAL, 0, 'done')
      h.goalsRepo.updateStatus(PROJECT, GOAL, ['running'], 'paused', { error: 'paused' })

      await expect(h.orchestrator.restart(GOAL)).resolves.toBe(`Goal ${GOAL} resumed.`)

      expect(h.goalsRepo.getGoal(PROJECT, GOAL)?.status).toBe('running')
      expect(h.goalsRepo.listChunks(PROJECT, GOAL)[1].stage).toBe('planning')
    })

    test('raises the chunk limit and continues', async () => {
      h = createHarness()
      h.seedRunningGoal({ maxChunks: 1 })
      h.loopStates.set('chunk-0-loop', loopState({ status: 'completed', completionSummary: 'done' }))
      await h.orchestrator.onLoopSettled('chunk-0-loop')
      expect(h.goalsRepo.getGoal(PROJECT, GOAL)?.status).toBe('paused')

      await expect(h.orchestrator.restart(GOAL, { maxChunks: 3 })).resolves.toBe(`Goal ${GOAL} resumed.`)

      expect(h.goalsRepo.getGoal(PROJECT, GOAL)?.maxChunks).toBe(3)
      expect(h.goalsRepo.listChunks(PROJECT, GOAL)[1].stage).toBe('planning')
    })

    test('explains when the goal cannot be restarted', async () => {
      h = createHarness()
      h.seedRunningGoal()
      h.goalsRepo.cancelGoal(PROJECT, GOAL)

      await expect(h.orchestrator.restart(GOAL)).resolves.toContain('only a running or paused goal can be restarted')
    })
  })

  describe('cancel', () => {
    test('cancels the goal and cleans up a planning chunk', async () => {
      h = createHarness()
      h.seedRunningGoal()
      h.loopStates.set('chunk-0-loop', loopState({ status: 'completed', completionSummary: 'done' }))
      await h.orchestrator.onLoopSettled('chunk-0-loop')

      const message = await h.orchestrator.cancel(GOAL)

      expect(message).toContain('cancelled')
      expect(h.goalsRepo.getGoal(PROJECT, GOAL)?.status).toBe('cancelled')
      expect(h.deleteSession).toHaveBeenCalledWith('planner-session-1', goalPlanningDir(DATA_DIR, GOAL, 1))
      expect(h.removeCheckout).toHaveBeenCalledWith(PROJECT_DIR, goalPlanningDir(DATA_DIR, GOAL, 1))
      expect(h.cancelLoop).not.toHaveBeenCalled()
    })

    test('cancels running loops only when asked', async () => {
      h = createHarness()
      h.seedRunningGoal()

      const message = await h.orchestrator.cancel(GOAL, { cancelRunningLoops: true })

      expect(h.cancelLoop).toHaveBeenCalledWith('chunk-0-loop')
      expect(message).toContain('Cancelled 1 running loop(s).')
    })
  })
})

describe('buildGoalChunkPlannerPrompt', () => {
  const goal = {
    projectId: PROJECT,
    goalId: GOAL,
    title: 'Ship it',
    objective: 'Deliver the whole feature',
    tasks: TASKS,
    hostSessionId: HOST,
    projectDir: PROJECT_DIR,
    status: 'running' as const,
    maxChunks: 3,
    executionModel: null,
    auditorModel: null,
    executionVariant: null,
    auditorVariant: null,
    sandboxSettings: null,
    maxIterations: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
  }

  function chunk(overrides: Partial<Parameters<typeof buildGoalChunkPlannerPrompt>[0]['completedChunks'][number]> = {}) {
    return {
      projectId: PROJECT,
      goalId: GOAL,
      chunkIndex: 0,
      stage: 'completed' as const,
      title: 'Chunk 0',
      plannerSessionId: null,
      planningDir: null,
      baseCommit: 'sha-0',
      loopName: 'chunk-0-loop',
      branch: 'forge/chunk-0',
      summary: 'did the first thing',
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    }
  }

  test('renders the task list, completed chunks, and the marker instruction', () => {
    const prompt = buildGoalChunkPlannerPrompt({ goal, completedChunks: [chunk()], chunkIndex: 1 })

    expect(prompt).toContain('chunk 2 of a multi-chunk goal')
    expect(prompt).toContain('Deliver the whole feature')
    expect(prompt).toContain('- [GH-1] First ticket — do the first thing')
    expect(prompt).toContain('- Second ticket')
    expect(prompt).toContain('1. Chunk 0 (branch forge/chunk-0) — did the first thing')
    expect(prompt).toContain(GOAL_COMPLETE_MARKER)
    expect(prompt).toContain('Never modify tickets or issues in any external tracker.')
  })

  test('says so when there is no ordered task list', () => {
    const prompt = buildGoalChunkPlannerPrompt({ goal: { ...goal, tasks: [] }, completedChunks: [], chunkIndex: 0 })

    expect(prompt).toContain('has no ordered task list')
    expect(prompt).toContain('No chunks have completed yet.')
  })

  test('truncates a completed chunk summary to the cap', () => {
    const long = 'y'.repeat(GOAL_CHUNK_SUMMARY_MAX_CHARS + 100)
    const prompt = buildGoalChunkPlannerPrompt({ goal, completedChunks: [chunk({ summary: long })], chunkIndex: 1 })

    expect(prompt).toContain('y'.repeat(GOAL_CHUNK_SUMMARY_MAX_CHARS))
    expect(prompt).not.toContain('y'.repeat(GOAL_CHUNK_SUMMARY_MAX_CHARS + 1))
  })
})
