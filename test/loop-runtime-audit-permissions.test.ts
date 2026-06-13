import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
type DB = InstanceType<typeof Database>
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../src/storage/repos/section-plans-repo'
import type { LoopState } from '../src/loop/state'
import { createLoop } from '../src/loop/runtime'
import { buildAuditSessionPermissionRuleset } from '../src/constants/loop'
import type { Logger, PluginConfig } from '../src/types'
import { setupLoopsTestDb } from './helpers/loops-test-db'
import { createFakeForgeClient } from './helpers/fake-client'

const PROJECT_ID = 'test-project'

describe('Audit session permissions', () => {
  let db: DB
  let tempDir: string
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-audit-perm-test-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  function makeState(overrides: Partial<LoopState> = {}): LoopState {
    return {
      active: true,
      sessionId: 'code-session-id',
      loopName: 'test-loop',
      worktreeDir: '/tmp/test-worktree',
      projectDir: '/tmp/host-project',
      worktreeBranch: 'test/branch',
      iteration: 1,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'coding',
      errorCount: 0,
      auditCount: 0,
      status: 'running',
      worktree: true,
      modelFailed: false,
      sandbox: false,
      executionModel: 'test/model',
      auditorModel: 'test/auditor',
      currentSectionIndex: 0,
      totalSections: 1,
      finalAuditDone: false,
      ...overrides,
    }
  }

  test('audit session includes buildAuditSessionPermissionRuleset()', async () => {
    const createCalls: Array<Record<string, unknown>> = []

    const { client } = createFakeForgeClient({
      session: {
        create: async (input: any) => {
          createCalls.push(input)
          return { id: 'audit-session' }
        },
        get: async () => ({ id: 'ses_fake_1', permission: null }),
        status: async () => ({}),
        promptAsync: async () => {},
        messages: async () => [
          {
            info: { role: 'assistant', finish: 'stop' },
            parts: [{ type: 'text', text: 'All clear.' }],
          },
        ],
        abort: async () => {},
        delete: async () => {},
        update: async () => {},
      },
      workspace: {
        warp: async () => {},
        list: async () => [],
        remove: async () => {},
        status: async () => ({}),
      },
      tui: {
        publish: async () => {},
        selectSession: async () => {},
      },
    })

    const logger: Logger = {
      log: () => {},
      error: () => {},
      debug: () => {},
    }

    const config: PluginConfig = {
      executionModel: 'test/model',
      auditorModel: 'test/auditor',
      loop: { enabled: true, model: 'test/loop', defaultMaxIterations: 5 },
    }

    const loopService = (
      await import('../src/loop/service')
    ).createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      logger,
      undefined,
      undefined,
      undefined,
      sectionPlansRepo,
    )

    const loop = createLoop({
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      sectionPlansRepo,
      projectId: PROJECT_ID,
      client,
      logger,
      getConfig: () => config,
      sandboxManager: undefined,
      dataDir: tempDir,
    })

    const state = makeState({
      phase: 'coding',
      sessionId: 'code-session-id',
      totalSections: 1,
      auditCount: 0,
      iteration: 1,
      maxIterations: 3,
      workspaceId: 'ws-test',
      worktree: true,
    })
    loopService.setState(state.loopName, state)

    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: state.sessionId,
      },
    })

    expect(createCalls.length).toBeGreaterThan(0)

    // With the ForgeClient port, create params are passed directly (not wrapped in { body })
    const callParams = createCalls[0] as any
    expect(callParams.permission).toEqual(buildAuditSessionPermissionRuleset({ sandbox: false }))
    expect(callParams.permission).toContainEqual({
      permission: 'external_directory',
      pattern: '*',
      action: 'deny',
    })
  })
})
