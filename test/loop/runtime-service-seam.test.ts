import { describe, it, expect, vi } from 'vitest'
import { createLoop } from '../../src/loop/runtime'
import type { LoopService } from '../../src/loop/service'
import { createFakeForgeClient } from '../helpers/fake-client'
import { makeLoopState } from '../helpers/loop-fixtures'
import { createMockLogger } from '../helpers/logger'

/**
 * Build a minimal fake LoopService that records calls to setState and
 * registerLoopSession. All other methods are no-ops that satisfy the
 * interface contract at runtime.
 */
function makeFakeLoopService(): LoopService {
  return {
    getActiveState: vi.fn(() => null),
    getAnyState: vi.fn(() => null),
    setState: vi.fn(),
    restoreState: vi.fn(),
    deleteState: vi.fn(),
    registerLoopSession: vi.fn(),
    resolveLoopName: vi.fn(() => null),
    resolveActiveLoopForSession: vi.fn(() => null),
    buildContinuationPrompt: vi.fn(() => ''),
    buildAuditPrompt: vi.fn(() => ''),
    buildCoderFollowUpPrompt: vi.fn(() => ''),
    buildAuditFollowUpPrompt: vi.fn(() => ''),
    listActive: vi.fn(() => []),
    listRecent: vi.fn(() => []),
    findMatchByName: vi.fn(() => ({ match: null, candidates: [] })),
    findActiveByWorktreeDir: vi.fn(() => null),
    getStallTimeoutMs: vi.fn(() => 60_000),
    getMaxConsecutiveStalls: vi.fn(() => 5),
    getBusyStallTimeoutMs: vi.fn(() => 900_000),
    terminateAll: vi.fn(() => Promise.resolve()),
    hasOutstandingFindings: vi.fn(() => false),
    hasEscalatedBugFindings: vi.fn(() => false),
    getOutstandingFindings: vi.fn(() => []),
    getBlockingBugFindings: vi.fn(() => []),
    setCoderDecisions: vi.fn(),
    captureAttempt: vi.fn(async () => true),
    finishAttempt: vi.fn(),
    getAttemptHistory: vi.fn(() => []),
    bumpFindingRecurrence: vi.fn(),
    resetSectionRecurrence: vi.fn(),
    getPlanText: vi.fn(() => null),
    incrementError: vi.fn(() => 1),
    resetError: vi.fn(),
    advanceAuditorFallbackIndex: vi.fn(() => 1),
    resetAuditorFallbackIndex: vi.fn(() => false),
    setPhase: vi.fn(),
    setPhaseAndResetError: vi.fn(),
    setModelFailed: vi.fn(),
    setLastAuditResult: vi.fn(),
    clearLastAuditResult: vi.fn(),
    setPostActionReport: vi.fn(),
    setSandboxContainer: vi.fn(),
    setStatus: vi.fn(),
    clearWorkspaceId: vi.fn(),
    setWorkspaceId: vi.fn(),
    setStandbySessionId: vi.fn(),
    terminate: vi.fn(),
    replaceSession: vi.fn(),
    getSectionPlan: vi.fn(() => null),
    getSectionPlans: vi.fn(() => []),
    getNextIncompleteSectionPlan: vi.fn(() => null),
    isLastOpenSection: vi.fn(() => false),
    getCompletedSectionDigest: vi.fn(() => []),
    getPendingHandoff: vi.fn(() => null),
    applyPendingHandoff: vi.fn(() => null),
    recordPendingHandoff: vi.fn(),
    discardPendingHandoff: vi.fn(),
    listHandoffs: vi.fn(() => []),
    buildSectionInitialPrompt: vi.fn(() => ''),
    buildSectionAuditPrompt: vi.fn(() => ''),
    buildSectionContinuationPrompt: vi.fn(() => ''),
    buildPostActionPrompt: vi.fn(() => ''),
    completeSection: vi.fn(),
    incrementSectionAttempts: vi.fn(),
    resetSectionForRewind: vi.fn(),
    setCurrentSectionIndex: vi.fn(),
    startSection: vi.fn(),
    bulkInsertSections: vi.fn(),
    setTotalSections: vi.fn(),
    recordTransition: vi.fn(),
    recordTerminalTransition: vi.fn(),
    adjustRemainingSections: vi.fn(async () => ({ ok: false, error: 'not configured' }) as any),
  }
}

const mockLogger = createMockLogger()

describe('LoopService seam', () => {
  it('accepts an injected LoopService and delegates start calls to it', () => {
    const fakeService = makeFakeLoopService()
    const { client } = createFakeForgeClient()

    const loop = createLoop({
      loopsRepo: {} as any,
      plansRepo: {} as any,
      reviewFindingsRepo: {} as any,
      projectId: 'test-project',
      client,
      logger: mockLogger,
      getConfig: () => ({}) as any,
      loopService: fakeService,
    })

    const state = makeLoopState({ sessionId: 'sess-1', worktreeDir: '/tmp/wt', iteration: 0 })

    loop.start({ state })

    expect(fakeService.setState).toHaveBeenCalledTimes(1)
    expect(fakeService.setState).toHaveBeenCalledWith('test-loop', state)

    expect(fakeService.registerLoopSession).toHaveBeenCalledTimes(1)
    expect(fakeService.registerLoopSession).toHaveBeenCalledWith('sess-1', 'test-loop')
  })
})
