import { describe, it, expect, vi } from 'vitest'
import { createLoop } from '../../src/loop/runtime'
import type { LoopService } from '../../src/loop/service'
import type { LoopState } from '../../src/loop/state'
import type { ForgeClient } from '../../src/client/port'
import type { Logger } from '../../src/types'
import { createFakeForgeClient } from '../helpers/fake-client'

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

/**
 * Stateful fake LoopService for behavior tests that drive tick() through the seam.
 * Only the methods touched by the runtime path under test carry real behavior;
 * the rest remain no-op vi.fn() stubs inherited from makeFakeLoopService().
 */
function makeStatefulFakeLoopService(initialState: LoopState): LoopService {
  let state: LoopState | null = initialState
  const sessionIdToLoop = new Map<string, string>([[initialState.sessionId, initialState.loopName]])

  const base = makeFakeLoopService()
  base.getActiveState = vi.fn(() => (state && state.active ? state : null))
  base.getAnyState = vi.fn(() => state)
  base.setState = vi.fn((_name: string, s: LoopState) => {
    state = s
    sessionIdToLoop.set(s.sessionId, s.loopName)
  })
  base.registerLoopSession = vi.fn((sid: string, ln: string) => {
    sessionIdToLoop.set(sid, ln)
  })
  base.resolveLoopName = vi.fn((sid: string) => sessionIdToLoop.get(sid) ?? null)
  base.parseSectionSummary = vi.fn(() => null)
  base.getOutstandingFindings = vi.fn(() => [])
  base.hasOutstandingFindings = vi.fn(() => false)
  base.terminate = vi.fn(
    (_name: string, opts: { status: 'completed' | 'cancelled' | 'errored' | 'stalled'; reason: string; completedAt: number }) => {
      if (state) {
        state = {
          ...state,
          active: false,
          status: opts.status,
          terminationReason: opts.reason,
          completedAt: new Date(opts.completedAt).toISOString(),
        }
      }
    },
  )
  return base
}

describe('LoopService seam — sectioned dirty audit max-iterations safety net', () => {
  it('terminates with max_iterations when a sectioned dirty audit reaches maxIterations', async () => {
    const initialState: LoopState = {
      active: true,
      sessionId: 'audit-session',
      loopName: 'section-dirty-maxiter',
      worktreeDir: '/tmp/worktree',
      iteration: 5,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      errorCount: 0,
      auditCount: 1,
      status: 'running',
      phase: 'auditing',
      currentSectionIndex: 0,
      totalSections: 2,
      finalAuditDone: false,
      kind: 'plan',
    }
    const fakeService = makeStatefulFakeLoopService(initialState)
    const { client: fakeClient } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit found a remaining bug.' }] },
        ],
      },
    })

    const loop = createLoop({
      loopsRepo: {} as any,
      plansRepo: {} as any,
      reviewFindingsRepo: {} as any,
      projectId: 'test-project',
      client: fakeClient,
      logger: mockLogger,
      getConfig: () => ({}) as any,
      loopService: fakeService,
    })

    await loop.tick({
      type: 'session.status',
      properties: { status: { type: 'idle' }, sessionID: 'audit-session' },
    })

    const afterState = fakeService.getAnyState(initialState.loopName)
    expect(afterState).not.toBeNull()
    expect(afterState!.active).toBe(false)
    expect(afterState!.terminationReason).toBe('max_iterations')
  })
})
