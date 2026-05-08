import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { extractSections } from '../../src/utils/section-capture'
import { decomposeDeterministically } from '../../src/services/deterministic-decomposer'
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

describe('Transcript Salvage', () => {
  describe('extractSections salvage', () => {
    test('recovers sections from transcript with markers', () => {
      const transcript = [
        'Here is my plan:',
        '<!-- forge-section:start -->',
        '## Setup',
        'Install dependencies',
        '<!-- forge-section:end -->',
        '',
        '<!-- forge-section:start -->',
        '## Build',
        'Compile code',
        '<!-- forge-section:end -->',
      ].join('\n')

      const sections = extractSections(transcript, { maxSections: 12 })
      expect(sections).toHaveLength(2)
      expect(sections[0].title).toBe('Setup')
      expect(sections[1].title).toBe('Build')
      expect(sections[0].index).toBe(0)
      expect(sections[1].index).toBe(1)
    })

    test('returns empty for transcript without markers', () => {
      const transcript = 'No sections here, just plain text'

      const sections = extractSections(transcript, { maxSections: 12 })
      expect(sections).toEqual([])
    })
  })

  describe('decomposeDeterministically salvage', () => {
    test('recovers sections from transcript with ## Section N: headings', () => {
      const transcript = [
        '## Section 0: Setup',
        '- Create files',
        '## Section 1: Build',
        '- Compile code',
      ].join('\n')

      const sections = decomposeDeterministically(transcript, { maxSections: 12 })
      expect(sections).toHaveLength(2)
      expect(sections[0].title).toBe('Setup')
      expect(sections[1].title).toBe('Build')
      expect(sections[0].index).toBe(0)
      expect(sections[1].index).toBe(1)
    })

    test('recovers sections from transcript with ## Phase N: headings', () => {
      const transcript = [
        '## Phase 1: Setup',
        '- Create files',
        '## Phase 2: Build',
        '- Compile code',
      ].join('\n')

      const sections = decomposeDeterministically(transcript, { maxSections: 12 })
      expect(sections).toHaveLength(2)
      expect(sections[0].title).toBe('Setup')
      expect(sections[1].title).toBe('Build')
    })

    test('returns empty for transcript without phase or section headings', () => {
      const transcript = 'Just plain text, no headings'

      const sections = decomposeDeterministically(transcript, { maxSections: 12 })
      expect(sections).toEqual([])
    })
  })

  describe('salvage ordering', () => {
    test('extractSections takes priority over decomposeDeterministically', () => {
      const transcript = [
        '<!-- forge-section:start -->',
        '## Marked Section',
        'Content from markers',
        '<!-- forge-section:end -->',
        '',
        '## Section 1: Unmarked Section',
        'Content from headings',
      ].join('\n')

      const markerSections = extractSections(transcript, { maxSections: 12 })
      expect(markerSections).toHaveLength(1)
      expect(markerSections[0].title).toBe('Marked Section')

      const deterministicSections = decomposeDeterministically(transcript, { maxSections: 12 })
      expect(deterministicSections).toHaveLength(1)
      expect(deterministicSections[0].title).toBe('Unmarked Section')
    })
  })

  describe('salvage exhausted path', () => {
    test('both methods return empty for transcript with no markers or headings', () => {
      const transcript = 'Just plain text, no sections or headings'

      const markerSections = extractSections(transcript, { maxSections: 12 })
      const deterministicSections = decomposeDeterministically(transcript, { maxSections: 12 })

      expect(markerSections).toEqual([])
      expect(deterministicSections).toEqual([])
    })

    test('salvage returns null when transcript has no extractable content', () => {
      const transcript = 'Empty conversation, nothing useful'

      const markerSections = extractSections(transcript, { maxSections: 12 })
      expect(markerSections).toHaveLength(0)

      const deterministicSections = decomposeDeterministically(transcript, { maxSections: 12 })
      expect(deterministicSections).toHaveLength(0)

      // Both methods returning empty means salvage would fall through to retry
    })
  })

  describe('idempotency with existing sections', () => {
    let db: Database
    let loopService: ReturnType<typeof createLoopService>
    let tempDir: string

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'salvage-idempotency-test-'))
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
      const sectionPlansRepo = createSectionPlansRepo(db)

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

    function insertLoop(overrides: Partial<{
      loopName: string
      phase: string
      decompositionStatus: string
      currentSectionIndex: number
      totalSections: number
      errorCount: number
    }> = {}) {
      const defaults = {
        loopName: 'test-loop',
        phase: 'coding',
        decompositionStatus: 'running',
        currentSectionIndex: 0,
        totalSections: 0,
        errorCount: 0,
      }
      const opts = { ...defaults, ...overrides }
      const loopsRepo = createLoopsRepo(db)
      const plansRepo = createPlansRepo(db)
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      const sectionPlansRepo = createSectionPlansRepo(db)
      loopsRepo.insert({
        projectId: PROJECT_ID,
        loopName: opts.loopName,
        status: 'running',
        currentSessionId: 'session-1',
        worktree: false,
        worktreeDir: '/tmp',
        worktreeBranch: null,
        projectDir: '/tmp',
        maxIterations: 5,
        iteration: 1,
        auditCount: 0,
        errorCount: opts.errorCount,
        phase: opts.phase as any,
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: Date.now(),
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        decompositionStatus: opts.decompositionStatus as any,
        decompositionMode: 'deterministic',
        decompositionSessionId: null,
        currentSectionIndex: opts.currentSectionIndex,
        totalSections: opts.totalSections,
        finalAuditDone: 0,
        finalAuditAttempts: 0,
      }, { prompt: 'plan text', lastAuditResult: null })
    }

    test('when totalSections > 0, salvage is skipped because guard requires totalSections === 0', () => {
      insertLoop({
        loopName: 'already-have-sections',
        decompositionStatus: 'failed',
        totalSections: 2,
        errorCount: 0,
      })

      const state = loopService.getActiveState('already-have-sections')
      expect(state).not.toBeNull()
      expect(state!.totalSections).toBe(2)

      // The guard condition is: errorCount === 0 && currentState.totalSections === 0
      // With totalSections > 0, salvage should be skipped entirely
      const shouldSalvage = state!.errorCount === 0 && state!.totalSections === 0
      expect(shouldSalvage).toBe(false)
    })

    test('when totalSections === 0 and errorCount === 0, salvage should be attempted', () => {
      insertLoop({
        loopName: 'no-sections-yet',
        decompositionStatus: 'failed',
        totalSections: 0,
        errorCount: 0,
      })

      const state = loopService.getActiveState('no-sections-yet')
      expect(state).not.toBeNull()
      expect(state!.totalSections).toBe(0)

      const shouldSalvage = state!.errorCount === 0 && state!.totalSections === 0
      expect(shouldSalvage).toBe(true)
    })
  })

  describe('happy salvage transitions to coding', () => {
    let db: Database
    let loopService: ReturnType<typeof createLoopService>
    let tempDir: string

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'salvage-transition-test-'))
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
      const sectionPlansRepo = createSectionPlansRepo(db)

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

    function createMockV2Client(options: {
      messagesCalls?: Array<{ lastMessageRole: string; text?: string }>
      createCalls?: Array<{ data?: { id: string }; error?: unknown }>
      createCallLog?: Array<{ args?: unknown; returnedId?: string }>
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
          create: async (args?: unknown) => {
            const callConfig = options.createCalls?.[createCallIndex.value]
            createCallIndex.value++
            const id = `mock-session-${Date.now()}`
            if (callConfig) {
              if (callConfig.error) {
                if (options.createCallLog) options.createCallLog.push({ args, returnedId: undefined })
                return { data: undefined, error: callConfig.error }
              }
              const returnedId = callConfig.data?.id ?? id
              if (options.createCallLog) options.createCallLog.push({ args, returnedId })
              return { data: callConfig.data ?? { id }, error: undefined }
            }
            if (options.createCallLog) options.createCallLog.push({ args, returnedId: id })
            return { data: { id }, error: undefined }
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
      decomposer: {
        maxSections: 12,
      },
    }

    test('real salvage from heading-only transcript transitions to coding phase', async () => {
      const loopsRepo = createLoopsRepo(db)
      loopsRepo.insert({
        projectId: PROJECT_ID,
        loopName: 'salvage-loop',
        status: 'running',
        currentSessionId: 'decomp-sess',
        worktree: false,
        worktreeDir: '/tmp',
        worktreeBranch: null,
        projectDir: '/tmp',
        maxIterations: 5,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'decomposing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: Date.now(),
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        decompositionStatus: 'failed',
        decompositionMode: 'deterministic',
        decompositionSessionId: 'decomp-sess',
        currentSectionIndex: 0,
        totalSections: 0,
        finalAuditDone: 0,
        finalAuditAttempts: 0,
      }, { prompt: 'plan text', lastAuditResult: null })

      const transcript = [
        '## Section 0: Setup',
        '- Create files',
        '## Section 1: Build',
        '- Compile code',
      ].join('\n')

      loopService.registerLoopSession('decomp-sess', 'salvage-loop')

      const createCallLog: Array<{ args?: unknown; returnedId?: string }> = []
      const v2Client = createMockV2Client({
        messagesCalls: [{ lastMessageRole: 'assistant', text: transcript }],
        createCallLog,
      })

      const { logger } = createCapturingLogger()
      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopService, {} as any, v2Client, logger, getConfig)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'decomp-sess',
            status: { type: 'idle' },
          },
        },
      })

      const after = loopService.getActiveState('salvage-loop')!
      expect(after.phase).toBe('coding')
      expect(after.decompositionStatus).toBe('completed')
      expect(after.totalSections).toBe(2)

      const plan0 = loopService.getSectionPlan(after, 0)
      expect(plan0).not.toBeNull()
      expect(plan0!.title).toBe('Setup')

      const plan1 = loopService.getSectionPlan(after, 1)
      expect(plan1).not.toBeNull()
      expect(plan1!.title).toBe('Build')

      const decompSessionCreated = createCallLog.some(c => {
        const args = c.args as Record<string, unknown> | undefined
        return args?.title && typeof args.title === 'string' && args.title.includes('decomposer')
      })
      expect(decompSessionCreated).toBe(false)
    })

    test('real salvage from marker-based transcript transitions to coding phase', async () => {
      const loopsRepo = createLoopsRepo(db)
      loopsRepo.insert({
        projectId: PROJECT_ID,
        loopName: 'marker-salvage-loop',
        status: 'running',
        currentSessionId: 'decomp-sess',
        worktree: false,
        worktreeDir: '/tmp',
        worktreeBranch: null,
        projectDir: '/tmp',
        maxIterations: 5,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'decomposing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: Date.now(),
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        decompositionStatus: 'failed',
        decompositionMode: 'deterministic',
        decompositionSessionId: 'decomp-sess',
        currentSectionIndex: 0,
        totalSections: 0,
        finalAuditDone: 0,
        finalAuditAttempts: 0,
      }, { prompt: 'plan text', lastAuditResult: null })

      const transcript = [
        '<!-- forge-section:start -->',
        '## Setup',
        'Install dependencies',
        '<!-- forge-section:end -->',
        '',
        '<!-- forge-section:start -->',
        '## Build',
        'Compile code',
        '<!-- forge-section:end -->',
      ].join('\n')

      loopService.registerLoopSession('decomp-sess', 'marker-salvage-loop')

      const createCallLog: Array<{ args?: unknown; returnedId?: string }> = []
      const v2Client = createMockV2Client({
        messagesCalls: [{ lastMessageRole: 'assistant', text: transcript }],
        createCallLog,
      })

      const { logger } = createCapturingLogger()
      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopService, {} as any, v2Client, logger, getConfig)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'decomp-sess',
            status: { type: 'idle' },
          },
        },
      })

      const after = loopService.getActiveState('marker-salvage-loop')!
      expect(after.phase).toBe('coding')
      expect(after.decompositionStatus).toBe('completed')
      expect(after.totalSections).toBe(2)

      const plan0 = loopService.getSectionPlan(after, 0)
      expect(plan0).not.toBeNull()
      expect(plan0!.title).toBe('Setup')

      const plan1 = loopService.getSectionPlan(after, 1)
      expect(plan1).not.toBeNull()
      expect(plan1!.title).toBe('Build')

      const decompSessionCreated = createCallLog.some(c => {
        const args = c.args as Record<string, unknown> | undefined
        return args?.title && typeof args.title === 'string' && args.title.includes('decomposer')
      })
      expect(decompSessionCreated).toBe(false)
    })

    test('unsalvageable transcript falls through to decomposer retry via real hook path', async () => {
      const loopsRepo = createLoopsRepo(db)
      loopsRepo.insert({
        projectId: PROJECT_ID,
        loopName: 'retry-loop',
        status: 'running',
        currentSessionId: 'decomp-sess',
        worktree: false,
        worktreeDir: '/tmp',
        worktreeBranch: null,
        projectDir: '/tmp',
        maxIterations: 5,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'decomposing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: Date.now(),
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        decompositionStatus: 'failed',
        decompositionMode: 'deterministic',
        decompositionSessionId: 'decomp-sess',
        currentSectionIndex: 0,
        totalSections: 0,
        finalAuditDone: 0,
        finalAuditAttempts: 0,
      }, { prompt: 'plan text', lastAuditResult: null })

      const transcript = 'Just plain text, no sections or headings at all'

      loopService.registerLoopSession('decomp-sess', 'retry-loop')

      const createCallLog: Array<{ args?: unknown; returnedId?: string }> = []
      const v2Client = createMockV2Client({
        messagesCalls: [{ lastMessageRole: 'assistant', text: transcript }],
        createCallLog,
      })

      const { logger } = createCapturingLogger()
      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopService, {} as any, v2Client, logger, getConfig)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'decomp-sess',
            status: { type: 'idle' },
          },
        },
      })

      const after = loopService.getActiveState('retry-loop')!
      expect(after.decompositionStatus).toBe('running')
      expect(after.totalSections).toBe(0)

      const decompSessionCreated = createCallLog.some(c => {
        const args = c.args as Record<string, unknown> | undefined
        return args?.title && typeof args.title === 'string' && args.title.includes('decomposer')
      })
      expect(decompSessionCreated).toBe(true)
    })

    test('idempotency with existing sections does not double-insert via real hook path', async () => {
      const loopsRepo = createLoopsRepo(db)
      loopsRepo.insert({
        projectId: PROJECT_ID,
        loopName: 'idempotent-loop',
        status: 'running',
        currentSessionId: 'decomp-sess',
        worktree: false,
        worktreeDir: '/tmp',
        worktreeBranch: null,
        projectDir: '/tmp',
        maxIterations: 5,
        iteration: 1,
        auditCount: 0,
        errorCount: 0,
        phase: 'decomposing',
        executionModel: null,
        auditorModel: null,
        modelFailed: false,
        sandbox: false,
        sandboxContainer: null,
        startedAt: Date.now(),
        completedAt: null,
        terminationReason: null,
        completionSummary: null,
        workspaceId: null,
        hostSessionId: null,
        decompositionStatus: 'failed',
        decompositionMode: 'deterministic',
        decompositionSessionId: 'decomp-sess',
        currentSectionIndex: 0,
        totalSections: 2,
        finalAuditDone: 0,
        finalAuditAttempts: 0,
      }, { prompt: 'plan text', lastAuditResult: null })

      loopService.bulkInsertSections('idempotent-loop', [
        { index: 0, title: 'Section A', content: 'Content A' },
        { index: 1, title: 'Section B', content: 'Content B' },
      ])

      loopService.registerLoopSession('decomp-sess', 'idempotent-loop')

      const createCallLog: Array<{ args?: unknown; returnedId?: string }> = []
      const v2Client = createMockV2Client({
        messagesCalls: [{ lastMessageRole: 'assistant', text: 'plain text' }],
        createCallLog,
      })

      const { logger } = createCapturingLogger()
      const getConfig = () => mockConfig as PluginConfig

      const handler = createLoopEventHandler(loopService, {} as any, v2Client, logger, getConfig)

      await handler.onEvent({
        event: {
          type: 'session.status',
          properties: {
            sessionID: 'decomp-sess',
            status: { type: 'idle' },
          },
        },
      })

      const after = loopService.getActiveState('idempotent-loop')!
      expect(after.totalSections).toBe(2)

      const plan0 = loopService.getSectionPlan(after, 0)
      expect(plan0).not.toBeNull()
      expect(plan0!.title).toBe('Section A')

      const plan1 = loopService.getSectionPlan(after, 1)
      expect(plan1).not.toBeNull()
      expect(plan1!.title).toBe('Section B')
    })
  })
})
