import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { createGoalsRepo } from '../src/storage/repos/goals-repo'
import type { GoalLaunchSnapshot, GoalTask } from '../src/storage/repos/goals-repo'
import { setupLoopsTestDb } from './helpers/loops-test-db'

const PROJECT = 'test-project'
const SESSION_A = 'sess-a'
const SESSION_B = 'sess-b'
const GOAL_1 = 'goal-1'

function snapshot(overrides: Partial<GoalLaunchSnapshot> = {}): GoalLaunchSnapshot {
  return {
    projectDir: '/tmp/project',
    executionModel: 'provider/model-exec',
    auditorModel: 'provider/model-audit',
    executionVariant: 'high',
    auditorVariant: 'low',
    sandboxSettings: { enabled: true, resources: { cpus: '2', memory: '4g' }, allowLan: true },
    maxIterations: 12,
    ...overrides,
  }
}

const TASKS: GoalTask[] = [
  { ref: 'GH-1', title: 'First ticket', details: 'do the first thing' },
  { title: 'No ref task' },
]

describe('GoalsRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createGoalsRepo>

  beforeEach(() => {
    db = new Database(':memory:')
    setupLoopsTestDb(db)
    repo = createGoalsRepo(db)
  })

  afterEach(() => {
    db.close()
  })

  function saveDraft(overrides: Partial<Parameters<typeof repo.saveDraft>[0]> = {}) {
    return repo.saveDraft({
      projectId: PROJECT,
      goalId: GOAL_1,
      title: 'Ship the feature',
      objective: 'Deliver the whole feature',
      tasks: TASKS,
      hostSessionId: SESSION_A,
      maxChunks: 3,
      ...overrides,
    })
  }

  describe('saveDraft', () => {
    test('inserts a draft with defaults and round-trips the task list', () => {
      const goal = saveDraft()

      expect(goal.projectId).toBe(PROJECT)
      expect(goal.goalId).toBe(GOAL_1)
      expect(goal.title).toBe('Ship the feature')
      expect(goal.objective).toBe('Deliver the whole feature')
      expect(goal.status).toBe('draft')
      expect(goal.maxChunks).toBe(3)
      expect(goal.hostSessionId).toBe(SESSION_A)
      expect(goal.projectDir).toBeNull()
      expect(goal.executionModel).toBeNull()
      expect(goal.auditorModel).toBeNull()
      expect(goal.executionVariant).toBeNull()
      expect(goal.auditorVariant).toBeNull()
      expect(goal.sandboxSettings).toBeNull()
      expect(goal.maxIterations).toBeNull()
      expect(goal.error).toBeNull()
      expect(goal.completedAt).toBeNull()
      expect(goal.tasks).toEqual(TASKS)
      expect(goal.createdAt).toBeGreaterThan(0)
      expect(goal.updatedAt).toBeGreaterThanOrEqual(goal.createdAt)
    })

    test('a second saveDraft for the same session replaces the first draft', () => {
      saveDraft({ goalId: 'goal-old' })
      const replacement = saveDraft({ goalId: 'goal-new' })

      expect(replacement.goalId).toBe('goal-new')
      expect(repo.getGoal(PROJECT, 'goal-old')).toBeNull()
      expect(repo.listGoals(PROJECT).map((g) => g.goalId)).toEqual(['goal-new'])
      expect(repo.getDraftForSession(PROJECT, SESSION_A)?.goalId).toBe('goal-new')
    })

    test('drafts for different sessions coexist', () => {
      saveDraft({ goalId: 'goal-a', hostSessionId: SESSION_A })
      saveDraft({ goalId: 'goal-b', hostSessionId: SESSION_B })

      expect(repo.getDraftForSession(PROJECT, SESSION_A)?.goalId).toBe('goal-a')
      expect(repo.getDraftForSession(PROJECT, SESSION_B)?.goalId).toBe('goal-b')
      expect(repo.listGoals(PROJECT)).toHaveLength(2)
    })

    test('the unique draft index rejects a second draft for the same session', () => {
      saveDraft({ goalId: 'goal-a' })

      expect(() => {
        db.prepare(`
          INSERT INTO goals (
            project_id, goal_id, title, objective, tasks, host_session_id, status,
            max_chunks, created_at, updated_at
          )
          VALUES (?, ?, 'dup', 'dup', '[]', ?, 'draft', 1, 1, 1)
        `).run(PROJECT, 'goal-dup', SESSION_A)
      }).toThrow(/UNIQUE constraint failed/)
    })

    test('malformed stored tasks hydrate as an empty list', () => {
      saveDraft()
      const setTasks = (value: string) => {
        db.prepare('UPDATE goals SET tasks = ? WHERE project_id = ? AND goal_id = ?').run(value, PROJECT, GOAL_1)
      }

      setTasks('not json')
      expect(repo.getGoal(PROJECT, GOAL_1)?.tasks).toEqual([])

      setTasks('{"a":1}')
      expect(repo.getGoal(PROJECT, GOAL_1)?.tasks).toEqual([])

      setTasks('[{"title":"kept"},{"nope":1}]')
      expect(repo.getGoal(PROJECT, GOAL_1)?.tasks).toEqual([{ title: 'kept' }])
    })

    test('listGoals returns newest created first', () => {
      saveDraft({ goalId: 'goal-a', hostSessionId: SESSION_A })
      db.prepare('UPDATE goals SET created_at = 1 WHERE goal_id = ?').run('goal-a')
      saveDraft({ goalId: 'goal-b', hostSessionId: SESSION_B })
      db.prepare('UPDATE goals SET created_at = 2 WHERE goal_id = ?').run('goal-b')

      expect(repo.listGoals(PROJECT).map((g) => g.goalId)).toEqual(['goal-b', 'goal-a'])
    })
  })

  describe('attachFirstChunk', () => {
    test('stores the launch snapshot, flips the draft to running, and inserts chunk 0', () => {
      saveDraft()

      const attached = repo.attachFirstChunk(PROJECT, SESSION_A, snapshot(), {
        loopName: 'goal-1-chunk-0',
        branch: 'feat/goal-1-chunk-0',
        title: 'Chunk 0',
        baseCommit: 'abc123',
      })

      expect(attached).not.toBeNull()
      expect(attached!.status).toBe('running')
      expect(attached!.projectDir).toBe('/tmp/project')
      expect(attached!.executionModel).toBe('provider/model-exec')
      expect(attached!.auditorModel).toBe('provider/model-audit')
      expect(attached!.executionVariant).toBe('high')
      expect(attached!.auditorVariant).toBe('low')
      expect(attached!.maxIterations).toBe(12)
      expect(attached!.sandboxSettings).toEqual({ enabled: true, resources: { cpus: '2', memory: '4g' }, allowLan: true })
      expect(attached!.error).toBeNull()

      const chunks = repo.listChunks(PROJECT, GOAL_1)
      expect(chunks).toHaveLength(1)
      expect(chunks[0]).toMatchObject({
        chunkIndex: 0,
        stage: 'running',
        title: 'Chunk 0',
        loopName: 'goal-1-chunk-0',
        branch: 'feat/goal-1-chunk-0',
        baseCommit: 'abc123',
        plannerSessionId: null,
        planningDir: null,
        summary: null,
      })
    })

    test('returns null and writes nothing when there is no draft', () => {
      const result = repo.attachFirstChunk(PROJECT, SESSION_A, snapshot(), {
        loopName: 'goal-1-chunk-0',
        branch: null,
        title: null,
        baseCommit: null,
      })

      expect(result).toBeNull()
      expect(repo.listGoals(PROJECT)).toHaveLength(0)
      expect(repo.listChunks(PROJECT, GOAL_1)).toHaveLength(0)
    })

    test('a second attach for the same session returns null', () => {
      saveDraft()
      expect(repo.attachFirstChunk(PROJECT, SESSION_A, snapshot(), {
        loopName: 'goal-1-chunk-0',
        branch: null,
        title: null,
        baseCommit: null,
      })).not.toBeNull()

      const second = repo.attachFirstChunk(PROJECT, SESSION_A, snapshot(), {
        loopName: 'goal-1-chunk-0b',
        branch: null,
        title: null,
        baseCommit: null,
      })

      expect(second).toBeNull()
      expect(repo.listChunks(PROJECT, GOAL_1)).toHaveLength(1)
    })

    test('null snapshot fields store as null', () => {
      saveDraft()
      const attached = repo.attachFirstChunk(
        PROJECT,
        SESSION_A,
        snapshot({
          executionModel: null,
          auditorModel: null,
          executionVariant: null,
          auditorVariant: null,
          sandboxSettings: null,
          maxIterations: null,
        }),
        { loopName: 'loop-0', branch: null, title: null, baseCommit: null },
      )

      expect(attached!.executionModel).toBeNull()
      expect(attached!.auditorModel).toBeNull()
      expect(attached!.executionVariant).toBeNull()
      expect(attached!.auditorVariant).toBeNull()
      expect(attached!.sandboxSettings).toBeNull()
      expect(attached!.maxIterations).toBeNull()
    })
  })

  describe('getActiveForSession', () => {
    test('is null while only a draft exists', () => {
      saveDraft()
      expect(repo.getActiveForSession(PROJECT, SESSION_A)).toBeNull()
    })

    test('returns the running goal for the session', () => {
      saveDraft()
      repo.attachFirstChunk(PROJECT, SESSION_A, snapshot(), {
        loopName: 'loop-0',
        branch: null,
        title: null,
        baseCommit: null,
      })

      expect(repo.getActiveForSession(PROJECT, SESSION_A)?.goalId).toBe(GOAL_1)
      expect(repo.getActiveForSession(PROJECT, SESSION_B)).toBeNull()
    })

    test('returns a paused goal', () => {
      saveDraft()
      repo.attachFirstChunk(PROJECT, SESSION_A, snapshot(), {
        loopName: 'loop-0',
        branch: null,
        title: null,
        baseCommit: null,
      })
      expect(repo.updateStatus(PROJECT, GOAL_1, ['running'], 'paused')).toBe(true)

      expect(repo.getActiveForSession(PROJECT, SESSION_A)?.status).toBe('paused')
    })
  })

  describe('updateStatus', () => {
    test('compare-and-set returns true on a matching status and false otherwise', () => {
      saveDraft()
      expect(repo.updateStatus(PROJECT, GOAL_1, ['draft'], 'running')).toBe(true)
      expect(repo.updateStatus(PROJECT, GOAL_1, ['draft'], 'running')).toBe(false)
      expect(repo.getGoal(PROJECT, GOAL_1)?.status).toBe('running')
    })

    test('accepts multiple source statuses', () => {
      saveDraft()
      expect(repo.updateStatus(PROJECT, GOAL_1, ['draft', 'running'], 'cancelled')).toBe(true)
      expect(repo.getGoal(PROJECT, GOAL_1)?.status).toBe('cancelled')
    })

    test('sets error only when provided and completedAt when provided', () => {
      saveDraft()
      repo.updateStatus(PROJECT, GOAL_1, ['draft'], 'running')

      repo.updateStatus(PROJECT, GOAL_1, ['running'], 'paused', { error: 'boom' })
      expect(repo.getGoal(PROJECT, GOAL_1)?.error).toBe('boom')

      repo.updateStatus(PROJECT, GOAL_1, ['paused'], 'running')
      expect(repo.getGoal(PROJECT, GOAL_1)?.error).toBe('boom')

      repo.updateStatus(PROJECT, GOAL_1, ['running'], 'completed', { error: null, completedAt: 4242 })
      const completed = repo.getGoal(PROJECT, GOAL_1)!
      expect(completed.error).toBeNull()
      expect(completed.completedAt).toBe(4242)
    })
  })

  describe('setMaxChunks', () => {
    test('updates the cap and reports whether a row changed', () => {
      saveDraft()
      expect(repo.setMaxChunks(PROJECT, GOAL_1, 5)).toBe(true)
      expect(repo.getGoal(PROJECT, GOAL_1)?.maxChunks).toBe(5)
      expect(repo.setMaxChunks(PROJECT, 'missing', 5)).toBe(false)
    })
  })

  describe('chunk lifecycle', () => {
    function attach(): void {
      saveDraft()
      repo.attachFirstChunk(PROJECT, SESSION_A, snapshot(), {
        loopName: 'loop-0',
        branch: 'feat/chunk-0',
        title: 'Chunk 0',
        baseCommit: 'base0',
      })
    }

    test('insertPlanningChunk inserts once and returns false on a duplicate index', () => {
      attach()
      expect(repo.insertPlanningChunk(PROJECT, GOAL_1, 1, { planningDir: '/tmp/plan-1', baseCommit: 'base1' })).toBe(true)
      expect(repo.insertPlanningChunk(PROJECT, GOAL_1, 1, { planningDir: '/tmp/other', baseCommit: 'other' })).toBe(false)

      const chunk = repo.listChunks(PROJECT, GOAL_1).find((c) => c.chunkIndex === 1)!
      expect(chunk.stage).toBe('planning')
      expect(chunk.planningDir).toBe('/tmp/plan-1')
      expect(chunk.baseCommit).toBe('base1')
    })

    test('advances planning to completed through compare-and-set stages', () => {
      attach()
      repo.insertPlanningChunk(PROJECT, GOAL_1, 1, { planningDir: '/tmp/plan-1', baseCommit: 'base1' })

      expect(repo.setChunkPlanner(PROJECT, GOAL_1, 1, 'planner-sess-1')).toBe(true)

      expect(repo.claimChunkStage(PROJECT, GOAL_1, 1, 'planning', 'launching')).toBe(true)
      expect(repo.claimChunkStage(PROJECT, GOAL_1, 1, 'planning', 'launching')).toBe(false)
      expect(repo.setChunkPlanner(PROJECT, GOAL_1, 1, 'planner-sess-2')).toBe(false)

      expect(repo.markChunkRunning(PROJECT, GOAL_1, 1, {
        loopName: 'loop-1',
        branch: 'feat/chunk-1',
        title: 'Chunk 1',
      })).toBe(true)
      expect(repo.markChunkRunning(PROJECT, GOAL_1, 1, {
        loopName: 'loop-1b',
        branch: null,
        title: null,
      })).toBe(false)

      expect(repo.completeChunk(PROJECT, GOAL_1, 1, 'all done')).toBe(true)
      expect(repo.completeChunk(PROJECT, GOAL_1, 1, 'again')).toBe(false)

      const chunk = repo.listChunks(PROJECT, GOAL_1).find((c) => c.chunkIndex === 1)!
      expect(chunk.stage).toBe('completed')
      expect(chunk.plannerSessionId).toBe('planner-sess-1')
      expect(chunk.loopName).toBe('loop-1')
      expect(chunk.branch).toBe('feat/chunk-1')
      expect(chunk.title).toBe('Chunk 1')
      expect(chunk.summary).toBe('all done')
    })

    test('completeChunk stores a null summary', () => {
      attach()
      expect(repo.completeChunk(PROJECT, GOAL_1, 0, null)).toBe(true)
      expect(repo.listChunks(PROJECT, GOAL_1)[0].summary).toBeNull()
    })

    test('looks chunks up by loop name and by planner session', () => {
      attach()
      repo.insertPlanningChunk(PROJECT, GOAL_1, 1, { planningDir: '/tmp/plan-1', baseCommit: 'base1' })
      repo.setChunkPlanner(PROJECT, GOAL_1, 1, 'planner-sess-1')

      const byLoop = repo.getChunkByLoopName(PROJECT, 'loop-0')
      expect(byLoop?.chunkIndex).toBe(0)

      const byPlanner = repo.getChunkByPlannerSession(PROJECT, 'planner-sess-1')
      expect(byPlanner?.chunkIndex).toBe(1)

      expect(repo.getChunkByLoopName(PROJECT, 'missing')).toBeNull()
      expect(repo.getChunkByPlannerSession(PROJECT, 'missing')).toBeNull()
    })

    test('deleteChunk removes the row and reports whether it existed', () => {
      attach()
      repo.insertPlanningChunk(PROJECT, GOAL_1, 1, { planningDir: '/tmp/plan-1', baseCommit: 'base1' })

      expect(repo.deleteChunk(PROJECT, GOAL_1, 1)).toBe(true)
      expect(repo.deleteChunk(PROJECT, GOAL_1, 1)).toBe(false)
      expect(repo.listChunks(PROJECT, GOAL_1).map((c) => c.chunkIndex)).toEqual([0])
    })
  })

  describe('cancelGoal', () => {
    test('cancels the goal, reports running loop names and planning chunks, and cancels chunks', () => {
      saveDraft()
      repo.attachFirstChunk(PROJECT, SESSION_A, snapshot(), {
        loopName: 'loop-0',
        branch: 'feat/chunk-0',
        title: 'Chunk 0',
        baseCommit: 'base0',
      })
      repo.insertPlanningChunk(PROJECT, GOAL_1, 1, { planningDir: '/tmp/plan-1', baseCommit: 'base1' })
      repo.setChunkPlanner(PROJECT, GOAL_1, 1, 'planner-sess-1')
      repo.claimChunkStage(PROJECT, GOAL_1, 1, 'planning', 'launching')

      const result = repo.cancelGoal(PROJECT, GOAL_1)

      expect(result.cancelled).toBe(true)
      expect(result.runningLoopNames).toEqual(['loop-0'])
      expect(result.planningChunks.map((c) => c.chunkIndex)).toEqual([1])
      expect(result.planningChunks[0].stage).toBe('launching')

      const goal = repo.getGoal(PROJECT, GOAL_1)!
      expect(goal.status).toBe('cancelled')
      expect(goal.completedAt).not.toBeNull()
      expect(repo.listChunks(PROJECT, GOAL_1).every((c) => c.stage === 'cancelled')).toBe(true)
    })

    test('is a no-op for a completed goal', () => {
      saveDraft()
      repo.attachFirstChunk(PROJECT, SESSION_A, snapshot(), {
        loopName: 'loop-0',
        branch: null,
        title: null,
        baseCommit: null,
      })
      repo.updateStatus(PROJECT, GOAL_1, ['running'], 'completed', { completedAt: 111 })

      const result = repo.cancelGoal(PROJECT, GOAL_1)

      expect(result).toEqual({ cancelled: false, runningLoopNames: [], planningChunks: [] })
      expect(repo.getGoal(PROJECT, GOAL_1)?.status).toBe('completed')
      expect(repo.getGoal(PROJECT, GOAL_1)?.completedAt).toBe(111)
      expect(repo.listChunks(PROJECT, GOAL_1)[0].stage).toBe('running')
    })

    test('cancels a draft goal with no chunks', () => {
      saveDraft()
      const result = repo.cancelGoal(PROJECT, GOAL_1)
      expect(result).toEqual({ cancelled: true, runningLoopNames: [], planningChunks: [] })
      expect(repo.getGoal(PROJECT, GOAL_1)?.status).toBe('cancelled')
    })
  })

  describe('foreign key cascade', () => {
    test('deleting the goal cascades to its chunks', () => {
      saveDraft()
      repo.attachFirstChunk(PROJECT, SESSION_A, snapshot(), {
        loopName: 'loop-0',
        branch: null,
        title: null,
        baseCommit: null,
      })
      repo.insertPlanningChunk(PROJECT, GOAL_1, 1, { planningDir: '/tmp/plan-1', baseCommit: 'base1' })
      expect(repo.listChunks(PROJECT, GOAL_1)).toHaveLength(2)

      db.prepare('DELETE FROM goals WHERE project_id = ? AND goal_id = ?').run(PROJECT, GOAL_1)

      expect(repo.listChunks(PROJECT, GOAL_1)).toHaveLength(0)
    })
  })
})
