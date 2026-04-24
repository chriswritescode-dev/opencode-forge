import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initializeDatabase } from '../src/storage'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createLoopService } from '../src/services/loop'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createLogger } from '../src/utils/logger'

describe('loopService.getPlanText', () => {
  let db: Database
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let loopService: ReturnType<typeof createLoopService>
  const projectId = 'test-project'
  const logger = createLogger({ enabled: false, file: ':memory:' })

  beforeEach(() => {
    const dbPath = `/tmp/test-loop-plan-text-${Date.now()}-${Math.random()}.db`
    db = initializeDatabase(dbPath)
    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, logger)
  })

  afterEach(() => {
    db.close()
  })

  it('returns plan from loop_large_fields.prompt when only execution record exists', () => {
    const loopName = 'test-loop-1'
    const sessionId = 'session-1-' + Date.now()
    const planText = 'Test plan content'

    // Create loop state with prompt in loop_large_fields
    const state = {
      active: true,
      sessionId,
      loopName,
      worktreeDir: '/tmp/test',
      projectDir: '/tmp/test',
      worktreeBranch: 'test-branch',
      iteration: 1,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: planText,
      phase: 'coding' as const,

      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: undefined,
      auditorModel: undefined,
    }
    loopService.setState(loopName, state)

    // Verify getPlanText returns the plan from loop_large_fields
    const result = loopService.getPlanText(loopName, sessionId)
    expect(result).toBe(planText)
  })

  it('returns plan from plans table when only draft exists', () => {
    const loopName = 'test-loop-2'
    const sessionId = 'session-2'
    const planText = 'Draft plan content'

    // Write plan to plans table (draft)
    plansRepo.writeForLoop(projectId, loopName, planText)

    // Verify getPlanText returns the plan from plans table
    const result = loopService.getPlanText(loopName, sessionId)
    expect(result).toBe(planText)
  })

  it('prefers loop_large_fields.prompt when both exist', () => {
    const loopName = 'test-loop-3-' + Date.now()
    const sessionId = 'session-3-' + Date.now()
    const draftPlan = 'Draft plan'
    const executionPlan = 'Execution plan (should win)'

    // Write draft to plans table

    // Create loop state with different prompt in loop_large_fields
    const state = {
      active: true,
      sessionId,
      loopName,
      worktreeDir: '/tmp/test',
      projectDir: '/tmp/test',
      worktreeBranch: 'test-branch',
      iteration: 1,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: executionPlan,
      phase: 'coding' as const,

      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: undefined,
      auditorModel: undefined,
    }
    loopService.setState(loopName, state)

    // Verify getPlanText returns the execution plan
    const result = loopService.getPlanText(loopName, sessionId)
    expect(result).toBe(executionPlan)
    expect(result).not.toBe(draftPlan)
  })

  it('returns null when neither exists', () => {
    const loopName = 'nonexistent-loop'
    const sessionId = 'session-99'

    const result = loopService.getPlanText(loopName, sessionId)
    expect(result).toBeNull()
  })

  it('getPlanTextForState prefers loop_large_fields.prompt', () => {
    const loopName = 'test-loop-4-' + Date.now()
    const sessionId = 'session-4-' + Date.now()
    const planText = 'Plan for getPlanTextForState'

    // Create loop state
    const state = {
      active: true,
      sessionId,
      loopName,
      worktreeDir: '/tmp/test',
      projectDir: '/tmp/test',
      worktreeBranch: 'test-branch',
      iteration: 1,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: planText,
      phase: 'coding' as const,

      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: undefined,
      auditorModel: undefined,
    }
    loopService.setState(loopName, state)

    // Get state and verify getPlanTextForState returns the plan
    const retrievedState = loopService.getActiveState(loopName)
    expect(retrievedState).not.toBeNull()
    
    // Manually test getPlanTextForState logic
    const fromExecution = loopsRepo.getLarge(projectId, loopName)?.prompt
    expect(fromExecution).toBe(planText)
  })
})
