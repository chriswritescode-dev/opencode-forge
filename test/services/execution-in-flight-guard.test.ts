import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/loop/service'
import type { Logger } from '../../src/types'
import type { LoopsRepo } from '../../src/storage/repos/loops-repo'
import type { PlansRepo } from '../../src/storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import type { SectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import {
  markPromptInFlight,
  getPromptInFlight,
  __resetInFlightGuard,
} from '../../src/loop/in-flight-guard'
import type { PromptAgent } from '../../src/loop/in-flight-guard'
import { setupLoopsTestDb } from '../helpers/loops-test-db'

const noopFn = () => {}

const PROJECT_ID = 'test-project'

describe('execution in-flight guard', () => {
  let db: Database
  let loopsRepo: LoopsRepo
  let plansRepo: PlansRepo
  let reviewFindingsRepo: ReviewFindingsRepo
  let sectionPlansRepo: SectionPlansRepo
  let tempDir: string

  const mockLogger: Logger = {
    log: () => {},
    error: () => {},
    debug: () => {},
  }

  beforeEach(() => {
    __resetInFlightGuard()
    tempDir = mkdtempSync(join(tmpdir(), 'exec-guard-test-'))
    db = new Database(join(tempDir, 'test.db'))

    setupLoopsTestDb(db)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
  })

  afterEach(() => {
    try { db.close() } catch {}
    __resetInFlightGuard()
  })

  describe('restart prompt path', () => {
    test('rejects restart prompt when another prompt is in-flight', async () => {
      const noopFn = () => {}

      loopsRepo.insert({
        projectId: PROJECT_ID,
        loopName: 'guard-loop',
        status: 'stalled',
        currentSessionId: 'old-session',
        worktree: false,
        worktreeDir: '/tmp',
        worktreeBranch: null,
        projectDir: '/tmp',
        maxIterations: 10,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'coding',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: Date.now(),
        completedAt: null,
        terminationReason: 'stall_timeout',
        workspaceId: null,
        hostSessionId: null,
        currentSectionIndex: 0,
        totalSections: 5,
        finalAuditDone: 0,
      }, { lastAuditResult: null })

      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: 'guard-loop',
        sections: [
          { index: 0, title: 'A', content: 'a' },
          { index: 1, title: 'B', content: 'b' },
        ],
      })

      const mockV2Client = {
        session: {
          create: async () => ({ data: { id: 'new-sess-999' } }),
          get: async () => ({ data: {} }),
          promptAsync: async () => ({ error: null, data: null }),
          abort: async () => ({}),
          delete: async () => ({}),
          messages: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
        },
        experimental: {
          workspace: { list: async () => ({ data: [] }), remove: async () => ({}) },
          session: { list: async () => ({ data: [] }) },
        },
        tui: { publish: async () => ({}), selectSession: async () => ({}) },
        worktree: { create: async () => ({ data: { directory: '/tmp/wt', branch: 'main' } }) },
      }

      const loopService = createLoopService(
        loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger,
        undefined, undefined, undefined, sectionPlansRepo,
      )

      const mockLoopHandler = {
        runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
        startWatchdog: noopFn,
        clearLoopTimers: noopFn,
      }

      const { createForgeExecutionService } = await import('../../src/services/execution')
      const service = createForgeExecutionService({
        projectId: PROJECT_ID,
        directory: '/tmp/test',
        config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
        logger: mockLogger,
        dataDir: '/tmp',
        v2: mockV2Client as any,
        plansRepo,
        loopsRepo,
        loop: loopService as any,
        loopHandler: mockLoopHandler as any,
        sectionPlansRepo,
      } as any)

      markPromptInFlight('guard-loop', 'other-prompt-sess', 'code')

      const result = await service.dispatch(
        { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
        {
          type: 'loop.restart' as const,
          selector: { kind: 'exact' as const, name: 'guard-loop' },
        },
      )

      if (result.ok) {
        expect.fail('Expected promptAsync not to be called while guard is active')
      }

      const remaining = getPromptInFlight('guard-loop')
      expect(remaining).toBeDefined()
      expect(remaining!.sessionId).toBe('other-prompt-sess')
      expect(remaining!.agent).toBe('code')

      const restoredState = loopService.getAnyState('guard-loop')
      expect(restoredState).toBeDefined()
      expect(restoredState!.active).toBe(false)
      expect(restoredState!.sessionId).toBe('old-session')

      const sectionPlans = sectionPlansRepo.list(PROJECT_ID, 'guard-loop')
      expect(sectionPlans.length).toBe(2)
    })

    test('configured-model restart prompt failure falls back without ConcurrentPromptError', async () => {
      let promptCallCount = 0

      loopsRepo.insert({
        projectId: PROJECT_ID,
        loopName: 'retry-loop',
        status: 'stalled',
        currentSessionId: 'old-session',
        worktree: false,
        worktreeDir: '/tmp',
        worktreeBranch: null,
        projectDir: '/tmp',
        maxIterations: 10,
        iteration: 3,
        auditCount: 0,
        errorCount: 0,
        phase: 'coding',
        executionModel: 'prov/exec',
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: Date.now(),
        completedAt: null,
        terminationReason: 'stall_timeout',
        workspaceId: null,
        hostSessionId: null,
        currentSectionIndex: 2,
        totalSections: 5,
        finalAuditDone: 0,
      }, { lastAuditResult: null })

      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: 'retry-loop',
        sections: [
          { index: 0, title: 'A', content: 'a' },
          { index: 1, title: 'B', content: 'b' },
          { index: 2, title: 'C', content: 'c' },
          { index: 3, title: 'D', content: 'd' },
          { index: 4, title: 'E', content: 'e' },
        ],
      })

      const mockV2Client = {
        session: {
          create: async () => ({ data: { id: 'new-sess-888' } }),
          get: async () => ({ data: {} }),
          promptAsync: async () => {
            promptCallCount++
            if (promptCallCount <= 2) {
              return { error: new Error('model unavailable'), data: undefined }
            }
            return { error: null, data: null }
          },
          abort: async () => ({}),
          delete: async () => ({}),
          messages: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
        },
        experimental: {
          workspace: { list: async () => ({ data: [] }), remove: async () => ({}) },
          session: { list: async () => ({ data: [] }) },
        },
        tui: { publish: async () => ({}), selectSession: async () => ({}) },
        worktree: { create: async () => ({ data: { directory: '/tmp/wt', branch: 'main' } }) },
      }

      const loopService = createLoopService(
        loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger,
        undefined, undefined, undefined, sectionPlansRepo,
      )

      const mockLoopHandler = {
        runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
        startWatchdog: noopFn,
        clearLoopTimers: noopFn,
      }

      const { createForgeExecutionService } = await import('../../src/services/execution')
      const service = createForgeExecutionService({
        projectId: PROJECT_ID,
        directory: '/tmp/test',
        config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
        logger: mockLogger,
        dataDir: '/tmp',
        v2: mockV2Client as any,
        plansRepo,
        loopsRepo,
        loop: loopService as any,
        loopHandler: mockLoopHandler as any,
        sectionPlansRepo,
      } as any)

      const result = await service.dispatch(
        { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
        {
          type: 'loop.restart' as const,
          selector: { kind: 'exact' as const, name: 'retry-loop' },
        },
      )

      expect(result.ok).toBe(true)
      expect(promptCallCount).toBe(3)
      expect(getPromptInFlight('retry-loop')).toBeUndefined()
    })

    test('configured-model restart prompt failure clears guard after each attempt', async () => {
      let promptCallCount = 0

      loopsRepo.insert({
        projectId: PROJECT_ID,
        loopName: 'cleanup-loop',
        status: 'stalled',
        currentSessionId: 'old-session',
        worktree: false,
        worktreeDir: '/tmp',
        worktreeBranch: null,
        projectDir: '/tmp',
        maxIterations: 10,
        iteration: 2,
        auditCount: 0,
        errorCount: 0,
        phase: 'coding',
        executionModel: 'prov/exec',
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: Date.now(),
        completedAt: null,
        terminationReason: 'stall_timeout',
        workspaceId: null,
        hostSessionId: null,
        currentSectionIndex: 1,
        totalSections: 4,
        finalAuditDone: 0,
      }, { lastAuditResult: null })

      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: 'cleanup-loop',
        sections: [
          { index: 0, title: 'A', content: 'a' },
          { index: 1, title: 'B', content: 'b' },
          { index: 2, title: 'C', content: 'c' },
          { index: 3, title: 'D', content: 'd' },
        ],
      })

      const mockV2Client = {
        session: {
          create: async () => ({ data: { id: 'new-sess-777' } }),
          get: async () => ({ data: {} }),
          promptAsync: async () => {
            promptCallCount++
            if (promptCallCount === 1) {
              return { error: new Error('model unavailable'), data: undefined }
            }
            return { error: null, data: null }
          },
          abort: async () => ({}),
          delete: async () => ({}),
          messages: async () => ({ data: [] }),
          status: async () => ({ data: {} }),
        },
        experimental: {
          workspace: { list: async () => ({ data: [] }), remove: async () => ({}) },
          session: { list: async () => ({ data: [] }) },
        },
        tui: { publish: async () => ({}), selectSession: async () => ({}) },
        worktree: { create: async () => ({ data: { directory: '/tmp/wt', branch: 'main' } }) },
      }

      const loopService = createLoopService(
        loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, mockLogger,
        undefined, undefined, undefined, sectionPlansRepo,
      )

      const mockLoopHandler = {
        runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
        startWatchdog: noopFn,
        clearLoopTimers: noopFn,
      }

      const { createForgeExecutionService } = await import('../../src/services/execution')
      const service = createForgeExecutionService({
        projectId: PROJECT_ID,
        directory: '/tmp/test',
        config: { loop: { enabled: true }, executionModel: 'prov/exec', auditorModel: 'prov/aud' },
        logger: mockLogger,
        dataDir: '/tmp',
        v2: mockV2Client as any,
        plansRepo,
        loopsRepo,
        loop: loopService as any,
        loopHandler: mockLoopHandler as any,
        sectionPlansRepo,
      } as any)

      const result = await service.dispatch(
        { surface: 'api', projectId: PROJECT_ID, directory: '/tmp/test' },
        {
          type: 'loop.restart' as const,
          selector: { kind: 'exact' as const, name: 'cleanup-loop' },
        },
      )

      expect(result.ok).toBe(true)
      expect(promptCallCount).toBe(2)
      expect(getPromptInFlight('cleanup-loop')).toBeUndefined()
    })
  })
})
