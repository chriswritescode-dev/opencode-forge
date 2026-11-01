import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Database } from 'bun:sqlite'
import { createGoalTools } from '../../src/tools/goal'
import { createGoalsRepo } from '../../src/storage/repos/goals-repo'
import type { GoalLaunchSnapshot } from '../../src/storage/repos/goals-repo'
import { DEFAULT_GOAL_MAX_CHUNKS, MAX_GOAL_MAX_CHUNKS } from '../../src/constants/goal'
import type { Logger } from '../../src/types'
import type { ToolContext } from '../../src/tools/types'
import { createTestDb } from '../helpers/test-db'

const PROJECT = 'test-project'
const SESSION = 'sess-goal'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

function snapshot() {
  return {
    projectDir: '/tmp/project',
    executionModel: null,
    auditorModel: null,
    executionVariant: null,
    auditorVariant: null,
    sandboxSettings: null,
    maxIterations: null,
  }
}

describe('goal-write', () => {
  let db: Database
  let testDb: ReturnType<typeof createTestDb>
  let goalsRepo: ReturnType<typeof createGoalsRepo>
  let tools: ReturnType<typeof createGoalTools>

  beforeEach(() => {
    testDb = createTestDb()
    db = testDb.db
    goalsRepo = createGoalsRepo(db)
    const ctx = { projectId: PROJECT, logger: mockLogger, goalsRepo } as unknown as ToolContext
    tools = createGoalTools(ctx)
  })

  afterEach(() => {
    testDb.cleanup()
  })

  const call = (args: Record<string, unknown>, sessionID = SESSION) =>
    tools['goal-write'].execute(args as never, { sessionID } as never)

  test('saves a draft with a generated id and the default max chunks', async () => {
    const result = await call({
      title: 'Ship the feature',
      objective: 'Deliver the whole feature',
      tasks: [
        { ref: 'GH-1', title: 'First ticket', details: 'Do the first thing' },
        { title: 'Second task' },
      ],
    })

    const match = result.match(/^Goal draft saved: (.+)$/m)
    expect(match).not.toBeNull()
    const goalId = match![1]
    expect(goalId).toMatch(/^ship-the-feature-[0-9a-f]{6}$/)
    expect(result).toContain('Title: Ship the feature')
    expect(result).toContain('Tasks: 2')
    expect(result).toContain('- [GH-1] First ticket')
    expect(result).toContain('- Second task')
    expect(result).toContain(`Max chunks: ${DEFAULT_GOAL_MAX_CHUNKS}`)
    expect(result).toContain('Next: write the detailed loop plan for chunk 1')

    const goal = goalsRepo.listGoals(PROJECT)[0]
    expect(goal).not.toBeNull()
    expect(goal.goalId).toBe(goalId)
    expect(goal.status).toBe('draft')
    expect(goal.maxChunks).toBe(DEFAULT_GOAL_MAX_CHUNKS)
    expect(goal.hostSessionId).toBe(SESSION)
    expect(goal.tasks).toEqual([
      { ref: 'GH-1', title: 'First ticket', details: 'Do the first thing' },
      { title: 'Second task' },
    ])
  })

  test('tasks are optional and default to an empty list', async () => {
    const result = await call({ title: 'Solo', objective: 'Just one thing' })

    expect(result).toContain('Tasks: 0')
    expect(goalsRepo.listGoals(PROJECT)[0].tasks).toEqual([])
  })

  test('replaces an earlier draft for the same session', async () => {
    await call({ title: 'First', objective: 'First objective' })
    const first = goalsRepo.listGoals(PROJECT)[0]

    await call({ title: 'Second', objective: 'Second objective' })

    const draft = goalsRepo.listGoals(PROJECT)[0]
    expect(draft.title).toBe('Second')
    expect(goalsRepo.getGoal(PROJECT, first.goalId)).toBeNull()
    expect(goalsRepo.listGoals(PROJECT)).toHaveLength(1)
  })

  test('honours an explicit maxChunks', async () => {
    await call({ title: 'Capped', objective: 'Capped objective', maxChunks: 5 })
    expect(goalsRepo.listGoals(PROJECT)[0].maxChunks).toBe(5)
  })

  test('refuses when the session already has a running goal', async () => {
    await call({ title: 'Running', objective: 'Running objective' })
    const draft = goalsRepo.listGoals(PROJECT)[0]
    goalsRepo.attachFirstChunk(PROJECT, SESSION, snapshot(), {
      loopName: 'loop-0',
      branch: null,
      title: null,
      baseCommit: null,
    })

    const result = await call({ title: 'Another', objective: 'Another objective' })

    expect(result).toBe(
      `This session already has goal ${draft.goalId} (running). Cancel it before defining a new goal.`,
    )
    expect(goalsRepo.listGoals(PROJECT)).toHaveLength(1)
  })

  test('refuses when the session already has a paused goal', async () => {
    await call({ title: 'Paused', objective: 'Paused objective' })
    const draft = goalsRepo.listGoals(PROJECT)[0]
    goalsRepo.attachFirstChunk(PROJECT, SESSION, snapshot(), {
      loopName: 'loop-0',
      branch: null,
      title: null,
      baseCommit: null,
    })
    goalsRepo.updateStatus(PROJECT, draft.goalId, ['running'], 'paused')

    const result = await call({ title: 'Another', objective: 'Another objective' })

    expect(result).toBe(
      `This session already has goal ${draft.goalId} (paused). Cancel it before defining a new goal.`,
    )
  })

  test('rejects an empty title or objective', async () => {
    expect(await call({ title: '   ', objective: 'Objective' })).toBe('goal-write failed: title is required.')
    expect(await call({ title: 'Title', objective: '   ' })).toBe('goal-write failed: objective is required.')
    expect(goalsRepo.listGoals(PROJECT)).toHaveLength(0)
  })

  test('rejects a task entry with an empty title', async () => {
    const result = await call({
      title: 'Title',
      objective: 'Objective',
      tasks: [{ title: 'ok' }, { title: '   ' }],
    })

    expect(result).toBe('goal-write failed: task 2 has an empty title.')
    expect(goalsRepo.listGoals(PROJECT)).toHaveLength(0)
  })

  test('rejects out-of-range maxChunks', async () => {
    expect(await call({ title: 'T', objective: 'O', maxChunks: 0 })).toBe(
      `goal-write failed: maxChunks must be between 1 and ${MAX_GOAL_MAX_CHUNKS}.`,
    )
    expect(await call({ title: 'T', objective: 'O', maxChunks: MAX_GOAL_MAX_CHUNKS + 1 })).toBe(
      `goal-write failed: maxChunks must be between 1 and ${MAX_GOAL_MAX_CHUNKS}.`,
    )
    expect(goalsRepo.listGoals(PROJECT)).toHaveLength(0)
  })
})

describe('goal-status and goal-cancel', () => {
  let db: Database
  let testDb: ReturnType<typeof createTestDb>
  let goalsRepo: ReturnType<typeof createGoalsRepo>
  let orchestrator: {
    restart: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
    onLoopSettled: ReturnType<typeof vi.fn>
    onPlannerIdle: ReturnType<typeof vi.fn>
  }
  let tools: ReturnType<typeof createGoalTools>
  let loopInspect: ReturnType<typeof vi.fn>

  beforeEach(() => {
    testDb = createTestDb()
    db = testDb.db
    goalsRepo = createGoalsRepo(db)
    orchestrator = {
      restart: vi.fn(async () => 'restart result'),
      cancel: vi.fn(async () => 'cancel result'),
      onLoopSettled: vi.fn(async () => {}),
      onPlannerIdle: vi.fn(async () => {}),
    }
    loopInspect = vi.fn(() => null)
    const ctx = {
      projectId: PROJECT,
      logger: mockLogger,
      goalsRepo,
      goalOrchestrator: orchestrator,
      loop: { inspect: loopInspect },
    } as unknown as ToolContext
    tools = createGoalTools(ctx)
  })

  afterEach(() => {
    testDb.cleanup()
  })

  const status = (args: Record<string, unknown>) =>
    tools['goal-status'].execute(args as never, { sessionID: SESSION } as never)
  const cancel = (args: Record<string, unknown>) =>
    tools['goal-cancel'].execute(args as never, { sessionID: SESSION } as never)

  function seedGoal(goalId: string, title: string, snapshotOverrides: Partial<GoalLaunchSnapshot> = {}) {
    goalsRepo.saveDraft({
      projectId: PROJECT,
      goalId,
      title,
      objective: `${title} objective`,
      tasks: [{ ref: 'GH-1', title: 'First task' }],
      hostSessionId: SESSION,
      maxChunks: 3,
    })
    goalsRepo.attachFirstChunk(PROJECT, SESSION, { ...snapshot(), ...snapshotOverrides }, {
      loopName: `${goalId}-loop`,
      branch: `forge/${goalId}-chunk-0`,
      title: 'Chunk 0',
      baseCommit: 'sha-0',
    })
  }

  test('lists goals newest first with status, chunk counts, current chunk, and error', async () => {
    seedGoal('alpha', 'Alpha')
    goalsRepo.completeChunk(PROJECT, 'alpha', 0, 'alpha done')
    goalsRepo.insertPlanningChunk(PROJECT, 'alpha', 1, { planningDir: '/tmp/plan-1', baseCommit: 'sha-1' })
    goalsRepo.updateStatus(PROJECT, 'alpha', ['running'], 'paused', { error: 'alpha paused' })

    seedGoal('beta', 'Beta')
    goalsRepo.completeChunk(PROJECT, 'beta', 0, 'beta done')
    goalsRepo.updateStatus(PROJECT, 'beta', ['running'], 'completed', { completedAt: Date.now() })

    const result = await status({})

    expect(result).toContain('Goals (2)')
    expect(result).toContain('- Alpha (alpha)')
    expect(result).toContain('  Status: paused | Chunks: 1/2 | Tasks: 1')
    expect(result).toContain('  Current: chunk 2 planning')
    expect(result).toContain('  Error: alpha paused')
    expect(result).toContain('- Beta (beta)')
    expect(result).toContain('  Status: completed | Chunks: 1/1 | Tasks: 1')
    expect(result).toContain('Use goal-status <goalId> for details, or goal-cancel <goalId> to cancel a goal.')

    const ordered = goalsRepo.listGoals(PROJECT).map((goal) => goal.goalId)
    expect(result.indexOf(ordered[0])).toBeLessThan(result.indexOf(ordered[1]))
  })

  test('shows the current chunk loop when a chunk is running', async () => {
    seedGoal('alpha', 'Alpha')

    const result = await status({})

    expect(result).toContain('  Current: chunk 1 running loop alpha-loop')
  })

  test('shows the loop status and a restart hint when the current chunk loop is not running', async () => {
    seedGoal('alpha', 'Alpha')
    loopInspect.mockReturnValue({ status: 'errored' })

    const result = await status({})

    expect(result).toContain(
      '  Current: chunk 1 running (loop alpha-loop: errored — restart it with loop-status restart=true)',
    )
  })

  test('omits the loop status note while the current chunk loop is running', async () => {
    seedGoal('alpha', 'Alpha')
    loopInspect.mockReturnValue({ status: 'running' })

    const result = await status({})

    expect(result).toContain('  Current: chunk 1 running loop alpha-loop')
    expect(result).not.toContain('restart it with loop-status restart=true')
  })

  test('a cancelled chunk is not reported as the current chunk', async () => {
    seedGoal('alpha', 'Alpha')
    expect(goalsRepo.claimChunkStage(PROJECT, 'alpha', 0, 'running', 'cancelled')).toBe(true)

    const result = await status({})

    expect(result).not.toContain('  Current:')
  })

  test('the detail view flags a current chunk whose loop is not running', async () => {
    seedGoal('alpha', 'Alpha')
    loopInspect.mockReturnValue({ status: 'stalled' })

    const result = await status({ goalId: 'alpha' })

    expect(result).toContain(
      '   Loop: alpha-loop (loop alpha-loop: stalled — restart it with loop-status restart=true)',
    )
  })

  test('reports no goals when the project has none', async () => {
    expect(await status({})).toBe('No goals found.')
  })

  test('shows goal details with the 1-based chunk list and the model snapshot', async () => {
    seedGoal('alpha', 'Alpha', {
      executionModel: 'provider/exec',
      auditorModel: 'provider/audit',
      executionVariant: 'high',
      auditorVariant: 'low',
    })
    goalsRepo.completeChunk(PROJECT, 'alpha', 0, 'did the first thing\nsecond line ignored')
    goalsRepo.insertPlanningChunk(PROJECT, 'alpha', 1, { planningDir: '/tmp/plan-1', baseCommit: 'sha-1' })

    const result = await status({ goalId: 'alpha' })

    expect(result).toContain('Goal: alpha')
    expect(result).toContain('Title: Alpha')
    expect(result).toContain('Status: running')
    expect(result).toMatch(/Created: \d{4}-\d{2}-\d{2}T/)
    expect(result).toContain('Max chunks: 3')
    expect(result).toContain('Models: execution provider/exec (variant high) | auditor provider/audit (variant low)')
    expect(result).toContain('Objective: Alpha objective')
    expect(result).toContain('- [GH-1] First task')
    expect(result).toContain('1. Chunk 0 — completed')
    expect(result).toContain('   Loop: alpha-loop')
    expect(result).toContain('   Branch: forge/alpha-chunk-0')
    expect(result).toContain('   Summary: did the first thing')
    expect(result).not.toContain('second line ignored')
    expect(result).toContain('2. (planning) — planning')
  })

  test('shows the completion timestamp for a completed goal', async () => {
    seedGoal('alpha', 'Alpha')
    goalsRepo.completeChunk(PROJECT, 'alpha', 0, 'done')
    goalsRepo.updateStatus(PROJECT, 'alpha', ['running'], 'completed', { completedAt: Date.now() })

    const result = await status({ goalId: 'alpha' })

    expect(result).toContain('Status: completed')
    expect(result).toMatch(/Completed: \d{4}-\d{2}-\d{2}T/)
  })

  test('reports an unknown goal id in the detail view', async () => {
    expect(await status({ goalId: 'nope' })).toBe('Goal nope not found.')
  })

  test('requires a goal id to restart', async () => {
    expect(await status({ restart: true })).toBe('Specify a goal id to restart. Use goal-status to see available goals.')
    expect(orchestrator.restart).not.toHaveBeenCalled()
  })

  test('delegates restart with maxChunks and force', async () => {
    seedGoal('alpha', 'Alpha')

    const result = await status({ goalId: 'alpha', restart: true, maxChunks: 5, force: true })

    expect(result).toBe('restart result')
    expect(orchestrator.restart).toHaveBeenCalledWith('alpha', { maxChunks: 5, force: true })
  })

  test('delegates restart with the defaults when no options are passed', async () => {
    seedGoal('alpha', 'Alpha')

    await status({ goalId: 'alpha', restart: true })

    expect(orchestrator.restart).toHaveBeenCalledWith('alpha', { maxChunks: undefined, force: false })
  })

  test('cancels a goal and delegates cancelRunningLoops', async () => {
    seedGoal('alpha', 'Alpha')

    const result = await cancel({ goalId: 'alpha', cancelRunningLoops: true })

    expect(result).toBe('cancel result')
    expect(orchestrator.cancel).toHaveBeenCalledWith('alpha', { cancelRunningLoops: true })
  })

  test('cancels a goal without cancelling running loops by default', async () => {
    seedGoal('alpha', 'Alpha')

    await cancel({ goalId: 'alpha' })

    expect(orchestrator.cancel).toHaveBeenCalledWith('alpha', { cancelRunningLoops: false })
  })

  test('reports an unknown goal id when cancelling without calling the orchestrator', async () => {
    expect(await cancel({ goalId: 'nope' })).toBe('Goal nope not found.')
    expect(orchestrator.cancel).not.toHaveBeenCalled()
  })
})
