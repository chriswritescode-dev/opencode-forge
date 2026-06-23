import { describe, it, expect, vi } from 'vitest'
import { createLoop } from '../../src/loop/runtime'
import type { LoopService } from '../../src/loop/service'
import type { ForgeClient } from '../../src/client/port'
import type { Logger } from '../../src/types'

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
    deleteState: vi.fn(),
    registerLoopSession: vi.fn(),
    resolveLoopName: vi.fn(() => null),
    buildContinuationPrompt: vi.fn(() => ''),
    buildAuditPrompt: vi.fn(() => ''),
    listActive: vi.fn(() => []),
    listRecent: vi.fn(() => []),
    findMatchByName: vi.fn(() => ({ match: null, candidates: [] })),
    getStallTimeoutMs: vi.fn(() => 60_000),
    getMaxConsecutiveStalls: vi.fn(() => 5),
    terminateAll: vi.fn(() => Promise.resolve()),
    hasOutstandingFindings: vi.fn(() => false),
    getOutstandingFindings: vi.fn(() => []),
    setCoderDecisions: vi.fn(),
    bumpFindingRecurrence: vi.fn(),
    resetSectionRecurrence: vi.fn(),
    generateUniqueLoopName: vi.fn(() => ''),
    getPlanText: vi.fn(() => null),
    incrementError: vi.fn(() => 1),
    resetError: vi.fn(),
    setPhase: vi.fn(),
    setPhaseAndResetError: vi.fn(),
    setModelFailed: vi.fn(),
    setLastAuditResult: vi.fn(),
    clearLastAuditResult: vi.fn(),
    setSandboxContainer: vi.fn(),
    setStatus: vi.fn(),
    clearWorkspaceId: vi.fn(),
    setWorkspaceId: vi.fn(),
    terminate: vi.fn(),
    replaceSession: vi.fn(),
    getSectionPlan: vi.fn(() => null),
    getNextIncompleteSectionPlan: vi.fn(() => null),
    getCompletedSectionDigest: vi.fn(() => []),
    parseSectionSummary: vi.fn(() => null),
    buildSectionInitialPrompt: vi.fn(() => ''),
    buildSectionAuditPrompt: vi.fn(() => ''),
    buildSectionContinuationPrompt: vi.fn(() => ''),
    buildFinalAuditPrompt: vi.fn(() => ''),
    buildFinalAuditFixPrompt: vi.fn(() => ''),
    completeSection: vi.fn(),
    incrementSectionAttempts: vi.fn(),
    resetSectionForRewind: vi.fn(),
    setCurrentSectionIndex: vi.fn(),
    setFinalAuditDone: vi.fn(),
    startSection: vi.fn(),
    bulkInsertSections: vi.fn(),
    setTotalSections: vi.fn(),
  }
}

function makeFakeForgeClient(): ForgeClient {
  return {
    session: {
      create: vi.fn(async () => ({ id: 'sess' }) as any),
      get: vi.fn(async () => ({}) as any),
      update: vi.fn(async () => {}),
      messages: vi.fn(async () => []),
      status: vi.fn(async () => ({}) as any),
      list: vi.fn(async () => []),
      promptAsync: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
    workspace: {
      create: vi.fn(async () => ({ id: 'w' }) as any),
      list: vi.fn(async () => []),
      status: vi.fn(async () => ({}) as any),
      syncList: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      warp: vi.fn(async () => {}),
    },
    project: {
      list: vi.fn(async () => []),
    },
    provider: {
      list: vi.fn(async () => ({ all: [], default: {}, connected: [] }) as any),
    },
    tui: {
      publish: vi.fn(async () => {}),
      selectSession: vi.fn(async () => {}),
    },
    sync: {
      start: vi.fn(async () => {}),
    },
    events: {
      subscribeGlobal: vi.fn(() => () => {}),
    },
  }
}

const mockLogger: Logger = {
  log: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

describe('LoopService seam', () => {
  it('accepts an injected LoopService and delegates start calls to it', () => {
    const fakeService = makeFakeLoopService()
    const client = makeFakeForgeClient()

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

    const state = {
      active: true,
      sessionId: 'sess-1',
      loopName: 'test-loop',
      worktreeDir: '/tmp/wt',
      iteration: 0,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      errorCount: 0,
      auditCount: 0,
      status: 'running' as const,
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      phase: 'coding' as const,
    }

    loop.start({ state })

    expect(fakeService.setState).toHaveBeenCalledTimes(1)
    expect(fakeService.setState).toHaveBeenCalledWith('test-loop', state)

    expect(fakeService.registerLoopSession).toHaveBeenCalledTimes(1)
    expect(fakeService.registerLoopSession).toHaveBeenCalledWith('sess-1', 'test-loop')
  })
})
