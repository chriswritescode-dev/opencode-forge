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
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
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

  function createMockV2Client(options: {
    messagesCalls?: Array<{ lastMessageRole: string; text?: string }>
    createCalls?: Array<{ data?: { id: string }; error?: unknown }>
  }): OpencodeClient {
    const callIndex = { value: 0 }
    const createCallIndex = { value: 0 }

    return {
      session: {
        messages: async () => {
          const callConfig = options.messagesCalls?.[callIndex.value] || { lastMessageRole: 'assistant', text: '' }
          callIndex.value++
          return {
            data: [
              {
                info: { role: callConfig.lastMessageRole },
                parts: [{ type: 'text' as const, text: callConfig.text ?? '' }],
              },
            ],
          }
        },
        promptAsync: async () => ({ data: {}, error: null }),
        abort: async () => {},
        status: async () => ({
          data: { 'sess-1': { type: 'idle' } },
        }),
        create: async () => {
          const callConfig = options.createCalls?.[createCallIndex.value]
          createCallIndex.value++
          if (callConfig) {
            if (callConfig.error) {
              return { data: undefined, error: callConfig.error }
            }
            return { data: callConfig.data ?? { id: `mock-session-${Date.now()}` }, error: undefined }
          }
          return { data: { id: `mock-session-${Date.now()}` }, error: undefined }
        },
        delete: async () => {},
        get: async () => ({ data: {} }),
      },
      tui: {
        publish: async () => {},
        selectSession: async () => {},
      },
      worktree: {
        create: async () => ({ data: { directory: '/mock/worktree', branch: 'mock-branch' }, error: undefined }),
        remove: async () => {},
      },
    } as unknown as OpencodeClient
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
      model: 'test/loop',
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

      let promptCalls: Array<{ agent?: string; text?: string }> = []
      const v2Client = createMockV2Client({
        messagesCalls: [
          { lastMessageRole: 'assistant', text: 'dirty audit: found issues' },
        ],
        createCalls: [],
      })

      const origPromptAsync = (v2Client as any).session.promptAsync
      ;(v2Client as any).session.promptAsync = async (opts: any) => {
        if (opts?.parts) {
          const text = opts.parts.map((p: any) => p.text ?? '').join('\n')
          promptCalls.push({ agent: opts.agent, text })
        }
        return origPromptAsync(opts)
      }

      const pluginClient = {
        session: {
          create: async () => ({ data: { id: 'new-audit-sess' } }),
          promptAsync: async () => ({ data: {}, error: null }),
        },
      }

      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, pluginClient as any, v2Client as any, logger, getConfig, undefined, undefined, undefined, sectionPlansRepo)

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

      const hasContinuationPrompt = promptCalls.some(p => p.text && p.text.includes('continuation'))
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

      const v2Client = createMockV2Client({
        messagesCalls: [
          { lastMessageRole: 'assistant', text: 'second dirty audit' },
        ],
        createCalls: [],
      })

      const pluginClient = {
        session: {
          create: async () => ({ data: { id: 'new-audit-sess' } }),
          promptAsync: async () => ({ data: {}, error: null }),
        },
      }

      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, pluginClient as any, v2Client as any, logger, getConfig, undefined, undefined, undefined, sectionPlansRepo)

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

      let promptCalls: Array<{ agent?: string; text?: string }> = []
      const v2Client = createMockV2Client({
        messagesCalls: [
          { lastMessageRole: 'assistant', text: summaryText },
        ],
        createCalls: [],
      })

      const origPromptAsync = (v2Client as any).session.promptAsync
      ;(v2Client as any).session.promptAsync = async (opts: any) => {
        if (opts?.parts) {
          const text = opts.parts.map((p: any) => p.text ?? '').join('\n')
          promptCalls.push({ agent: opts.agent, text })
        }
        return origPromptAsync(opts)
      }

      const pluginClient = {
        session: {
          create: async () => ({ data: { id: 'new-audit-sess' } }),
          promptAsync: async () => ({ data: {}, error: null }),
        },
      }

      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, pluginClient as any, v2Client as any, logger, getConfig, undefined, undefined, undefined, sectionPlansRepo)

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

      const hasPriorSectionSummary = promptCalls.some(p => p.text && p.text.includes('Implemented feature X'))
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

      const v2Client = createMockV2Client({
        messagesCalls: [
          { lastMessageRole: 'assistant', text: summaryText },
        ],
        createCalls: [],
      })

      const createTitleCalls: string[] = []
      ;(v2Client as any).session.create = async (opts: any) => {
        if (opts?.title) createTitleCalls.push(opts.title)
        return { data: { id: `rotated-sess-${createTitleCalls.length}` }, error: undefined }
      }

      const pluginClient = {
        session: {
          create: async () => ({ data: { id: 'new-audit-sess' } }),
          promptAsync: async () => ({ data: {}, error: null }),
        },
      }

      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, pluginClient as any, v2Client as any, logger, getConfig, undefined, undefined, undefined, sectionPlansRepo)

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

      let promptCalls: Array<{ agent?: string; text?: string }> = []
      const v2Client = createMockV2Client({
        messagesCalls: [
          { lastMessageRole: 'assistant', text: 'dirty audit: found issues' },
        ],
        createCalls: [],
      })

      const origPromptAsync = (v2Client as any).session.promptAsync
      ;(v2Client as any).session.promptAsync = async (opts: any) => {
        if (opts?.parts) {
          const text = opts.parts.map((p: any) => p.text ?? '').join('\n')
          promptCalls.push({ agent: opts.agent, text })
        }
        return origPromptAsync(opts)
      }

      const pluginClient = {
        session: {
          create: async () => ({ data: { id: 'new-audit-sess' } }),
          promptAsync: async () => ({ data: {}, error: null }),
        },
      }

      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, pluginClient as any, v2Client as any, logger, getConfig, undefined, undefined, undefined, sectionPlansRepo)

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
