import { describe, it, expect } from 'bun:test'
import { createLoopService, type LoopChangeNotifier } from '../src/services/loop'
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
    applyRotation: () => {},
    replaceSession: () => {},
    terminate: () => {},
    setSandboxContainer: () => {},
    clearWorkspaceId: () => {},
    setWorkspaceId: () => {},
    incrementError: () => 0,
    resetError: () => {},
    incrementAudit: () => 0,
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
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.setState('test-loop', baseState as any)

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('insert')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('deleteState', () => {
    it('should be called with delete reason when deleteState is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.deleteState('test-loop')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('delete')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('setStatus', () => {
    it('should be called with status reason when setStatus is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.setStatus('test-loop', 'running')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('status')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('registerLoopSession', () => {
    it('should be called with session reason when registerLoopSession is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.registerLoopSession('s1', 'test-loop')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('session')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('incrementError', () => {
    it('should be called with error reason when incrementError is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.incrementError('test-loop')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('error')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('resetError', () => {
    it('should be called with error reason when resetError is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.resetError('test-loop')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('error')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('incrementAudit', () => {
    it('should be called with audit-result reason when incrementAudit is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.incrementAudit('test-loop')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('audit-result')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('setPhase', () => {
    it('should be called with phase reason when setPhase is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.setPhase('test-loop', 'auditing')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('phase')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('setPhaseAndResetError', () => {
    it('should be called with phase reason when setPhaseAndResetError is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.setPhaseAndResetError('test-loop', 'auditing')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('phase')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('setModelFailed', () => {
    it('should be called with model-failed reason when setModelFailed is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.setModelFailed('test-loop', true)

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('model-failed')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('setLastAuditResult', () => {
    it('should be called with audit-result reason when setLastAuditResult is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.setLastAuditResult('test-loop', 'audit result text')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('audit-result')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('applyRotation', () => {
    it('should be called with rotate reason when applyRotation is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.applyRotation('test-loop', { sessionId: 's4', iteration: 2 })

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('rotate')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('replaceSession', () => {
    it('should be called with rotate reason when replaceSession is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.replaceSession('test-loop', { newSessionId: 's5', phase: 'auditing' })

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('rotate')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('terminate', () => {
    it('should be called with terminate reason when terminate is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.terminate('test-loop', { status: 'completed', reason: 'done', completedAt: Date.now() })

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('terminate')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('setSandboxContainer', () => {
    it('should be called with sandbox reason when setSandboxContainer is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.setSandboxContainer('test-loop', 'container-123')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('sandbox')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('clearWorkspaceId', () => {
    it('should be called with workspace reason when clearWorkspaceId is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.clearWorkspaceId('test-loop')

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('workspace')
      expect(notifyCalls[0].loopName).toBe('test-loop')
    })
  })

  describe('setWorkspaceId', () => {
    it('should be called with workspace reason when setWorkspaceId is called', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()
      const notifyCalls: Array<{ reason: string; loopName: string }> = []
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.setWorkspaceId('test-loop', 'ws-123')

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
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.terminateAll()

      expect(notifyCalls.length).toBe(2)
      expect(notifyCalls[0].reason).toBe('terminate')
      expect(notifyCalls[0].loopName).toBe('loop-1')
      expect(notifyCalls[1].reason).toBe('terminate')
      expect(notifyCalls[1].loopName).toBe('loop-2')
    })
  })

  describe('reconcileStale', () => {
    it('should be called with reconcile reason for each loop when reconcileStale is called', () => {
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
      const notify: LoopChangeNotifier = (reason, loopName) => {
        notifyCalls.push({ reason, loopName })
      }

      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        notify
      )

      loopService.reconcileStale()

      expect(notifyCalls.length).toBe(1)
      expect(notifyCalls[0].reason).toBe('reconcile')
      expect(notifyCalls[0].loopName).toBe('stale-loop')
    })
  })

  describe('default no-op notifier', () => {
    it('should work without notifier (default no-op)', () => {
      const { mockLoopsRepo, mockPlansRepo, mockReviewFindingsRepo, mockLogger } = createMockRepos()

      // This should not throw
      const loopService = createLoopService(
        mockLoopsRepo,
        mockPlansRepo,
        mockReviewFindingsRepo,
        'test-project',
        mockLogger,
        undefined,
        undefined // no notifier
      )

      // Should not throw
      expect(() => {
        loopService.setState('test-loop', baseState as any)
      }).not.toThrow()
    })
  })
})
