import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo, createPlansRepo, createSectionPlansRepo, createSessionSandboxPreferencesRepo } from '../../src/storage'
import type { LoopsRepo, LoopRow } from '../../src/storage/repos/loops-repo'
import type { SessionSandboxDesiredState } from '../../src/storage'
import type { Logger } from '../../src/types'
import type { ForgeLoopRestartInput, ForgeLoopRestartOutput } from '../../src/host/forge-rpc'
import { createTuiRpcService, type TuiRpcService, type TuiRpcServiceDeps } from '../../src/services/tui-rpc-service'
import { setupLoopsTestDb } from '../helpers/loops-test-db'

const PROJECT = 'project-a'
const logger: Logger = { log: () => {}, error: () => {}, debug: () => {} }

function loopRow(overrides: Partial<LoopRow> = {}): LoopRow {
  return {
    projectId: PROJECT,
    loopName: 'loop-1',
    status: 'cancelled',
    currentSessionId: 'session-1',
    worktree: false,
    worktreeDir: '/tmp/forge/worktrees/loop-1',
    worktreeBranch: null,
    projectDir: '/tmp/forge',
    maxIterations: 10,
    iteration: 3,
    auditCount: 1,
    errorCount: 0,
    phase: 'coding',
    executionModel: 'anthropic/claude',
    auditorModel: 'openai/gpt',
    modelFailed: false,
    sandbox: false,
    sandboxContainer: null,
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_100_000,
    terminationReason: null,
    completionSummary: null,
    workspaceId: 'ws-1',
    hostSessionId: 'host-1',
    currentSectionIndex: 0,
    totalSections: 1,
    finalAuditDone: 0,
    executionVariant: 'high',
    auditorVariant: 'low',
    kind: 'plan',
    ...overrides,
  }
}

describe('createTuiRpcService', () => {
  let tempDir: string
  let db: Database
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let sandboxPreferences: ReturnType<typeof createSessionSandboxPreferencesRepo>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tui-rpc-service-test-'))
    db = new Database(join(tempDir, 'forge.db'))
    setupLoopsTestDb(db)
    loopsRepo = createLoopsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    plansRepo = createPlansRepo(db)
    sandboxPreferences = createSessionSandboxPreferencesRepo(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  function createService(overrides: Partial<TuiRpcServiceDeps> = {}): TuiRpcService {
    return createTuiRpcService({
      projectId: PROJECT,
      config: {},
      loopsRepo,
      sectionPlansRepo,
      plansRepo,
      sandboxPreferences,
      restartLoop: async () => ({ sessionId: 'ses-default' }),
      logger,
      ...overrides,
    })
  }

  describe('listLoops', () => {
    test('maps loop rows with restartability and optional section views', () => {
      loopsRepo.insert(loopRow({ loopName: 'loop-done' }), { lastAuditResult: null })
      loopsRepo.insert(loopRow({ loopName: 'loop-running', status: 'running', currentSessionId: 'session-running' }), { lastAuditResult: null })
      sectionPlansRepo.bulkInsert({
        projectId: PROJECT,
        loopName: 'loop-done',
        sections: [
          { index: 0, title: 'Phase one', content: 'body' },
          { index: 1, title: 'Phase two', content: 'body' },
        ],
      })
      sectionPlansRepo.setSummary(PROJECT, 'loop-done', 0, { done: 'a'.repeat(250), deviations: 'deviation', followUps: null })

      const result = createService().listLoops()
      if ('error' in result) throw new Error(result.error)

      const done = result.loops.find((loop) => loop.name === 'loop-done')
      expect(done).toMatchObject({
        name: 'loop-done',
        status: 'cancelled',
        phase: 'coding',
        iteration: 3,
        maxIterations: 10,
        sessionId: 'session-1',
        active: false,
        restartable: true,
        restartRequiresForce: false,
        worktreeDir: '/tmp/forge/worktrees/loop-1',
        executionModel: 'anthropic/claude',
        executionVariant: 'high',
        auditorModel: 'openai/gpt',
        auditorVariant: 'low',
        workspaceId: 'ws-1',
        hostSessionId: 'host-1',
        finalAuditDone: false,
      })
      expect(done?.startedAt).toBe(new Date(1_700_000_000_000).toISOString())
      expect(done?.completedAt).toBe(new Date(1_700_000_100_000).toISOString())
      expect(done?.sections).toHaveLength(2)
      expect(done?.sections?.[0]).toMatchObject({ index: 0, title: 'Phase one', attempts: 0 })
      expect(done?.sections?.[0]?.summaryDone).toHaveLength(200)
      expect(done?.sections?.[1]?.summaryDone).toBeNull()

      const running = result.loops.find((loop) => loop.name === 'loop-running')
      expect(running).toMatchObject({ active: true, restartable: true, restartRequiresForce: true })
      expect(running?.sections).toBeUndefined()
    })

    test('reports an error when the repo throws', () => {
      const throwingRepo = { listAll: () => { throw new Error('database gone') } } as unknown as LoopsRepo
      const result = createService({ loopsRepo: throwingRepo }).listLoops()
      expect(result).toEqual({ error: 'database gone' })
    })
  })

  describe('listLoopSidebar', () => {
    test('returns the sidebar rows for the project', () => {
      loopsRepo.insert(loopRow({ loopName: 'loop-running', status: 'running', startedAt: 200 }), { lastAuditResult: null })
      loopsRepo.insert(loopRow({ loopName: 'loop-done', status: 'completed', startedAt: 100 }), { lastAuditResult: null })

      const result = createService().listLoopSidebar(5)
      if ('error' in result) throw new Error(result.error)

      expect(result.loops.map((row) => row.loopName)).toEqual(['loop-running', 'loop-done'])
      expect(result.loops[0]).toEqual({ loopName: 'loop-running', status: 'running', iteration: 3, maxIterations: 10 })
    })
  })

  describe('getSessionPlan', () => {
    test('returns the stored plan content for the session', () => {
      plansRepo.writeForSession(PROJECT, 'session-plan', '# Plan\n## Phase')

      expect(createService().getSessionPlan('session-plan')).toEqual({ plan: '# Plan\n## Phase' })
    })

    test('returns null for an unknown session', () => {
      plansRepo.writeForSession(PROJECT, 'session-plan', '# Plan')

      expect(createService().getSessionPlan('session-other')).toEqual({ plan: null })
    })
  })

  describe('restartLoop', () => {
    const request: ForgeLoopRestartInput = {
      loopName: 'loop-1',
      auditorModel: 'openai/gpt',
      auditorVariant: 'high',
    }

    test('rejects a second restart while one is in flight, then allows the next', async () => {
      let releaseFirst!: (output: ForgeLoopRestartOutput) => void
      const firstPromise = new Promise<ForgeLoopRestartOutput>((resolve) => { releaseFirst = resolve })
      let callCount = 0
      const restart = vi.fn((_request: ForgeLoopRestartInput): Promise<ForgeLoopRestartOutput> => {
        callCount += 1
        return callCount === 1 ? firstPromise : Promise.resolve({ sessionId: 'ses_2' })
      })
      const service = createService({ restartLoop: restart })

      const first = service.restartLoop(request)
      const second = await service.restartLoop(request)

      expect(second).toEqual({ error: 'Another loop restart request is already in progress' })
      expect(restart).toHaveBeenCalledTimes(1)

      releaseFirst({ sessionId: 'ses_1' })
      await expect(first).resolves.toEqual({ sessionId: 'ses_1' })
      await expect(service.restartLoop(request)).resolves.toEqual({ sessionId: 'ses_2' })
    })

    test('maps a thrown restart failure into an error result', async () => {
      const restart = vi.fn(async () => { throw new Error('dispatch failed') })
      const service = createService({ restartLoop: restart })

      await expect(service.restartLoop(request)).resolves.toEqual({ error: 'dispatch failed' })
    })
  })

  describe('getHostSandboxState', () => {
    test('reports config, preference pair, and running loop sandboxes', () => {
      const desired: SessionSandboxDesiredState = {
        version: 1,
        revision: 'rev-1',
        enabled: true,
        sessionId: 'session-1',
        requestedAt: 1,
      }
      sandboxPreferences.setDesired(PROJECT, desired)
      loopsRepo.insert(loopRow({ loopName: 'loop-sandboxed', status: 'running', currentSessionId: 'session-loop', sandbox: true }), { lastAuditResult: null })

      const result = createService().getHostSandboxState()
      if ('error' in result) throw new Error(result.error)

      expect(result.configEnabled).toBe(true)
      expect(result.desired).toEqual(desired)
      expect(result.applied).toBeNull()
      expect(result.controller).toBeNull()
      expect(result.activeLoopSandboxes).toEqual({ 'session-loop': true })
    })

    test('omits activeLoopSandboxes when no loop is running and honors a disabled config', () => {
      const result = createService({ config: { sandbox: { enabled: false } } }).getHostSandboxState()
      if ('error' in result) throw new Error(result.error)

      expect(result.configEnabled).toBe(false)
      expect(result.activeLoopSandboxes).toBeUndefined()
    })
  })

  describe('requestHostSandbox', () => {
    test('refuses to write when sandboxing is disabled by config', () => {
      const service = createService({ config: { sandbox: { enabled: false } } })

      expect(service.requestHostSandbox('session-1', true))
        .toEqual({ error: 'Host sandbox is disabled by config (sandbox.enabled: false)' })
      expect(sandboxPreferences.getDesired(PROJECT)).toBeNull()
    })

    test('writes a fresh desired revision when sandboxing is enabled', () => {
      const result = createService().requestHostSandbox('session-1', true)
      if ('error' in result) throw new Error(result.error)

      expect(typeof result.revision).toBe('string')
      expect(sandboxPreferences.getDesired(PROJECT)).toMatchObject({
        version: 1,
        revision: result.revision,
        enabled: true,
        sessionId: 'session-1',
      })
    })
  })
})
