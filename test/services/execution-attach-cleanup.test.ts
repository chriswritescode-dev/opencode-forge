import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/loop/service'
import type { Logger } from '../../src/types'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { createFakeForgeClient } from '../helpers/fake-client'

const noopFn = () => {}

const PROJECT_ID = 'test-project'

describe('attachLoopToSession', () => {
  let db: Database
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'attach-cleanup-test-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
  })

  afterEach(() => {
    try {
      db.close()
    } catch {}
  })

  function buildDeps() {
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      { log: () => {}, error: () => {}, debug: () => {} } as Logger,
      undefined,
      undefined,
      undefined,
      sectionPlansRepo,
    )

    const { client } = createFakeForgeClient()

    const deps = {
      projectId: PROJECT_ID,
      directory: '/tmp/test',
      config: {
        loop: { enabled: true },
        executionModel: 'prov/exec',
        auditorModel: 'prov/aud',
      },
      logger: { log: () => {}, error: () => {}, debug: () => {} } as Logger,
      dataDir: '/tmp',
      client,
      plansRepo,
      loopsRepo,
      reviewFindingsRepo,
      sectionPlansRepo,
      loop: {
        service: loopService,
        listActive: (...a: any[]) => loopService.listActive(...a as any),
        generateUniqueLoopName: (...a: any[]) => loopService.generateUniqueLoopName(...a as any),
        findMatchByName: (...a: any[]) => loopService.findMatchByName(...a as any),
        registerSessionReverseIndex: () => {},
        unregisterSessionReverseIndex: () => {},
      } as any,
      loopHandler: {
        runExclusive: async <T>(name: string, fn: () => Promise<T>) => fn(),
        startWatchdog: vi.fn(),
        clearLoopTimers: noopFn,
      },
      sandboxManager: null,
      workspaceStatusRegistry: {
        recordEvent: vi.fn(),
        getStatus: vi.fn().mockReturnValue('connected' as const),
        awaitConnected: vi.fn().mockResolvedValue({ connected: true, elapsedMs: 0, source: 'cached' as const }),
        primeFromSnapshot: vi.fn(),
      },
    }

    return { deps, loopsRepo, plansRepo, sectionPlansRepo, reviewFindingsRepo, loopService }
  }

  test('attachLoopToSession purges orphaned per-loop rows even when no loops row exists', async () => {
    const { deps, sectionPlansRepo, plansRepo, reviewFindingsRepo } = buildDeps()

    const LOOP_NAME = 'orphan-loop'

    // Seed orphaned section_plans for the loop (no loops row exists)
    db.exec('PRAGMA foreign_keys=OFF')
    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName: LOOP_NAME,
      sections: [
        { index: 0, title: 'Stale section', content: '# Stale\n\nStale content.' },
      ],
    })
    sectionPlansRepo.setStatus(PROJECT_ID, LOOP_NAME, 0, 'in_progress')

    // Seed orphaned plan for the loop
    plansRepo.writeForLoop(PROJECT_ID, LOOP_NAME, 'STALE_PLAN_CONTENT')

    // Seed orphaned review findings for the loop
    reviewFindingsRepo.write({
      projectId: PROJECT_ID,
      loopName: LOOP_NAME,
      file: 'a.ts',
      line: 1,
      severity: 'bug' as const,
      description: 'stale finding',
    })
    db.exec('PRAGMA foreign_keys=ON')

    // Verify seed data is present before attach
    expect(sectionPlansRepo.count(PROJECT_ID, LOOP_NAME)).toBe(1)
    expect(plansRepo.getForLoop(PROJECT_ID, LOOP_NAME)).not.toBeNull()
    expect(reviewFindingsRepo.listByLoopName(PROJECT_ID, LOOP_NAME).length).toBeGreaterThan(0)

    // Confirm no loops row exists for orphan-loop (simulating orphan state)
    const existingLoop = deps.loopsRepo.get(PROJECT_ID, LOOP_NAME)
    expect(existingLoop).toBeNull()

    const { attachLoopToSession } = await import('../../src/services/execution')

    const result = await attachLoopToSession(
      deps as any,
      { surface: 'tui', projectId: PROJECT_ID, directory: '/tmp/test' },
      {
        sessionId: 'sess_fresh',
        workspaceId: 'ws_fresh',
        worktreeDir: '/tmp/wt/fresh',
        loopName: LOOP_NAME,
        displayName: 'Orphan Loop',
        executionName: LOOP_NAME,
        maxIterations: 50,
        sandboxEnabled: false,
        planText: 'NEW_PLAN',
        selectSession: false,
        selectSessionTiming: 'after-prompt',
        startWatchdog: false,
      },
    )

    // Attach should succeed (no existing running loop)
    expect(result.ok).toBe(true)

    // --- Assertions that MUST fail today ---
    // Today: no purge logic exists, so the orphaned rows remain.
    // After Phase 6: these should pass once defensive purge is added.
    expect(sectionPlansRepo.count(PROJECT_ID, LOOP_NAME)).toBe(0)
    // Plan row is rewritten by setState from the new plan text ('NEW_PLAN')
    const planAfterAttach = plansRepo.getForLoop(PROJECT_ID, LOOP_NAME)
    expect(planAfterAttach).not.toBeNull()
    expect(planAfterAttach!.content).toBe('NEW_PLAN')
    expect(reviewFindingsRepo.listByLoopName(PROJECT_ID, LOOP_NAME)).toEqual([])
  })
})
