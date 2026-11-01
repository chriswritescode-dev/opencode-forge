import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/loop/service'
import { formatAuditHandoffResult } from '../../src/loop/handoff'
import type { PluginConfig } from '../../src/types'
import { createLoopEventHandler } from '../../src/hooks/loop'
import { createFakeForgeClient } from '../helpers/fake-client'
import { createTestDb } from '../helpers/test-db'
import { createCapturingLogger, createMockLogger } from '../helpers/logger'
import { makeLoopState } from '../helpers/loop-fixtures'
import { recordAuditorHandoff } from '../helpers/loop-handoff'

const mockLogger = createMockLogger()

const PROJECT_ID = 'test-project'

describe('Loop Section Audit Retry', () => {
  let db: ReturnType<typeof createTestDb>['db']
  let testDb: ReturnType<typeof createTestDb>
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let loopService: ReturnType<typeof createLoopService>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>

  beforeEach(() => {
    testDb = createTestDb()
    db = testDb.db

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
    testDb.cleanup()
  })

  const SECTION_AUDIT_RETRY_STATE_DEFAULTS = {
    totalSections: 2,
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
      const state = makeLoopState({ ...SECTION_AUDIT_RETRY_STATE_DEFAULTS, currentSectionIndex: 0, totalSections: 2, phase: 'auditing' })
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
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Found an issue',
        loopName: state.loopName,
        sectionIndex: 0,
      })

      const { logger } = createCapturingLogger()

      const { client: forgeClient } = createFakeForgeClient({
        session: {
          messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text' as const, text: 'dirty audit: found issues' }] }],
        },
      })
      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, forgeClient, logger, getConfig, undefined, undefined, undefined, sectionPlansRepo)
      await recordAuditorHandoff(handler.loop, state.sessionId)

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
      expect(afterAuditResult.lastAuditResult).toBe(formatAuditHandoffResult({}, {
        clean: false,
        blockingBugs: 1,
        sectionIndex: 0,
      }))
    })

    test('two dirty audits via idle events keep loop on section 0 with attempts === 2', async () => {
      const state = makeLoopState({ ...SECTION_AUDIT_RETRY_STATE_DEFAULTS, currentSectionIndex: 0, totalSections: 2, phase: 'auditing' })
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
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Found an issue',
        loopName: state.loopName,
        sectionIndex: 0,
      })

      sectionPlansRepo.incrementAttempts(PROJECT_ID, state.loopName, 0)
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
      await recordAuditorHandoff(handler.loop, state.sessionId)

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

  describe('auditor handoff turn end', () => {
    test('an audit idle without a handoff nudges the same session and keeps the phase auditing', async () => {
      const state = makeLoopState({ ...SECTION_AUDIT_RETRY_STATE_DEFAULTS, loopName: 'audit-nudge-loop', sessionId: 'audit-nudge-session', currentSectionIndex: 0, totalSections: 2, phase: 'auditing' })
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
          messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text' as const, text: 'Everything looks fine.' }] }],
        },
      })
      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, forgeClient, logger, getConfig, undefined, undefined, undefined, sectionPlansRepo)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: { sessionID: state.sessionId, status: { type: 'idle' } },
        },
      })

      const nudgeCall = (forgeClient.session.promptAsync as any).mock.calls.find(
        (call: any) => call[0]?.parts?.some((p: any) => typeof p.text === 'string' && p.text.includes('You ended your turn without calling `loop-handoff`.'))
      )
      expect(nudgeCall).toBeDefined()
      expect(nudgeCall[0].sessionID).toBe(state.sessionId)

      const plan = loopService.getSectionPlan(state, 0)!
      expect(plan.attempts).toBe(0)
      expect(plan.status).toBe('in_progress')
      const after = loopService.getActiveState(state.loopName)!
      expect(after.phase).toBe('auditing')
      expect(after.sessionId).toBe(state.sessionId)
      expect(after.currentSectionIndex).toBe(0)
      expect(after.iteration).toBe(1)
    })

    test('three audit handoff nudges then a fourth idle terminate with handoff_missing', async () => {
      const state = makeLoopState({ ...SECTION_AUDIT_RETRY_STATE_DEFAULTS, loopName: 'audit-nudge-exhausted', sessionId: 'audit-exhausted-session', currentSectionIndex: 0, totalSections: 2, phase: 'auditing' })
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
          messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text' as const, text: 'Still no handoff.' }] }],
        },
      })
      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, forgeClient, logger, getConfig, undefined, undefined, undefined, sectionPlansRepo)

      const idleEvent = {
        event: {
          type: 'session.status',
          properties: { sessionID: state.sessionId, status: { type: 'idle' } },
        },
      }
      const busyEvent = {
        event: {
          type: 'session.status',
          properties: { sessionID: state.sessionId, status: { type: 'busy' } },
        },
      }

      for (let attempt = 1; attempt <= 3; attempt++) {
        await handler.onEvent(idleEvent)
        expect(forgeClient.session.promptAsync).toHaveBeenCalledTimes(attempt)
        await handler.onEvent(busyEvent)
      }

      await handler.onEvent(idleEvent)

      const finished = loopService.getAnyState(state.loopName)!
      expect(finished.active).toBe(false)
      expect(finished.status).toBe('errored')
      expect(finished.terminationReason).toBe('handoff_missing')
      expect(forgeClient.session.promptAsync).toHaveBeenCalledTimes(3)
    })
  })

  describe('clean audit after dirty', () => {
    test('clean audit via idle event completes section 0, advances to section 1, and prior summary appears in next section prompt', async () => {
      const state = makeLoopState({ ...SECTION_AUDIT_RETRY_STATE_DEFAULTS, currentSectionIndex: 0, totalSections: 2, phase: 'auditing' })
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
          messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text' as const, text: 'Audit complete.' }] }],
        },
      })
      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, forgeClient, logger, getConfig, undefined, undefined, undefined, sectionPlansRepo)
      await recordAuditorHandoff(handler.loop, state.sessionId, {
        summary: {
          done: ['Implemented feature X'],
          deviations: [],
          followUps: ['Handled in section 2'],
        },
      })

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
      const state = makeLoopState({
        ...SECTION_AUDIT_RETRY_STATE_DEFAULTS,
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
      for (const index of [0, 1, 2]) {
        sectionPlansRepo.setStatus(PROJECT_ID, state.loopName, index, 'completed')
      }
      loopService.startSection(state.loopName, 3)

      const { logger } = createCapturingLogger()

      const createTitleCalls: string[] = []
      const { client: forgeClient } = createFakeForgeClient({
        session: {
          messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text' as const, text: 'Audit complete.' }] }],
          create: async (opts: any) => {
            if (opts?.title) createTitleCalls.push(opts.title)
            return { id: `rotated-sess-${createTitleCalls.length}` }
          },
        },
      })
      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, forgeClient, logger, getConfig, undefined, undefined, undefined, sectionPlansRepo)
      await recordAuditorHandoff(handler.loop, state.sessionId, {
        summary: { done: ['Implemented section 4'], deviations: [], followUps: [] },
      })

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

  describe('retry prompt iteration reporting', () => {
    test('dirty section retry prompt reports the next persisted iteration (N+1)', async () => {
      const state = makeLoopState({ ...SECTION_AUDIT_RETRY_STATE_DEFAULTS, loopName: 'retry-iteration-loop', sessionId: 'retry-iteration-session', currentSectionIndex: 0, totalSections: 2, phase: 'auditing', iteration: 39, maxIterations: 50 })
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
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Found an issue',
        loopName: state.loopName,
        sectionIndex: 0,
      })

      const { logger } = createCapturingLogger()

      const { client: forgeClient, calls } = createFakeForgeClient({
        session: {
          messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text' as const, text: 'dirty audit: found issues' }] }],
        },
      })
      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, forgeClient, logger, getConfig, undefined, undefined, undefined, sectionPlansRepo)
      await recordAuditorHandoff(handler.loop, state.sessionId)

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
      expect(after.phase).toBe('coding')
      expect(after.iteration).toBe(40)

      const retryPrompts = calls.filter(
        (c) => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code',
      )
      expect(retryPrompts.length).toBeGreaterThan(0)
      const retryPromptText = (retryPrompts[retryPrompts.length - 1].params as any)?.parts?.[0]?.text ?? ''
      const headerMatch = /^\[Loop section 1\/2 -- iteration (\d+)\/(\d+) \(continuation\)\]/m.exec(retryPromptText)
      expect(headerMatch).not.toBeNull()
      expect(Number(headerMatch![1])).toBe(40)
      expect(Number(headerMatch![1])).toBe(after.iteration)
      expect(Number(headerMatch![2])).toBe(50)
    })

    test('dirty section retry at N=max-1 sends the final permitted iteration', async () => {
      const state = makeLoopState({ ...SECTION_AUDIT_RETRY_STATE_DEFAULTS, loopName: 'retry-cap-edge-loop', sessionId: 'retry-cap-edge-session', currentSectionIndex: 0, totalSections: 2, phase: 'auditing', iteration: 4, maxIterations: 5 })
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
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Found an issue',
        loopName: state.loopName,
        sectionIndex: 0,
      })

      const { logger } = createCapturingLogger()

      const { client: forgeClient, calls } = createFakeForgeClient({
        session: {
          messages: async () => [{ info: { role: 'assistant' }, parts: [{ type: 'text' as const, text: 'dirty audit: found issues' }] }],
        },
      })
      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, forgeClient, logger, getConfig, undefined, undefined, undefined, sectionPlansRepo)
      await recordAuditorHandoff(handler.loop, state.sessionId)

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
      expect(after.active).toBe(true)
      expect(after.phase).toBe('coding')
      expect(after.iteration).toBe(5)

      const retryPrompts = calls.filter(
        (c) => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code',
      )
      expect(retryPrompts.length).toBeGreaterThan(0)
      const retryPromptText = (retryPrompts[retryPrompts.length - 1].params as any)?.parts?.[0]?.text ?? ''
      expect(retryPromptText).toContain('[Loop section 1/2 -- iteration 5/5 (continuation)]')
    })
  })
})
