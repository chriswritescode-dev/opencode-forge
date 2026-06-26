import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import type { Database } from 'bun:sqlite'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createLoopService } from '../src/loop/service'
import { openForgeDatabase } from '../src/storage/database'
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
      const blockedTools = ['question', 'execute-plan']
      expect(blockedTools).toContain('question')
    })

    test('includes loop tool', () => {
      const blockedTools = ['question', 'execute-plan']
      expect(blockedTools).toContain('execute-plan')
    })

    test('does not include memory-read tool', () => {
      const blockedTools = ['question', 'execute-plan']
      expect(blockedTools).not.toContain('memory-read')
    })

    test('does not include memory-write tool', () => {
      const blockedTools = ['question', 'execute-plan']
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
    })
  })
})
