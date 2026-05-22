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
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { setupLoopsTestDb } from './helpers/loops-test-db'

const PROJECT_ID = 'test-project'

describe('Legacy audit fallback permissions', () => {
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

  test('fallback includes buildAuditSessionPermissionRuleset()', async () => {
    const legacyCreateCalls: Array<Record<string, unknown>> = []

    const pluginClient = {
      session: {
        create: vi.fn(async (input: any) => {
          legacyCreateCalls.push(input)
          return { data: { id: 'legacy-audit' }, error: null }
        }),
        promptAsync: vi.fn(async () => ({ data: {}, error: null })),
        messages: vi.fn(async () => ({ data: [], error: null })),
      },
    }

    const v2Client = {
      session: {
        create: vi.fn(async () => ({ error: new Error('v2 down'), data: undefined })),
        get: vi.fn(async () => ({ data: {}, error: null })),
        promptAsync: vi.fn(async () => ({ data: {}, error: null })),
        abort: vi.fn(async () => ({ data: {}, error: null })),
        messages: vi.fn(async () => ({
          data: [
            {
              info: { role: 'assistant', finish: 'stop' },
              parts: [{ type: 'text', text: 'All clear.' }],
            },
          ],
          error: null,
        })),
        status: vi.fn(async () => ({ data: {}, error: null })),
        delete: vi.fn(async () => ({ data: {}, error: null })),
      },
    } as unknown as OpencodeClient

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
      client: pluginClient as any,
      v2Client,
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

    expect(legacyCreateCalls.length).toBeGreaterThan(0)

    const callBody = legacyCreateCalls[0] as any
    expect(callBody.body).toBeDefined()
    expect(callBody.body.permission).toEqual(buildAuditSessionPermissionRuleset({ sandbox: false }))
    expect(callBody.body.permission).toContainEqual({
      permission: 'external_directory',
      pattern: '*',
      action: 'deny',
    })
  })
})
