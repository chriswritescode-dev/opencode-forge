import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo, createPlansRepo, createSessionSandboxPreferencesRepo } from '../../src/storage'
import type { LoopsRepo, LoopRow } from '../../src/storage/repos/loops-repo'
import type { SessionSandboxDesiredState } from '../../src/storage'
import type { Logger } from '../../src/types'
import { toForgeRpcJson, type ForgeLoopRestartInput, type ForgeLoopRestartOutput } from '../../src/host/forge-rpc'
import { createTuiRpcService, type TuiRpcService, type TuiRpcServiceDeps } from '../../src/services/tui-rpc-service'
import { forgeWorktreesRoot } from '../../src/workspace/forge-naming'
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
  let plansRepo: ReturnType<typeof createPlansRepo>
  let sandboxPreferences: ReturnType<typeof createSessionSandboxPreferencesRepo>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tui-rpc-service-test-'))
    db = new Database(join(tempDir, 'forge.db'))
    setupLoopsTestDb(db)
    loopsRepo = createLoopsRepo(db)
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
      dataDir: tempDir,
      config: {},
      loopsRepo,
      plansRepo,
      sandboxPreferences,
      restartLoop: async () => ({ sessionId: 'ses-default' }),
      logger,
      ...overrides,
    })
  }

  describe('listLoops', () => {
    test('maps loop rows with restartability', () => {
      loopsRepo.insert(loopRow({ loopName: 'loop-done' }), { lastAuditResult: null })
      loopsRepo.insert(loopRow({ loopName: 'loop-running', status: 'running', currentSessionId: 'session-running' }), { lastAuditResult: null })

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
        restartable: true,
        restartRequiresForce: false,
        executionModel: 'anthropic/claude',
        executionVariant: 'high',
        auditorModel: 'openai/gpt',
        auditorVariant: 'low',
      })
      expect(done?.startedAt).toBe(new Date(1_700_000_000_000).toISOString())
      expect(done).not.toHaveProperty('active')
      expect(done).not.toHaveProperty('sections')

      const running = result.loops.find((loop) => loop.name === 'loop-running')
      expect(running).toMatchObject({ restartable: true, restartRequiresForce: true })
      expect(running?.sections).toBeUndefined()
    })

    test('a loop with unset optional fields is JSON-clean after toForgeRpcJson', () => {
      loopsRepo.insert(loopRow({
        loopName: 'loop-sparse',
        auditorVariant: null,
        executionVariant: null,
        completedAt: null,
      }), { lastAuditResult: null })

      const result = createService().listLoops()
      if ('error' in result) throw new Error(result.error)
      const sparse = result.loops.find((loop) => loop.name === 'loop-sparse')
      expect(Object.hasOwn(sparse ?? {}, 'auditorVariant')).toBe(true)
      expect(sparse?.auditorVariant).toBeUndefined()

      const wire = toForgeRpcJson(result)
      const hasUndefined = (value: unknown): boolean =>
        value === undefined || (typeof value === 'object' && value !== null && Object.values(value).some(hasUndefined))
      expect(hasUndefined(wire)).toBe(false)
      expect(Object.hasOwn(wire.loops.find((loop) => loop.name === 'loop-sparse') ?? {}, 'auditorVariant')).toBe(false)
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
      expect(result.loops[0]).toEqual({ loopName: 'loop-running', status: 'running', iteration: 3, maxIterations: 10, startedAt: 200, phase: 'coding', phaseStartedAt: 200, currentSectionIndex: 0, totalSections: 1 })
    })
  })

  describe('listWorktrees', () => {
    test('returns an empty dir list when the worktrees root is missing', () => {
      expect(createService().listWorktrees()).toEqual({ root: forgeWorktreesRoot(tempDir), dirs: [] })
    })

    test('lists only directory entries under the worktrees root', () => {
      const root = forgeWorktreesRoot(tempDir)
      mkdirSync(join(root, 'loop-a'), { recursive: true })
      mkdirSync(join(root, 'loop-b'), { recursive: true })
      writeFileSync(join(root, 'notes.txt'), '')

      const result = createService().listWorktrees()
      if ('error' in result) throw new Error(result.error)

      expect(result.root).toBe(root)
      expect(result.dirs.sort()).toEqual([join(root, 'loop-a'), join(root, 'loop-b')].sort())
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

    test('two concurrent restarts of different loops both reach the restart dependency', async () => {
      let releaseFirst!: (output: ForgeLoopRestartOutput) => void
      const firstPromise = new Promise<ForgeLoopRestartOutput>((resolve) => { releaseFirst = resolve })
      const restart = vi.fn((input: ForgeLoopRestartInput): Promise<ForgeLoopRestartOutput> =>
        input.loopName === 'loop-1' ? firstPromise : Promise.resolve({ sessionId: 'ses_2' }))
      const service = createService({ restartLoop: restart })

      const first = service.restartLoop({ ...request, loopName: 'loop-1' })
      const second = await service.restartLoop({ ...request, loopName: 'loop-2' })

      expect(second).toEqual({ sessionId: 'ses_2' })
      expect(restart).toHaveBeenCalledTimes(2)

      releaseFirst({ sessionId: 'ses_1' })
      await expect(first).resolves.toEqual({ sessionId: 'ses_1' })
    })

    test('forwards force and expectedStartedAt to the restart dependency', async () => {
      const restart = vi.fn(async (): Promise<ForgeLoopRestartOutput> => ({ sessionId: 'ses_1' }))
      const service = createService({ restartLoop: restart })

      await expect(service.restartLoop({ ...request, force: false, expectedStartedAt: '2026-01-01T00:00:00.000Z' }))
        .resolves.toEqual({ sessionId: 'ses_1' })
      expect(restart).toHaveBeenCalledWith({ ...request, force: false, expectedStartedAt: '2026-01-01T00:00:00.000Z' })
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
