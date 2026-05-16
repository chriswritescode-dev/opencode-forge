import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initializeDatabase } from '../src/storage'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createLoopService } from '../src/loop/service'
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

  function makeState(overrides: Record<string, unknown> = {}) {
    return {
      active: true,
      sessionId: 'session-1',
      loopName: 'test-loop',
      worktreeDir: '/tmp/test',
      projectDir: '/tmp/test',
      worktreeBranch: 'test-branch',
      iteration: 1,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: undefined as string | undefined,
      phase: 'coding' as const,

      errorCount: 0,
      auditCount: 0,
      worktree: true,
      sandbox: false,
      executionModel: undefined,
      auditorModel: undefined,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      ...overrides,
    }
  }

  it('returns plan written by setState via plans table', () => {
    const loopName = 'test-loop-1'
    const sessionId = 'session-1-' + Date.now()
    const planText = 'Test plan content'

    loopService.setState(loopName, makeState({ loopName, sessionId, prompt: planText }))

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

  it('overwrites draft with setState prompt', () => {
    const loopName = 'test-loop-3-' + Date.now()
    const sessionId = 'session-3-' + Date.now()
    const draftPlan = 'Draft plan'
    const executionPlan = 'Execution plan (should win)'

    // Write draft to plans table
    plansRepo.writeForLoop(projectId, loopName, draftPlan)

    // Create loop state with different prompt, which writes to plans table via setState
    loopService.setState(loopName, makeState({ loopName, sessionId, prompt: executionPlan }))

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

  it('getPlanTextForState reads plan from plans table', () => {
    const loopName = 'test-loop-4-' + Date.now()
    const sessionId = 'session-4-' + Date.now()
    const planText = 'Plan for getPlanTextForState'

    loopService.setState(loopName, makeState({ loopName, sessionId, prompt: planText }))

    const retrievedState = loopService.getActiveState(loopName)
    expect(retrievedState).not.toBeNull()
    
    // Verify plan is retrievable via plans table (not large fields)
    const result = loopService.getPlanText(loopName, sessionId)
    expect(result).toBe(planText)
  })

  it('hydrates state.prompt from plans table when loading via getAnyState', () => {
    const loopName = 'test-loop-hydrate-' + Date.now()
    const sessionId = 'session-hydrate-' + Date.now()
    const planText = 'Hydration test plan content'

    // Write plan directly to plans table (like a draft would)
    plansRepo.writeForLoop(projectId, loopName, planText)

    // Create loop state without prompt (simulating DB load where prompt isn't stored in large fields)
    loopService.setState(loopName, makeState({ loopName, sessionId }))

    // getAnyState should hydrate prompt from plans table
    const loadedState = loopService.getAnyState(loopName)
    expect(loadedState).not.toBeNull()
    expect(loadedState!.prompt).toBe(planText)

    // Also verify via getActiveState
    const activeState = loopService.getActiveState(loopName)
    expect(activeState).not.toBeNull()
    expect(activeState!.prompt).toBe(planText)
  })

  it('persists plan text across stop and state reload', () => {
    const loopName = 'test-loop-stop-reload-' + Date.now()
    const sessionId = 'session-stop-' + Date.now()
    const planText = 'Persistent plan content for restart test'

    // Create stopped loop with plan
    loopService.setState(loopName, makeState({ loopName, sessionId, prompt: planText, active: false }))

    // Terminate the loop so it's not "active"
    loopsRepo.setStatus(projectId, loopName, 'completed')
    loopsRepo.terminate(projectId, loopName, {
      status: 'completed',
      reason: 'completed',
      completedAt: Date.now(),
    })

    // Load the completed/terminated loop state
    const loadedState = loopService.getAnyState(loopName)
    expect(loadedState).not.toBeNull()

    // Plan should be available from plans table even though loop is no longer active
    expect(loadedState!.prompt).toBe(planText)

    // getPlanText should also still work
    const planResult = loopService.getPlanText(loopName, sessionId)
    expect(planResult).toBe(planText)
  })

  it('keeps plan text available after session rotation', () => {
    const loopName = 'test-loop-session-rotate-' + Date.now()
    const originalSessionId = 'session-original-' + Date.now()
    const newSessionId = 'session-new-' + Date.now()
    const planText = 'Session rotation plan content'

    loopService.setState(loopName, makeState({ loopName, sessionId: originalSessionId, prompt: planText }))

    // Rotate the session (replace old session ID with new one)
    loopService.replaceSession(loopName, {
      newSessionId,
      phase: 'coding',
    })

    // After session rotation, plan should be accessible by loop name
    const planAfterRotation = loopService.getPlanText(loopName, newSessionId)
    expect(planAfterRotation).toBe(planText)

    // Hydrated state should also have the prompt
    const updatedState = loopService.getActiveState(loopName)
    expect(updatedState).not.toBeNull()
    expect(updatedState!.prompt).toBe(planText)
    expect(updatedState!.sessionId).toBe(newSessionId)
  })

  it('returns null when only the loop exists but no plan is written', () => {
    const loopName = 'test-loop-no-plan-' + Date.now()
    const sessionId = 'session-no-plan-' + Date.now()

    loopService.setState(loopName, makeState({ loopName, sessionId }))

    // No plan was written - both should return null
    const result = loopService.getPlanText(loopName, sessionId)
    expect(result).toBeNull()

    const loadedState = loopService.getAnyState(loopName)
    expect(loadedState).not.toBeNull()
    expect(loadedState!.prompt).toBeUndefined()
  })
})
