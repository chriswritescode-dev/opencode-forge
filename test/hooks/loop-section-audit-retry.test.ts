import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService, MAX_RETRIES } from '../../src/loop/service'
import type { LoopState } from '../../src/loop/state'
import { createLoopEventHandler } from '../../src/hooks/loop'
import type { Logger, PluginConfig } from '../../src/types'
import { createFakeForgeClient } from '../helpers/fake-client'
import { setupLoopsTestDb } from '../helpers/loops-test-db'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

const PROJECT_ID = 'test-project'

describe('Loop Section Audit Retry', () => {
  let db: Database
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let loopService: ReturnType<typeof createLoopService>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-section-audit-retry-test-'))
    db = new Database(join(tempDir, 'test.db'))

    setupLoopsTestDb(db)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)

    loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      mockLogger,
      undefined,
      undefined,
      sectionPlansRepo,
    )
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  function makeState(overrides: Partial<LoopState> = {}): LoopState {
    return {
      active: true,
      sessionId: 'loop-session-id',
      loopName: 'test-loop',
      worktreeDir: '/tmp/nonexistent-worktree-for-test',
      projectDir: '/tmp/host-project-dir',
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
      totalSections: 2,
      finalAuditDone: false,
      ...overrides,
    }
  }

  function createCapturingLogger() {
    const logs: Array<{ level: string; message: string }> = []
    return {
      logger: {
        log: (msg: string) => logs.push({ level: 'log', message: msg }),
        error: (msg: string) => logs.push({ level: 'error', message: msg }),
        debug: (msg: string) => logs.push({ level: 'debug', message: msg }),
      } as Logger,
      logs,
    }
  }

  const mockConfig: PluginConfig = {
    executionModel: 'test/model',
    auditorModel: 'test/auditor',
    loop: {
      enabled: true,
      defaultMaxIterations: 5,
    },
  }

  describe('dirty audit behavior', () => {
    test('dirty audit via idle event increments attempts and does not advance section', async () => {
      const state = makeState({ currentSectionIndex: 0, totalSections: 2, phase: 'auditing' })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
          { index: 1, title: 'Section B', content: 'Content B' },
        ],
      })
      loopService.startSection(state.loopName, 0)

      const { logger } = createCapturingLogger()

      const { client: forgeClient } = createFakeForgeClient({
        session: {
          messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text' as const, text: 'dirty audit: found issues' }] }],
        },
      })
      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, forgeClient, logger, getConfig, undefined, undefined, undefined, sectionPlansRepo)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: state.sessionId,
            status: { type: 'idle' },
          },
        },
      })

      const plan = loopService.getSectionPlan(state, 0)!
      expect(plan.attempts).toBe(1)

      const after = loopService.getActiveState(state.loopName)!
      expect(after.currentSectionIndex).toBe(0)

      const hasContinuationPrompt = (forgeClient.session.promptAsync as any).mock.calls.some(
        (call: any) => call[0]?.parts?.some((p: any) => typeof p.text === 'string' && p.text.includes('continuation'))
      )
      expect(hasContinuationPrompt).toBe(true)

      const afterAuditResult = loopService.getActiveState(state.loopName)!
      expect(afterAuditResult.lastAuditResult).toBe('dirty audit: found issues')
    })

    test('two dirty audits via idle events keep loop on section 0 with attempts === 2', async () => {
      const state = makeState({ currentSectionIndex: 0, totalSections: 2, phase: 'auditing' })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
          { index: 1, title: 'Section B', content: 'Content B' },
        ],
      })
      loopService.startSection(state.loopName, 0)

      loopService.incrementSectionAttempts(state.loopName, 0)
      const planBefore = loopService.getSectionPlan(state, 0)!
      expect(planBefore.attempts).toBe(1)

      const { logger } = createCapturingLogger()

      const { client: forgeClient } = createFakeForgeClient({
        session: {
          messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text' as const, text: 'second dirty audit' }] }],
        },
      })
      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, forgeClient, logger, getConfig, undefined, undefined, undefined, sectionPlansRepo)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: state.sessionId,
            status: { type: 'idle' },
          },
        },
      })

      const planAfterSecond = loopService.getSectionPlan(state, 0)!
      expect(planAfterSecond.attempts).toBe(2)

      const after = loopService.getActiveState(state.loopName)!
      expect(after.currentSectionIndex).toBe(0)
      expect(after.totalSections).toBe(2)
    })
  })

  describe('clean audit after dirty', () => {
    test('clean audit via idle event completes section 0, advances to section 1, and prior summary appears in next section prompt', async () => {
      const state = makeState({ currentSectionIndex: 0, totalSections: 2, phase: 'auditing' })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
          { index: 1, title: 'Section B', content: 'Content B' },
        ],
      })
      loopService.startSection(state.loopName, 0)

      const { logger } = createCapturingLogger()

      const summaryText = 'OK\n<!-- section-summary:start -->\n### Done\n- Implemented feature X\n### Deviations\n- None\n### Follow-ups\n- Handled in section 2\n<!-- section-summary:end -->'

      const { client: forgeClient } = createFakeForgeClient({
        session: {
          messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text' as const, text: summaryText }] }],
        },
      })
      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, forgeClient, logger, getConfig, undefined, undefined, undefined, sectionPlansRepo)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: state.sessionId,
            status: { type: 'idle' },
          },
        },
      })

      const plan = loopService.getSectionPlan(state, 0)!
      expect(plan.status).toBe('completed')
      expect(plan.summaryDone).toContain('Implemented feature X')

      const after = loopService.getActiveState(state.loopName)!
      expect(after.currentSectionIndex).toBe(1)

      const hasPriorSectionSummary = (forgeClient.session.promptAsync as any).mock.calls.some(
        (call: any) => call[0]?.parts?.some((p: any) => typeof p.text === 'string' && p.text.includes('Implemented feature X'))
      )
      expect(hasPriorSectionSummary).toBe(true)
    })

    test('rotated session title reflects new section index and iteration after clean audit advance', async () => {
      const state = makeState({
        currentSectionIndex: 3,
        totalSections: 12,
        phase: 'auditing',
        iteration: 12,
        maxIterations: 50,
      })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        sections: Array.from({ length: 12 }, (_, i) => ({
          index: i,
          title: `Section ${i + 1}`,
          content: `Content for section ${i + 1}`,
        })),
      })
      loopService.startSection(state.loopName, 3)

      const { logger } = createCapturingLogger()

      const summaryText = 'OK\n<!-- section-summary:start -->\n### Done\n- Implemented section 4\n### Deviations\n- None\n### Follow-ups\n- None\n<!-- section-summary:end -->'

      const createTitleCalls: string[] = []
      const { client: forgeClient } = createFakeForgeClient({
        session: {
          messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text' as const, text: summaryText }] }],
          create: async (opts: any) => {
            if (opts?.title) createTitleCalls.push(opts.title)
            return { id: `rotated-sess-${createTitleCalls.length}` }
          },
        },
      })
      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, forgeClient, logger, getConfig, undefined, undefined, undefined, sectionPlansRepo)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: state.sessionId,
            status: { type: 'idle' },
          },
        },
      })

      const after = loopService.getActiveState(state.loopName)!
      expect(after.currentSectionIndex).toBe(4)
      expect(after.iteration).toBe(13)

      const rotationTitle = createTitleCalls.find(t => t.startsWith('Loop: '))
      expect(rotationTitle).toBeDefined()
      expect(rotationTitle).toContain('5/12')
      expect(rotationTitle).toContain('#13')
      expect(rotationTitle).not.toContain('4/12')
      expect(rotationTitle).not.toContain('#12')
    })
  })

  describe('exhausted retries', () => {
    test('exhausted iterations via idle event terminates with max_iterations', async () => {
      const state = makeState({ currentSectionIndex: 0, totalSections: 2, phase: 'auditing', maxIterations: 1 })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
          { index: 1, title: 'Section B', content: 'Content B' },
        ],
      })
      loopService.startSection(state.loopName, 0)

      const { logger } = createCapturingLogger()

      const { client: forgeClient } = createFakeForgeClient({
        session: {
          messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text' as const, text: 'dirty audit: found issues' }] }],
        },
      })
      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, forgeClient, logger, getConfig, undefined, undefined, undefined, sectionPlansRepo)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: state.sessionId,
            status: { type: 'idle' },
          },
        },
      })

      const terminatedState = loopService.getAnyState(state.loopName)
      expect(terminatedState).not.toBeNull()
      expect(terminatedState!.active).toBe(false)
      expect(terminatedState!.terminationReason).toBe('max_iterations')
    })
  })

  describe('audit result storage', () => {
    test('setLastAuditResult stores text in large fields', () => {
      const state = makeState()
      loopService.setState(state.loopName, state)

      loopService.setLastAuditResult(state.loopName, 'Audit findings here')

      const updated = loopService.getActiveState(state.loopName)!
      expect(updated.lastAuditResult).toBe('Audit findings here')
    })

    test('setLastAuditResult ignores empty string', () => {
      const state = makeState()
      loopService.setState(state.loopName, state)

      loopService.setLastAuditResult(state.loopName, '')

      const after = loopService.getActiveState(state.loopName)!
      expect(after.lastAuditResult).toBeUndefined()
    })
  })

  describe('buildSectionContinuationPrompt', () => {
    test('continuation prompt includes audit text', () => {
      const state = makeState({ currentSectionIndex: 0, totalSections: 2 })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
          { index: 1, title: 'Section B', content: 'Content B' },
        ],
      })

      const prompt = loopService.buildSectionContinuationPrompt(state, 'Fix the bugs mentioned in audit')
      expect(prompt).toContain('continuation')
      expect(prompt).toContain('Fix the bugs mentioned in audit')
    })

    test('continuation prompt includes outstanding bug findings for current section', () => {
      const state = makeState({ currentSectionIndex: 0, totalSections: 2 })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
          { index: 1, title: 'Section B', content: 'Content B' },
        ],
      })

      const prompt = loopService.buildSectionContinuationPrompt(state, 'Some audit text')
      expect(prompt).toContain('Some audit text')
    })
  })

  describe('getCompletedSectionDigest', () => {
    test('returns empty digest when no sections are completed', () => {
      const state = makeState({ currentSectionIndex: 0, totalSections: 2 })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
          { index: 1, title: 'Section B', content: 'Content B' },
        ],
      })

      const digest = loopService.getCompletedSectionDigest(state)
      expect(digest).toHaveLength(0)
    })

    test('returns completed sections with their summaries', () => {
      const state = makeState({ currentSectionIndex: 1, totalSections: 2 })
      loopService.setState(state.loopName, state)

      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        sections: [
          { index: 0, title: 'Section A', content: 'Content A' },
          { index: 1, title: 'Section B', content: 'Content B' },
        ],
      })

      // Complete section 0
      loopService.startSection(state.loopName, 0)
      loopService.completeSection(state.loopName, 0, {
        done: 'Implemented feature X',
        deviations: 'None',
        followUps: 'Deferred Y',
      })

      const digest = loopService.getCompletedSectionDigest(state)
      expect(digest).toHaveLength(1)
      expect(digest[0].summaryDone).toContain('Implemented feature X')
      expect(digest[0].summaryDeviations).toContain('None')
      expect(digest[0].summaryFollowUps).toContain('Deferred Y')
    })
  })
})
