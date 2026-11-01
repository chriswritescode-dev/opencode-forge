import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import type { Database } from 'bun:sqlite'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createLoopService } from '../src/loop/service'
import { createSessionLoopResolver } from '../src/services/session-loop-resolver'
import { createToolExecuteBeforeHook } from '../src/hooks/plan-approval'
import type { ToolContext } from '../src/tools/types'
import { createTestDb } from './helpers/test-db'
import { makeLoopState } from './helpers/loop-fixtures'
import { createMockLogger } from './helpers/logger'

describe('Tool Blocking Logic', () => {
  let db: Database
  let testDb: ReturnType<typeof createTestDb>
  let loopService: ReturnType<typeof createLoopService>
  const projectId = 'test-project'
  const sessionID = 'test-session-123'

  beforeEach(() => {
    testDb = createTestDb()
    db = testDb.db
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, createMockLogger())
  })

  afterEach(() => {
    testDb.cleanup()
  })

  describe('Loop state lookup', () => {
    test('getActiveState returns active state when loop is active', () => {
      const loopName = 'test-worktree'
      const state = {
        active: true,
        sessionId: sessionID,
        loopName,
        worktreeDir: '/test/worktree',
        worktreeBranch: 'opencode/loop-test',
        iteration: 1,
        maxIterations: 5,
        startedAt: new Date().toISOString(),
        prompt: 'Test prompt',
        phase: 'coding' as const,
        status: 'running' as const,
        errorCount: 0,
        auditCount: 0,
        worktree: true,
        currentSectionIndex: 0,
        totalSections: 0,
      }
      loopService.setState(loopName, state)

      const retrieved = loopService.getActiveState(loopName)
      expect(retrieved).toMatchObject(state)
      expect(retrieved?.active).toBe(true)
    })

    test('getActiveState returns null when no loop exists', () => {
      const retrieved = loopService.getActiveState('non-existent-loop')
      expect(retrieved).toBeNull()
    })

    test('getActiveState returns null when loop is inactive', () => {
      const loopName = 'test-worktree-inactive'
      const inactiveState = {
        active: false,
        sessionId: sessionID,
        loopName,
        worktreeDir: '/test/worktree',
        worktreeBranch: 'opencode/loop-test',
        iteration: 1,
        maxIterations: 5,
        startedAt: new Date().toISOString(),
        prompt: 'Test prompt',
        phase: 'coding' as const,
        status: 'completed' as const,
        errorCount: 0,
        auditCount: 0,
        worktree: true,
        currentSectionIndex: 0,
        totalSections: 0,
      }
      loopService.setState(loopName, inactiveState)

      const retrieved = loopService.getActiveState(loopName)
      expect(retrieved).toBeNull()
    })
  })

  describe('Blocked tools list', () => {
    test('includes question tool', () => {
      const blockedTools = ['question', 'execute-plan', 'loop-status']
      expect(blockedTools).toContain('question')
    })

    test('includes loop tool', () => {
      const blockedTools = ['question', 'execute-plan', 'loop-status']
      expect(blockedTools).toContain('execute-plan')
    })

    test('does not include memory-read tool', () => {
      const blockedTools = ['question', 'execute-plan', 'loop-status']
      expect(blockedTools).not.toContain('memory-read')
    })

    test('does not include memory-write tool', () => {
      const blockedTools = ['question', 'execute-plan', 'loop-status']
      expect(blockedTools).not.toContain('memory-write')
    })
  })

  describe('Error messages', () => {
    test('question tool has appropriate error message', () => {
      const messages: Record<string, string> = {
        'question': 'The question tool is not available during a loop. Do not ask questions — continue working on the task autonomously.',
        'execute-plan': 'The execute-plan tool is not available during a loop. Focus on executing the current plan.',
      }
      expect(messages['question']).toContain('question tool is not available')
      expect(messages['execute-plan']).toContain('execute-plan tool is not available')
    })
  })

  describe('Recursion blocking during auditing', () => {
    const hostLoopName = 'loop-auditing'
    const auditorSessionId = 'auditor-toolblock'
    const unrelatedSessionId = 'unrelated-session-toolblock'

    function setStateAuditing(loopService: ReturnType<typeof createLoopService>): void {
      loopService.setState(
        hostLoopName,
        makeLoopState({
          sessionId: auditorSessionId,
          loopName: hostLoopName,
          worktreeDir: '/test/worktree',
          worktreeBranch: 'opencode/loop-auditing',
          projectDir: '/test/project',
          prompt: '',
          phase: 'auditing',
          hostSessionId: 'host-toolblock',
        }),
      )
      loopService.registerLoopSession(auditorSessionId, hostLoopName)
    }

    function makeCtx(loopService: ReturnType<typeof createLoopService>): ToolContext {
      return {
        loop: { service: loopService },
        logger: createMockLogger(),
      } as unknown as ToolContext
    }

    test('resolver-backed before hook blocks recursive tools for the auditor session', async () => {
      setStateAuditing(loopService)
      const resolver = createSessionLoopResolver({
        loop: {
          service: loopService,
        },
        getParentSessionId: async () => null,
        logger: createMockLogger(),
      })
      const hook = createToolExecuteBeforeHook(makeCtx(loopService), {
        resolveActiveLoopForSession: resolver.resolveActiveLoopForSession,
      })!

      await expect(hook({ tool: 'execute-plan', sessionID: auditorSessionId, callID: 'c-aud' }, { args: {} }))
        .rejects.toThrow('execute-plan tool is not available')
      await expect(hook({ tool: 'execute-plan', sessionID: auditorSessionId, callID: 'c-aud-plan' }, { args: {} }))
        .rejects.toThrow('execute-plan tool is not available')

      await expect(hook({ tool: 'execute-plan', sessionID: unrelatedSessionId, callID: 'c-unrel' }, { args: {} }))
        .resolves.toBeUndefined()
    })

    test('resolver-backed before hook blocks goal-write inside a loop session', async () => {
      setStateAuditing(loopService)
      const resolver = createSessionLoopResolver({
        loop: {
          service: loopService,
        },
        getParentSessionId: async () => null,
        logger: createMockLogger(),
      })
      const hook = createToolExecuteBeforeHook(makeCtx(loopService), {
        resolveActiveLoopForSession: resolver.resolveActiveLoopForSession,
      })!

      await expect(hook({ tool: 'goal-write', sessionID: auditorSessionId, callID: 'c-goal' }, { args: {} }))
        .rejects.toThrow('goal-write tool is not available')
      await expect(hook({ tool: 'goal-write', sessionID: unrelatedSessionId, callID: 'c-goal-unrel' }, { args: {} }))
        .resolves.toBeUndefined()
    })

    test('resolver-backed before hook blocks the goal management tools inside a loop session', async () => {
      setStateAuditing(loopService)
      const resolver = createSessionLoopResolver({
        loop: {
          service: loopService,
        },
        getParentSessionId: async () => null,
        logger: createMockLogger(),
      })
      const hook = createToolExecuteBeforeHook(makeCtx(loopService), {
        resolveActiveLoopForSession: resolver.resolveActiveLoopForSession,
      })!

      await expect(hook({ tool: 'goal-status', sessionID: auditorSessionId, callID: 'c-goal-status' }, { args: {} }))
        .rejects.toThrow('goal-status tool is not available')
      await expect(hook({ tool: 'goal-cancel', sessionID: auditorSessionId, callID: 'c-goal-cancel' }, { args: {} }))
        .rejects.toThrow('goal-cancel tool is not available')
      await expect(hook({ tool: 'goal-status', sessionID: unrelatedSessionId, callID: 'c-goal-status-unrel' }, { args: {} }))
        .resolves.toBeUndefined()
    })

    test('fallback before hook blocks only the current auditor session', async () => {
      setStateAuditing(loopService)
      const hook = createToolExecuteBeforeHook(makeCtx(loopService))!

      await expect(hook({ tool: 'execute-plan', sessionID: auditorSessionId, callID: 'c-aud' }, { args: {} }))
        .rejects.toThrow('execute-plan tool is not available')
      await expect(hook({ tool: 'execute-plan', sessionID: unrelatedSessionId, callID: 'c-unrel' }, { args: {} }))
        .resolves.toBeUndefined()
    })
  })
})
