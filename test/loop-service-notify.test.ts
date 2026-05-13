import { describe, it, expect, mock } from 'bun:test'
import { createLoop } from '../src/loop/runtime'
import type { LoopChangeNotifier } from '../src/loop/service'
import type { LoopsRepo } from '../src/storage/repos/loops-repo'
import type { PlansRepo } from '../src/storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import type { Logger } from '../src/types'

// Mock repos
function createMockRepos() {
  const mockLoopsRepo = {
    insert: () => true,
    get: () => null,
    getLarge: () => null,
    delete: () => {},
    setStatus: () => {},
    setCurrentSessionId: () => {},
    getBySessionId: () => null,
    findPartial: () => ({ match: null, candidates: [] }),
    listByStatus: () => [],
    updatePhase: () => {},
    setPhaseAndResetError: () => {},
    setModelFailed: () => {},
    setLastAuditResult: () => {},
    replaceSession: () => {},
    terminate: () => {},
    setSandboxContainer: () => {},
    clearWorkspaceId: () => {},
    setWorkspaceId: () => {},
    incrementError: () => 0,
    resetError: () => {},
  } as unknown as LoopsRepo

  const mockPlansRepo = {} as PlansRepo
  const mockReviewFindingsRepo = {} as ReviewFindingsRepo
  const mockLogger = { log: () => {}, error: () => {}, debug: () => {} } as Logger

  return { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger }
}

describe('LoopChangeNotifier', () => {
  const baseState = {
    active: true,
    sessionId: 's1',
    loopName: 'test-loop',
    worktreeDir: '/test',
    projectDir: '/test',
    iteration: 1,
    maxIterations: 5,
    startedAt: new Date().toISOString(),
    phase: 'coding' as const,
    errorCount: 0,
    auditCount: 0,
  }

  describe('setState', () => {
    it('should be called with insert reason when setState is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      loop.setState('test-loop', baseState as any)

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('insert')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('deleteState', () => {
    it('should be called with delete reason when deleteState is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      loop.deleteState('test-loop')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('delete')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('setStatus', () => {
    it('should be called with status reason when setStatus is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      loop.setStatus('test-loop', 'running')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('status')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('registerLoopSession', () => {
    it('should be called with session reason when registerLoopSession is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      loop.registerLoopSession('s1', 'test-loop')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('session')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('incrementError', () => {
    it('should be called with error reason when incrementError is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      loop.incrementError('test-loop')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('error')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('resetError', () => {
    it('should be called with error reason when resetError is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      loop.resetError('test-loop')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('error')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('setPhase', () => {
    it('should be called with phase reason when setPhase is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      loop.setPhase('test-loop', 'auditing')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('phase')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('setPhaseAndResetError', () => {
    it('should be called with phase reason when setPhaseAndResetError is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      loop.setPhaseAndResetError('test-loop', 'auditing')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('phase')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('setModelFailed', () => {
    it('should be called with model-failed reason when setModelFailed is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      loop.setModelFailed('test-loop', true)

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('model-failed')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('setLastAuditResult', () => {
    it('should be called with audit-result reason when setLastAuditResult is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      loop.setLastAuditResult('test-loop', 'audit result text')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('audit-result')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })



  describe('replaceSession', () => {
    it('should be called with rotate reason when replaceSession is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      loop.replaceSession('test-loop', { newSessionId: 's5', phase: 'auditing' })

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('rotate')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('terminate', () => {
    it('should be called with terminate reason when terminate is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      loop.terminateLoop('test-loop', { status: 'completed', reason: 'done', completedAt: Date.now() })

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('terminate')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('setSandboxContainer', () => {
    it('should be called with sandbox reason when setSandboxContainer is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      loop.setSandboxContainer('test-loop', 'container-123')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('sandbox')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('clearWorkspaceId', () => {
    it('should be called with workspace reason when clearWorkspaceId is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      loop.clearWorkspaceId('test-loop')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('workspace')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('setWorkspaceId', () => {
    it('should be called with workspace reason when setWorkspaceId is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      loop.setWorkspaceId('test-loop', 'ws-123')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('workspace')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('terminateAll', () => {
    it('should be called with terminate reason for each loop when terminateAll is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()

      const now = Date.now()
      const validRow = {
        loopName: 'loop-1',
        status: 'running' as const,
        currentSessionId: 's1',
        worktree: false,
        worktreeDir: '/test',
        worktreeBranch: null,
        projectDir: '/test',
        maxIterations: 5,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'coding' as const,
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        loopId: 1,
        projectId: 'test-project',
      }

      // Mock listActive to return two loops with valid row data
      mockLoopsRepo.listByStatus = () => [validRow, { ...validRow, loopName: 'loop-2' }]
      mockLoopsRepo.getLarge = () => ({ prompt: 'test prompt', lastAuditResult: null })

      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      loop.terminateAll()

      expect(notifyCalls.length).toBe(2)
      expect(notifyCalls[0].reason).toBe('terminate')
      expect(notifyCalls[0].loopName).toBe('loop-1')
      expect(notifyCalls[1].reason).toBe('terminate')
      expect(notifyCalls[1].loopName).toBe('loop-2')
    })
  })

  describe('reconcileStale', () => {
    it('should cancel all loops when called without opts (back-compatible)', async () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()

      const now = Date.now()
      const validRow = {
        loopName: 'stale-loop',
        status: 'running' as const,
        currentSessionId: 's1',
        worktree: false,
        worktreeDir: '/test',
        worktreeBranch: null,
        projectDir: '/test',
        maxIterations: 5,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'coding' as const,
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        loopId: 1,
        projectId: 'test-project',
      }

      // Mock listActive to return one loop
      mockLoopsRepo.listByStatus = () => [validRow]
      mockLoopsRepo.getLarge = () => ({ prompt: 'test prompt', lastAuditResult: null })

      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      const result = await loop.reconcileStale()

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('reconcile')
      expect(notifyCalls[0].loopName).toBe('stale-loop')
      expect(result.cancelled).toBe(1)
      expect(result.preserved).toEqual([])
    })

    it('should preserve loop when isSandboxLive returns true', async () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()

      const now = Date.now()
      const sandboxRow = {
        loopName: 'live-sandbox-loop',
        status: 'running' as const,
        currentSessionId: 's1',
        worktree: true,
        worktreeDir: '/test/wt',
        worktreeBranch: null,
        projectDir: '/test',
        maxIterations: 5,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'coding' as const,
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: true,
        sandboxContainer: 'forge-live-sandbox-loop',
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        loopId: 1,
        projectId: 'test-project',
      }

      mockLoopsRepo.listByStatus = () => [sandboxRow]
      mockLoopsRepo.getLarge = () => ({ prompt: 'test prompt', lastAuditResult: null })

      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      const isSandboxLive = mock(async (name: string) => name === 'live-sandbox-loop')
      const result = await loop.reconcileStale({ isSandboxLive })

      expect(notifyCalls.length).toBe(0)
      expect(result.cancelled).toBe(0)
      expect(result.preserved).toEqual(['live-sandbox-loop'])
    })

    it('should cancel loop when isSandboxLive returns false', async () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()

      const now = Date.now()
      const sandboxRow = {
        loopName: 'dead-sandbox-loop',
        status: 'running' as const,
        currentSessionId: 's1',
        worktree: false,
        worktreeDir: '/test/wt',
        worktreeBranch: null,
        projectDir: '/test',
        maxIterations: 5,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'coding' as const,
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: true,
        sandboxContainer: 'forge-dead-sandbox-loop',
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        loopId: 1,
        projectId: 'test-project',
      }

      mockLoopsRepo.listByStatus = () => [sandboxRow]
      mockLoopsRepo.getLarge = () => ({ prompt: 'test prompt', lastAuditResult: null })

      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      const isSandboxLive = mock(async () => false)
      const result = await loop.reconcileStale({ isSandboxLive })

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('reconcile')
      expect(notifyCalls[0].loopName).toBe('dead-sandbox-loop')
      expect(result.cancelled).toBe(1)
      expect(result.preserved).toEqual([])
    })

    it('should cancel loop when sandbox=false (isSandboxLive not called)', async () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()

      const now = Date.now()
      const nonSandboxRow = {
        loopName: 'non-sandbox-loop',
        status: 'running' as const,
        currentSessionId: 's1',
        worktree: true,
        worktreeDir: '/test/wt',
        worktreeBranch: null,
        projectDir: '/test',
        maxIterations: 5,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'coding' as const,
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        loopId: 1,
        projectId: 'test-project',
      }

      mockLoopsRepo.listByStatus = () => [nonSandboxRow]
      mockLoopsRepo.getLarge = () => ({ prompt: 'test prompt', lastAuditResult: null })

      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      const isSandboxLive = mock(async () => true)
      const result = await loop.reconcileStale({ isSandboxLive })

      expect(isSandboxLive).not.toHaveBeenCalled()
      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('reconcile')
      expect(notifyCalls[0].loopName).toBe('non-sandbox-loop')
      expect(result.cancelled).toBe(1)
      expect(result.preserved).toEqual([])
    })

    it('should cancel loop when sandboxContainer=null (isSandboxLive not called)', async () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()

      const now = Date.now()
      const noContainerRow = {
        loopName: 'no-container-loop',
        status: 'running' as const,
        currentSessionId: 's1',
        worktree: false,
        worktreeDir: '/test/wt',
        worktreeBranch: null,
        projectDir: '/test',
        maxIterations: 5,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'coding' as const,
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: true,
        sandboxContainer: null,
        startedAt: now,
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        loopId: 1,
        projectId: 'test-project',
      }

      mockLoopsRepo.listByStatus = () => [noContainerRow]
      mockLoopsRepo.getLarge = () => ({ prompt: 'test prompt', lastAuditResult: null })

      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName, _hint) => {
        notifyCalls.push({ reason, loopName })
      }

      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify,
      })

      const isSandboxLive = mock(async () => true)
      const result = await loop.reconcileStale({ isSandboxLive })

      expect(isSandboxLive).not.toHaveBeenCalled()
      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('reconcile')
      expect(notifyCalls[0].loopName).toBe('no-container-loop')
      expect(result.cancelled).toBe(1)
      expect(result.preserved).toEqual([])
    })
  })

  describe('default no-op notifier', () => {
    it('should work without notifier (default no-op)', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()

      // This should not throw
      const loop = createLoop({
        loopsRepo: mockLoopsRepo,
        plansRepo: mockPlansRepo,
        reviewFindingsRepo: mockReviewFindingsRepo,
        projectId: 'test-project',
        logger: mockLogger,
        client: {} as any,
        v2Client: {} as any,
        getConfig: () => ({} as any),
        notify: undefined,
      })

      // Should not throw
      expect(() => {
        loop.setState('test-loop', baseState as any)
      }).not.toThrow()
    })
  })
})
