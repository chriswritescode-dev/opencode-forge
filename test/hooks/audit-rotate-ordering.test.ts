import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createLoopService } from '../../src/loop/service'
import type { PluginConfig } from '../../src/types'
import { createFakeForgeClient } from '../helpers/fake-client'
import { makeLoopState } from '../helpers/loop-fixtures'
import { createMockLogger } from '../helpers/logger'
import { createTestDb } from '../helpers/test-db'

/**
 * Build a ForgeClient fake whose recorded calls are unified, so call ordering
 * across namespaces can be asserted.
 * @param lastRole - The role of the last message in the messages response ('assistant' or 'user')
 */
function makeRotationFake(lastRole: 'assistant' | 'user' = 'assistant') {
  return createFakeForgeClient({
    session: {
      create: async () => ({ id: 'new-code-1' }),
      get: async () => ({ id: 'sess' }),
      messages: async () => [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'test' }] },
        ...(lastRole === 'assistant'
          ? [{ info: { role: 'assistant' as const, finish: 'stop' as const }, parts: [{ type: 'text' as const, text: 'response' }] }]
          : []),
      ],
    },
    workspace: {
      create: async () => ({ id: 'ws-1' }),
    },
  })
}

describe('audit→code rotation ordering', () => {
  let testDb: ReturnType<typeof createTestDb>
  let db: ReturnType<typeof createTestDb>['db']
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let loopService: ReturnType<typeof createLoopService>
  let tempDir: string
  const projectId = 'test-project'

  const mockLogger = createMockLogger()

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'audit-rotate-ordering-test-'))
    testDb = createTestDb({ path: join(tempDir, 'forge.db') })
    db = testDb.db

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)

    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger)
  })

  afterEach(() => {
    testDb.cleanup()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup
    }
    vi.clearAllMocks()
  })

  test('successful audit→code rotation: create→bind order, audit session retained', async () => {
    const loopName = 'test-rotate-order'
    const worktreeDir = join(tempDir, 'worktree')
    
    const state = makeLoopState({
      sessionId: 'audit-1',
      loopName,
      worktreeDir,
      projectDir: '/tmp/project',
      worktreeBranch: 'feature-branch',
      maxIterations: 10,
      phase: 'auditing',
      executionModel: 'test/test-model',
      auditorModel: 'test/test-auditor',
      workspaceId: 'ws-1',
      totalSections: 1,
    })

    loopService.setState(loopName, state)
    loopService.registerLoopSession('audit-1', loopName)

    // Add an outstanding review finding so the successful audit path triggers
    // rotation instead of termination (checkAuditClearAndTerminate returns false)
    reviewFindingsRepo.write({
      projectId,
      loopName,
      file: 'src/example.ts',
      line: 10,
      severity: 'bug',
      description: 'Test finding to prevent audit all-clear',
    })

    // Create mock that returns successful assistant response to exercise the
    // successful audit→code rotation path (not the error continuation path)
    const { client, calls } = makeRotationFake()
    // Use default successful assistant response (no error) to test the
    // !assistantErrorDetected branch in handleAuditingPhase

    const { createLoopEventHandler } = await import('../../src/hooks/loop')
    const handler = createLoopEventHandler(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      projectId,
      client,
      mockLogger,
      () => ({ loop: { model: 'test/test-model' } } as PluginConfig),
      undefined,
      tempDir,
    )

    await handler.onEvent({
      event: {
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: 'audit-1',
        },
      },
    })

    const createIndex = calls.findIndex(c => c.method === 'session.create')
    const restoreIndex = calls.findIndex(c => c.method === 'workspace.warp')
    const deleteIndex = calls.findIndex(c =>
      c.method === 'session.delete' && (c.params as any).sessionID === 'audit-1'
    )

    expect(createIndex).toBeGreaterThanOrEqual(0)
    expect(restoreIndex).toBeGreaterThanOrEqual(0)

    // Order: create new session → bind (restore) workspace. The audit session is
    // retained as the standby for the next same-section attempt, so it is not deleted.
    expect(createIndex).toBeLessThan(restoreIndex)
    expect(deleteIndex).toBe(-1)

    const after = loopService.getActiveState(loopName)!
    expect(after.phase).toBe('coding')
    expect(after.sessionId).toBe('new-code-1')

    const restoreCall = calls.find(c => c.method === 'workspace.warp')
    expect((restoreCall?.params as any).id).toBe('ws-1')
    expect((restoreCall?.params as any).sessionID).toBe('new-code-1')
  })

  test('audit failure rotation: create→bind→delete order', async () => {
    const loopName = 'test-rotate-failure-order'
    const worktreeDir = join(tempDir, 'worktree')
    
    const state = makeLoopState({
      sessionId: 'audit-fail-1',
      loopName,
      worktreeDir,
      projectDir: '/tmp/project',
      worktreeBranch: 'feature-branch',
      maxIterations: 10,
      phase: 'auditing',
      executionModel: 'test/test-model',
      auditorModel: 'test/test-auditor',
      workspaceId: 'ws-1',
      totalSections: 1,
    })

    loopService.setState(loopName, state)
    loopService.registerLoopSession('audit-fail-1', loopName)

    // Create a separate mock for failure path - no assistant message so it triggers rotation
    const { client, calls } = makeRotationFake('user')

    const { createLoopEventHandler } = await import('../../src/hooks/loop')
    const handler = createLoopEventHandler(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      projectId,
      client,
      mockLogger,
      () => ({ loop: { model: 'test/test-model' } } as PluginConfig),
      undefined,
      tempDir,
    )

    await handler.onEvent({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'audit-fail-1',
          error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
        },
      },
    })

    const createIndex = calls.findIndex(c => c.method === 'session.create')
    const restoreIndex = calls.findIndex(c => c.method === 'workspace.warp')
    const deleteIndex = calls.findIndex(c =>
      c.method === 'session.delete' && (c.params as any).sessionID === 'audit-fail-1'
    )

    expect(createIndex).toBeGreaterThanOrEqual(0)
    expect(restoreIndex).toBeGreaterThanOrEqual(0)
    expect(deleteIndex).toBeGreaterThanOrEqual(0)

    // Order: create new session → bind (restore) workspace → delete old session
    expect(createIndex).toBeLessThan(restoreIndex)
    expect(restoreIndex).toBeLessThan(deleteIndex)

    const restoreCall = calls.find(c => c.method === 'workspace.warp')
    expect((restoreCall?.params as any).id).toBe('ws-1')
  })
})
