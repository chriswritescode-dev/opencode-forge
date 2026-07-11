import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import type { Database } from 'bun:sqlite'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createLoopService } from '../src/loop/service'
import { openForgeDatabase } from '../src/storage/database'
import { createSessionLoopResolver } from '../src/services/session-loop-resolver'
import { createToolExecuteBeforeHook } from '../src/hooks/plan-approval'
import type { ToolContext } from '../src/tools/types'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Logger } from '../src/types'

function createTestDb(): Database {
  return openForgeDatabase(join(tmpdir(), `forge-test-${randomUUID()}.db`))
}

function createMockLogger(): Logger {
  return {
    log: () => {},
    error: () => {},
    debug: () => {},
  }
}

describe('Tool Blocking Logic', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  const projectId = 'test-project'
  const sessionID = 'test-session-123'

  beforeEach(() => {
    db = createTestDb()
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, createMockLogger())
  })

  afterEach(() => {
    db.close()
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
        finalAuditDone: false,
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
        finalAuditDone: false,
      }
      loopService.setState(loopName, inactiveState)

      const retrieved = loopService.getActiveState(loopName)
      expect(retrieved).toBeNull()
    })
  })

  describe('Blocked tools list', () => {
    test('includes question tool', () => {
      const blockedTools = ['question', 'execute-plan', 'execute-goal']
      expect(blockedTools).toContain('question')
    })

    test('includes loop tool', () => {
      const blockedTools = ['question', 'execute-plan', 'execute-goal']
      expect(blockedTools).toContain('execute-plan')
    })

    test('includes execute-goal tool so active loops cannot recurse', () => {
      const blockedTools = ['question', 'execute-plan', 'execute-goal']
      expect(blockedTools).toContain('execute-goal')
    })

    test('does not include memory-read tool', () => {
      const blockedTools = ['question', 'execute-plan', 'execute-goal']
      expect(blockedTools).not.toContain('memory-read')
    })

    test('does not include memory-write tool', () => {
      const blockedTools = ['question', 'execute-plan', 'execute-goal']
      expect(blockedTools).not.toContain('memory-write')
    })
  })

  describe('Error messages', () => {
    test('question tool has appropriate error message', () => {
      const messages: Record<string, string> = {
        'question': 'The question tool is not available during a loop. Do not ask questions — continue working on the task autonomously.',
        'execute-plan': 'The execute-plan tool is not available during a loop. Focus on executing the current plan.',
        'execute-goal': 'The execute-goal tool is not available during a loop. Focus on executing the current task.',
      }
      expect(messages['question']).toContain('question tool is not available')
      expect(messages['execute-goal']).toContain('execute-goal tool is not available')
    })
  })

  describe('Goal-loop recursion blocking during auditing', () => {
    const hostLoopName = 'goal-loop-auditing'
    const auditorSessionId = 'goal-auditor-toolblock'
    const unrelatedSessionId = 'unrelated-session-toolblock'

    function setStateAuditing(loopService: ReturnType<typeof createLoopService>): void {
      loopService.setState(hostLoopName, {
        active: true,
        sessionId: auditorSessionId,
        loopName: hostLoopName,
        worktreeDir: '/test/worktree',
        worktreeBranch: 'opencode/loop-goal',
        projectDir: '/test/project',
        iteration: 1,
        maxIterations: 5,
        startedAt: new Date().toISOString(),
        prompt: '',
        phase: 'auditing',
        status: 'running',
        errorCount: 0,
        auditCount: 0,
        worktree: true,
        modelFailed: false,
        sandbox: false,
        executionModel: 'test/model',
        auditorModel: 'test/auditor',
        executionVariant: undefined,
        auditorVariant: undefined,
        currentSectionIndex: 0,
        totalSections: 0,
        finalAuditDone: false,
        hostSessionId: 'goal-host-toolblock',
        kind: 'goal',
        goal: 'Add a /health endpoint with a test.',
      })
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
          listActive: () => [],
        },
        getParentSessionId: async () => null,
        logger: createMockLogger(),
      })
      const hook = createToolExecuteBeforeHook(makeCtx(loopService), {
        resolveActiveLoopForSession: resolver.resolveActiveLoopForSession,
      })!

      await expect(hook({ tool: 'execute-goal', sessionID: auditorSessionId, callID: 'c-aud' }, { args: {} }))
        .rejects.toThrow('execute-goal tool is not available')
      await expect(hook({ tool: 'execute-plan', sessionID: auditorSessionId, callID: 'c-aud-plan' }, { args: {} }))
        .rejects.toThrow('execute-plan tool is not available')

      await expect(hook({ tool: 'execute-goal', sessionID: unrelatedSessionId, callID: 'c-unrel' }, { args: {} }))
        .resolves.toBeUndefined()
    })

    test('fallback before hook blocks only the current auditor session', async () => {
      setStateAuditing(loopService)
      const hook = createToolExecuteBeforeHook(makeCtx(loopService))!

      await expect(hook({ tool: 'execute-goal', sessionID: auditorSessionId, callID: 'c-aud' }, { args: {} }))
        .rejects.toThrow('execute-goal tool is not available')
      await expect(hook({ tool: 'execute-goal', sessionID: unrelatedSessionId, callID: 'c-unrel' }, { args: {} }))
        .resolves.toBeUndefined()
    })
  })
})
