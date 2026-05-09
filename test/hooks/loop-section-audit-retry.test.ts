import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService, type LoopState, MAX_RETRIES } from '../../src/services/loop'
import { createLoopEventHandler } from '../../src/hooks/loop'
import type { Logger, PluginConfig } from '../../src/types'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

const PROJECT_ID = 'test-project'

describe('Loop Section Audit Retry', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-section-audit-retry-test-'))
    db = new Database(join(tempDir, 'test.db'))

    db.exec(`
      CREATE TABLE loops (
        project_id           TEXT NOT NULL,
        loop_name            TEXT NOT NULL,
        status               TEXT NOT NULL,
        current_session_id   TEXT NOT NULL,
        worktree             INTEGER NOT NULL,
        worktree_dir         TEXT NOT NULL,
        session_directory    TEXT,
        worktree_branch      TEXT,
        project_dir          TEXT NOT NULL,
        max_iterations       INTEGER NOT NULL,
        iteration            INTEGER NOT NULL DEFAULT 0,
        audit_count          INTEGER NOT NULL DEFAULT 0,
        error_count          INTEGER NOT NULL DEFAULT 0,
        phase                TEXT NOT NULL,
        execution_model      TEXT,
        auditor_model        TEXT,
        model_failed         INTEGER NOT NULL DEFAULT 0,
        sandbox              INTEGER NOT NULL DEFAULT 0,
        sandbox_container    TEXT,
        started_at           INTEGER NOT NULL,
        completed_at         INTEGER,
        termination_reason   TEXT,
        completion_summary   TEXT,
        workspace_id         TEXT,
        host_session_id      TEXT,
        audit_session_id     TEXT,
        decomposition_status TEXT NOT NULL DEFAULT 'pending' CHECK (decomposition_status IN ('pending','running','completed','failed','skipped')),
        decomposition_mode TEXT NOT NULL DEFAULT 'agent' CHECK (decomposition_mode IN ('agent','deterministic')),
        decomposition_session_id TEXT,
        current_section_index INTEGER NOT NULL DEFAULT 0,
        total_sections INTEGER NOT NULL DEFAULT 0,
        final_audit_done INTEGER NOT NULL DEFAULT 0,
        final_audit_attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, loop_name)
      )
    `)

    db.exec(`
      CREATE TABLE loop_large_fields (
        project_id          TEXT NOT NULL,
        loop_name           TEXT NOT NULL,
        prompt              TEXT,
        last_audit_result   TEXT,
        PRIMARY KEY (project_id, loop_name),
        FOREIGN KEY (project_id, loop_name) REFERENCES loops(project_id, loop_name) ON DELETE CASCADE
      )
    `)

    db.exec(`
      CREATE TABLE plans (
        project_id   TEXT NOT NULL,
        loop_name    TEXT,
        session_id   TEXT,
        content      TEXT NOT NULL,
        updated_at   INTEGER NOT NULL,
        CHECK (loop_name IS NOT NULL OR session_id IS NOT NULL),
        CHECK (NOT (loop_name IS NOT NULL AND session_id IS NOT NULL)),
        UNIQUE (project_id, loop_name),
        UNIQUE (project_id, session_id)
      )
    `)

    db.exec(`
      CREATE TABLE review_findings (
        project_id TEXT NOT NULL,
        loop_name TEXT NOT NULL DEFAULT '',
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        severity TEXT NOT NULL,
        description TEXT NOT NULL,
        scenario TEXT,
        created_at INTEGER NOT NULL,
        section_index INTEGER,
        PRIMARY KEY (project_id, loop_name, file, line, section_index)
      )
    `)

    db.exec(`
      CREATE TABLE section_plans (
        project_id TEXT NOT NULL,
        loop_name TEXT NOT NULL,
        section_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        completed_at INTEGER,
        summary_done TEXT,
        summary_deviations TEXT,
        summary_follow_ups TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, loop_name, section_index)
      )
    `)

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
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
      worktree: true,
      modelFailed: false,
      sandbox: false,
      executionModel: 'test/model',
      auditorModel: 'test/auditor',
      decompositionStatus: 'completed',
      decompositionMode: 'deterministic',
      decompositionSessionId: null,
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

      const handler = createLoopEventHandler(loopService, pluginClient as any, v2Client as any, logger, getConfig)

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

      const handler = createLoopEventHandler(loopService, pluginClient as any, v2Client as any, logger, getConfig)

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

      const handler = createLoopEventHandler(loopService, pluginClient as any, v2Client as any, logger, getConfig)

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

      const handler = createLoopEventHandler(loopService, pluginClient as any, v2Client as any, logger, getConfig)

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
