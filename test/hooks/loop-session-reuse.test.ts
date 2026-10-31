import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopSessionUsageRepo } from '../../src/storage/repos/loop-session-usage-repo'
import { createLoopTransitionsRepo } from '../../src/storage/repos/loop-transitions-repo'
import { createLoopService } from '../../src/loop/service'
import type { LoopState } from '../../src/loop/state'
import { createLoopEventHandler, type LoopEventHandler } from '../../src/hooks/loop'
import { AUDITOR_HANDOFF_INSTRUCTION } from '../../src/loop/prompts'
import type { Logger, PluginConfig } from '../../src/types'
import { createFakeForgeClient } from '../helpers/fake-client'
import { recordAuditorHandoff, recordCoderHandoff } from '../helpers/loop-handoff'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import type { ModelContextLimitParams } from '../../src/client/port'
import { __resetIdleGate, hasSuppressedIdle, recordInboxEnqueued } from '../../src/loop/idle-gate'
import { __resetInFlightGuard } from '../../src/loop/in-flight-guard'
import { __resetLoopRuntimeSharedState } from '../../src/loop/runtime'

const PROJECT_ID = 'test-project'
const FULL_PROMPT_MARKER = '## Section plan'
const FOLLOW_UP_MARKER = 'The audit of your previous changes left the findings below open.'
const AUDIT_FOLLOW_UP_MARKER = 'The coder has finished the next attempt for this scope.'

interface AssistantOptions {
  id?: string
  tokens?: number
  text?: string
  providerID?: string
  modelID?: string
}

function assistantMessage(options: AssistantOptions = {}) {
  const tokens = options.tokens === undefined ? undefined : {
    input: options.tokens,
    output: 1,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
  return {
    info: {
      id: options.id,
      role: 'assistant' as const,
      finish: 'stop' as const,
      ...(options.providerID ? { providerID: options.providerID } : {}),
      ...(options.modelID ? { modelID: options.modelID } : {}),
      ...(tokens ? { tokens } : {}),
    },
    parts: [{ type: 'text' as const, text: options.text ?? 'work done' }],
  }
}

describe('Loop session reuse', () => {
  let db: Database
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  let loopSessionUsageRepo: ReturnType<typeof createLoopSessionUsageRepo>
  let loopTransitionsRepo: ReturnType<typeof createLoopTransitionsRepo>
  let tempDir: string
  let handler: LoopEventHandler | null

  const mockConfig: PluginConfig = {
    executionModel: 'test/model',
    auditorModel: 'test/auditor',
    loop: { enabled: true, defaultMaxIterations: 5 },
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-session-reuse-test-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)

    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    loopSessionUsageRepo = createLoopSessionUsageRepo(db)
    loopTransitionsRepo = createLoopTransitionsRepo(db)
    handler = null
  })

  afterEach(() => {
    handler?.clearAllRetryTimeouts()
    __resetIdleGate()
    __resetInFlightGuard()
    __resetLoopRuntimeSharedState()
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  function configWithSessionReuse(sessionReuse: { coderContextPercent?: number; auditorContextPercent?: number }): PluginConfig {
    return { ...mockConfig, loop: { ...mockConfig.loop, sessionReuse } }
  }

  function makeState(overrides: Partial<LoopState> = {}): LoopState {
    return {
      active: true,
      sessionId: 'audit-1',
      loopName: 'reuse-loop',
      worktreeDir: join(tempDir, 'worktree'),
      projectDir: '/tmp/host-project',
      worktreeBranch: 'test/reuse',
      iteration: 1,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Test prompt',
      phase: 'auditing',
      errorCount: 0,
      auditCount: 1,
      status: 'running',
      worktree: true,
      modelFailed: false,
      sandbox: false,
      executionModel: 'test/model',
      auditorModel: 'test/auditor',
      currentSectionIndex: 0,
      totalSections: 2,
      ...overrides,
    }
  }

  function createHarness(options: {
    state: LoopState
    messages: Record<string, ReturnType<typeof assistantMessage>[]>
    sections?: number
    config?: PluginConfig
    contextLimit?: (params: ModelContextLimitParams) => Promise<number | undefined>
    compact?: (params: { sessionID: string }) => Promise<void>
    status?: () => Promise<Record<string, { type: string }>>
  }) {
    const logs: string[] = []
    const logger: Logger = {
      log: (message: string) => logs.push(message),
      error: (message: string) => logs.push(`error: ${message}`),
      debug: (message: string) => logs.push(message),
    }

    const messagesBySession = new Map(Object.entries(options.messages))
    let sessionCounter = 0

    const { client, calls } = createFakeForgeClient({
      session: {
        create: async () => {
          sessionCounter += 1
          return { id: `created-session-${sessionCounter}` }
        },
        messages: async (params: any) => messagesBySession.get(params.sessionID) ?? [],
        ...(options.compact ? { compact: options.compact } : {}),
        ...(options.status ? { status: options.status } : {}),
      },
      model: options.contextLimit ? { contextLimit: options.contextLimit } : undefined,
    })

    const service = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      logger,
      undefined,
      undefined,
      sectionPlansRepo,
      loopTransitionsRepo,
    )
    service.setState(options.state.loopName, options.state)
    if (options.sections) seedSections(options.state.loopName, options.sections)

    handler = createLoopEventHandler(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      client,
      logger,
      () => options.config ?? mockConfig,
      undefined,
      undefined,
      undefined,
      sectionPlansRepo,
      undefined,
      undefined,
      loopSessionUsageRepo,
      loopTransitionsRepo,
    )

    return { calls, client, logger, logs, messagesBySession, service }
  }

  function seedSections(loopName: string, total = 2) {
    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName,
      sections: Array.from({ length: total }, (_, index) => ({
        index,
        title: `Section ${index + 1}`,
        content: `Content for section ${index + 1}`,
      })),
    })
  }

  async function idle(sessionId: string) {
    await handler!.onEvent({
      event: { type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } },
    })
  }

  function promptsTo(calls: Array<{ method: string; params: any }>, sessionId: string) {
    return calls
      .filter((call) => call.method === 'session.promptAsync' && call.params?.sessionID === sessionId)
      .map((call) => (call.params.parts ?? []).map((part: any) => part.text ?? '').join('\n'))
  }

  function createCalls(calls: Array<{ method: string }>) {
    return calls.filter((call) => call.method === 'session.create')
  }

  function compactCalls(calls: Array<{ method: string; params: any }>) {
    return calls.filter((call) => call.method === 'session.compact').map((call) => call.params)
  }

  function callIndex(calls: Array<{ method: string; params: any }>, method: string, sessionId?: string) {
    return calls.findIndex((call) => call.method === method && (sessionId === undefined || call.params?.sessionID === sessionId))
  }

  function deletedSessionIds(calls: Array<{ method: string; params: any }>) {
    return calls.filter((call) => call.method === 'session.delete').map((call) => call.params.sessionID)
  }

  describe('sectioned retry', () => {
    test('a dirty section audit reuses the coder standby with a findings-only follow-up prompt', async () => {
      const state = makeState({ sessionId: 'audit-1', standbySessionId: 'coder-1' })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Retry handler drops the second event',
        sectionIndex: 0,
      })

      const { calls, service } = createHarness({
        state,
        sections: 2,
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1', text: 'Dirty: the retry handler still drops the second event.' })],
          'coder-1': [assistantMessage({ id: 'm-coder-1', text: 'Implemented the section.' })],
        },
      })

      await recordAuditorHandoff(handler!.loop, 'audit-1')
      await idle('audit-1')

      expect(createCalls(calls)).toHaveLength(0)
      const coderPrompts = promptsTo(calls, 'coder-1')
      expect(coderPrompts).toHaveLength(1)
      expect(coderPrompts[0]).toContain(FOLLOW_UP_MARKER)
      expect(coderPrompts[0]).toContain('Retry handler drops the second event')
      expect(coderPrompts[0]).not.toContain("Prior Sections' Summaries")
      expect(coderPrompts[0]).not.toContain(FULL_PROMPT_MARKER)

      const after = service.getActiveState(state.loopName)!
      expect(after.phase).toBe('coding')
      expect(after.sessionId).toBe('coder-1')
      expect(after.standbySessionId).toBe('audit-1')

      const transitions = loopTransitionsRepo.listForLoop(PROJECT_ID, state.loopName)
      expect(transitions.some((row) => row.eventType === 'auditor-handoff' && row.toPhase === 'coding')).toBe(true)
    })

    test('the next coding idle reuses the audit standby with the audit follow-up prompt', async () => {
      const state = makeState({ phase: 'coding', sessionId: 'coder-1', standbySessionId: 'audit-1', auditCount: 0 })
      const { calls, service } = createHarness({
        state,
        sections: 2,
        messages: {
          'coder-1': [assistantMessage({ id: 'm-coder-2', text: 'Patched the retry handler.' })],
          'audit-1': [assistantMessage({ id: 'm-audit-1', text: 'Earlier audit turn.' })],
        },
      })

      await recordCoderHandoff(handler!.loop, 'coder-1')
      await idle('coder-1')

      expect(createCalls(calls)).toHaveLength(0)
      const auditPrompts = promptsTo(calls, 'audit-1')
      expect(auditPrompts).toHaveLength(1)
      expect(auditPrompts[0]).toContain('[Loop section audit 1/2 (follow-up)]')
      expect(auditPrompts[0]).toContain(AUDIT_FOLLOW_UP_MARKER)
      expect(auditPrompts[0]).toContain('## Required: auditor handoff')
      expect(auditPrompts[0]).toContain(AUDITOR_HANDOFF_INSTRUCTION)

      const after = service.getActiveState(state.loopName)!
      expect(after.phase).toBe('auditing')
      expect(after.sessionId).toBe('audit-1')
      expect(after.standbySessionId).toBe('coder-1')

      const transitions = loopTransitionsRepo.listForLoop(PROJECT_ID, state.loopName)
      expect(transitions.some((row) => row.eventType === 'coder-handoff' && row.toPhase === 'auditing')).toBe(true)
    })

    test('the reused audit session is re-titled for the new iteration', async () => {
      const state = makeState({ phase: 'coding', sessionId: 'coder-1', standbySessionId: 'audit-1', auditCount: 0 })
      const { calls } = createHarness({
        state,
        sections: 2,
        messages: {
          'coder-1': [assistantMessage({ id: 'm-coder-2' })],
          'audit-1': [assistantMessage({ id: 'm-audit-1' })],
        },
      })

      await recordCoderHandoff(handler!.loop, 'coder-1')
      await idle('coder-1')

      const update = calls.find((call) => call.method === 'session.update')
      expect(update?.params.title).toBe('Loop: reuse-loop 1/2 #1')
    })
  })

  describe('fallbacks', () => {    test('a missing standby falls back to a fresh coder session and deletes the standby', async () => {
      const state = makeState({ sessionId: 'audit-1', standbySessionId: 'gone-coder' })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Retry handler drops the second event',
        sectionIndex: 0,
      })

      const { calls, service } = createHarness({
        state,
        sections: 2,
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1', text: 'Dirty.' })],
        },
      })

      await recordAuditorHandoff(handler!.loop, 'audit-1')
      await idle('audit-1')

      expect(createCalls(calls)).toHaveLength(1)
      const freshPrompts = promptsTo(calls, 'created-session-1')
      expect(freshPrompts).toHaveLength(1)
      expect(freshPrompts[0]).toContain(FULL_PROMPT_MARKER)
      expect(freshPrompts[0]).not.toContain(FOLLOW_UP_MARKER)

      expect(deletedSessionIds(calls)).toContain('gone-coder')
      const after = service.getActiveState(state.loopName)!
      expect(after.phase).toBe('coding')
      expect(after.sessionId).toBe('created-session-1')
      expect(after.standbySessionId).toBe('audit-1')
    })

    test('a coder standby over its context percent is compacted, then prompted in the same session', async () => {
      const state = makeState({ sessionId: 'audit-1', standbySessionId: 'fat-coder' })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Retry handler drops the second event',
        sectionIndex: 0,
      })

      const { calls, service } = createHarness({
        state,
        sections: 2,
        config: { ...mockConfig, loop: { ...mockConfig.loop, sessionReuse: { coderContextPercent: 50 } } },
        contextLimit: async () => 100_000,
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1', text: 'Dirty.' })],
          'fat-coder': [assistantMessage({ id: 'm-coder-1', tokens: 60_000, providerID: 'test', modelID: 'model' })],
        },
      })

      await recordAuditorHandoff(handler!.loop, 'audit-1')
      await idle('audit-1')

      expect(createCalls(calls)).toHaveLength(0)
      expect(compactCalls(calls)).toEqual([{ sessionID: 'fat-coder', directory: state.worktreeDir }])
      const compactIndex = callIndex(calls, 'session.compact', 'fat-coder')
      const promptIndex = callIndex(calls, 'session.promptAsync', 'fat-coder')
      expect(compactIndex).toBeGreaterThan(-1)
      expect(promptIndex).toBeGreaterThan(compactIndex)

      const coderPrompts = promptsTo(calls, 'fat-coder')
      expect(coderPrompts).toHaveLength(1)
      expect(coderPrompts[0]).toContain(FOLLOW_UP_MARKER)

      const after = service.getActiveState(state.loopName)!
      expect(after.sessionId).toBe('fat-coder')
      expect(after.standbySessionId).toBe('audit-1')
    })

    test('a coder standby under its context percent is reused without compaction', async () => {
      const state = makeState({ sessionId: 'audit-1', standbySessionId: 'coder-1' })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Retry handler drops the second event',
        sectionIndex: 0,
      })

      const { calls, service } = createHarness({
        state,
        sections: 2,
        config: configWithSessionReuse({ coderContextPercent: 50, auditorContextPercent: 50 }),
        contextLimit: async () => 100_000,
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1', text: 'Dirty.' })],
          'coder-1': [assistantMessage({ id: 'm-coder-1', tokens: 10_000, providerID: 'test', modelID: 'model' })],
        },
      })

      await recordAuditorHandoff(handler!.loop, 'audit-1')
      await idle('audit-1')

      expect(compactCalls(calls)).toHaveLength(0)
      expect(promptsTo(calls, 'coder-1')).toHaveLength(1)
      expect(service.getActiveState(state.loopName)!.sessionId).toBe('coder-1')
    })

    test('a failed compaction falls back to a fresh coder session with the full prompt', async () => {
      const state = makeState({ sessionId: 'audit-1', standbySessionId: 'fat-coder' })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Retry handler drops the second event',
        sectionIndex: 0,
      })

      const { calls, logs, service } = createHarness({
        state,
        sections: 2,
        config: configWithSessionReuse({ coderContextPercent: 50, auditorContextPercent: 50 }),
        contextLimit: async () => 100_000,
        compact: async () => {
          throw new Error('inbox unavailable')
        },
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1', text: 'Dirty.' })],
          'fat-coder': [assistantMessage({ id: 'm-coder-1', tokens: 60_000, providerID: 'test', modelID: 'model' })],
        },
      })

      await recordAuditorHandoff(handler!.loop, 'audit-1')
      await idle('audit-1')

      expect(compactCalls(calls)).toEqual([{ sessionID: 'fat-coder', directory: state.worktreeDir }])
      expect(promptsTo(calls, 'fat-coder')).toHaveLength(0)
      expect(createCalls(calls)).toHaveLength(1)
      expect(promptsTo(calls, 'created-session-1')[0]).toContain(FULL_PROMPT_MARKER)
      expect(deletedSessionIds(calls)).toContain('fat-coder')
      expect(logs.some((line) => line.includes('compaction of reused session fat-coder failed'))).toBe(true)

      const after = service.getActiveState(state.loopName)!
      expect(after.sessionId).toBe('created-session-1')
      expect(after.standbySessionId).toBe('audit-1')
    })

    test('an audit session over its context percent is kept as the next standby', async () => {
      const state = makeState({ sessionId: 'audit-1', standbySessionId: 'gone-coder' })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Retry handler drops the second event',
        sectionIndex: 0,
      })

      const { calls, service } = createHarness({
        state,
        sections: 2,
        config: configWithSessionReuse({ coderContextPercent: 50, auditorContextPercent: 50 }),
        contextLimit: async () => 100_000,
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1', text: 'Dirty.', tokens: 60_000, providerID: 'test', modelID: 'model' })],
        },
      })

      await recordAuditorHandoff(handler!.loop, 'audit-1')
      await idle('audit-1')

      expect(createCalls(calls)).toHaveLength(1)
      expect(deletedSessionIds(calls)).toContain('gone-coder')
      expect(deletedSessionIds(calls)).not.toContain('audit-1')
      const after = service.getActiveState(state.loopName)!
      expect(after.sessionId).toBe('created-session-1')
      expect(after.standbySessionId).toBe('audit-1')
    })

    test('a recurring blocking finding forces fresh sessions for both roles', async () => {
      const state = makeState({ sessionId: 'audit-1', standbySessionId: 'coder-1' })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Retry handler drops the second event',
        sectionIndex: 0,
      })
      const finding = {
        projectId: PROJECT_ID,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug' as const,
        description: 'Retry handler drops the second event',
        scenario: null,
        loopName: state.loopName,
        sectionIndex: 0,
        createdAt: Date.now(),
      }

      const { calls, service } = createHarness({
        state,
        sections: 2,
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1', text: 'Dirty again.' })],
          'coder-1': [assistantMessage({ id: 'm-coder-1' })],
        },
      })

      for (let i = 0; i < 3; i++) handler!.loop.service.bumpFindingRecurrence(state.loopName, [finding])

      await recordAuditorHandoff(handler!.loop, 'audit-1')
      await idle('audit-1')

      expect(createCalls(calls)).toHaveLength(1)
      expect(promptsTo(calls, 'coder-1')).toHaveLength(0)
      expect(promptsTo(calls, 'created-session-1')[0]).toContain(FULL_PROMPT_MARKER)
      const deleted = deletedSessionIds(calls)
      expect(deleted).toContain('coder-1')
      expect(deleted).toContain('audit-1')
      const after = service.getActiveState(state.loopName)!
      expect(after.sessionId).toBe('created-session-1')
      expect(after.standbySessionId).toBeUndefined()
    })
  })

  describe('context-window thresholds', () => {
    test('separate coder and auditor percents gate their own role', async () => {
      const state = makeState({ phase: 'coding', sessionId: 'coder-1', standbySessionId: 'audit-1', auditCount: 0 })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Retry handler drops the second event',
        sectionIndex: 0,
      })

      const { calls, messagesBySession, service } = createHarness({
        state,
        sections: 2,
        config: configWithSessionReuse({ coderContextPercent: 50, auditorContextPercent: 20 }),
        contextLimit: async () => 100_000,
        messages: {
          'coder-1': [assistantMessage({ id: 'm-coder-2', tokens: 30_000, providerID: 'test', modelID: 'model' })],
          'audit-1': [assistantMessage({ id: 'm-audit-1', tokens: 30_000, providerID: 'test', modelID: 'model' })],
        },
      })

      await recordCoderHandoff(handler!.loop, 'coder-1')
      await idle('coder-1')

      expect(createCalls(calls)).toHaveLength(0)
      expect(compactCalls(calls)).toEqual([{ sessionID: 'audit-1', directory: state.worktreeDir }])
      expect(callIndex(calls, 'session.compact', 'audit-1')).toBeLessThan(callIndex(calls, 'session.promptAsync', 'audit-1'))
      expect(promptsTo(calls, 'audit-1')[0]).toContain(AUDIT_FOLLOW_UP_MARKER)
      const afterAudit = service.getActiveState(state.loopName)!
      expect(afterAudit.phase).toBe('auditing')
      expect(afterAudit.sessionId).toBe('audit-1')
      expect(afterAudit.standbySessionId).toBe('coder-1')

      messagesBySession.set('audit-1', [
        assistantMessage({ id: 'm-audit-2', text: 'Still dirty.', providerID: 'test', modelID: 'model' }),
      ])
      await recordAuditorHandoff(handler!.loop, 'audit-1')
      await handler!.onEvent({
        event: { type: 'session.status', properties: { sessionID: 'audit-1', status: { type: 'busy' } } },
      })
      await idle('audit-1')

      expect(createCalls(calls)).toHaveLength(0)
      expect(compactCalls(calls)).toHaveLength(1)
      const coderPrompts = promptsTo(calls, 'coder-1')
      expect(coderPrompts).toHaveLength(1)
      expect(coderPrompts[0]).toContain(FOLLOW_UP_MARKER)
      const afterCoding = service.getActiveState(state.loopName)!
      expect(afterCoding.phase).toBe('coding')
      expect(afterCoding.sessionId).toBe('coder-1')
    })

    test('a coder percent of 0 disables coder reuse only', async () => {
      const state = makeState({ sessionId: 'audit-1', standbySessionId: 'coder-1' })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Retry handler drops the second event',
        sectionIndex: 0,
      })

      const { calls, logs, service } = createHarness({
        state,
        sections: 2,
        config: configWithSessionReuse({ coderContextPercent: 0, auditorContextPercent: 50 }),
        contextLimit: async () => 100_000,
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1', tokens: 1_000, providerID: 'test', modelID: 'model' })],
          'coder-1': [assistantMessage({ id: 'm-coder-1', tokens: 1_000, providerID: 'test', modelID: 'model' })],
        },
      })

      await recordAuditorHandoff(handler!.loop, 'audit-1')
      await idle('audit-1')

      expect(createCalls(calls)).toHaveLength(1)
      expect(promptsTo(calls, 'coder-1')).toHaveLength(0)
      expect(compactCalls(calls)).toHaveLength(0)
      expect(promptsTo(calls, 'created-session-1')[0]).toContain(FULL_PROMPT_MARKER)
      expect(logs.some((line) => line.includes('disabled for the code role'))).toBe(true)
      const after = service.getActiveState(state.loopName)!
      expect(after.sessionId).toBe('created-session-1')
      expect(after.standbySessionId).toBe('audit-1')
    })

    test('an auditor percent of 0 disables audit reuse only', async () => {
      const state = makeState({ phase: 'coding', sessionId: 'coder-1', standbySessionId: 'audit-1', auditCount: 0 })

      const { calls, logs, service } = createHarness({
        state,
        sections: 2,
        config: configWithSessionReuse({ coderContextPercent: 50, auditorContextPercent: 0 }),
        contextLimit: async () => 100_000,
        messages: {
          'coder-1': [assistantMessage({ id: 'm-coder-2', tokens: 1_000, providerID: 'test', modelID: 'model' })],
          'audit-1': [assistantMessage({ id: 'm-audit-1', tokens: 1_000, providerID: 'test', modelID: 'model' })],
        },
      })

      await recordCoderHandoff(handler!.loop, 'coder-1')
      await idle('coder-1')

      expect(createCalls(calls)).toHaveLength(1)
      expect(promptsTo(calls, 'audit-1')).toHaveLength(0)
      expect(compactCalls(calls)).toHaveLength(0)
      expect(deletedSessionIds(calls)).toContain('audit-1')
      expect(logs.some((line) => line.includes('disabled for the auditor role'))).toBe(true)
      const after = service.getActiveState(state.loopName)!
      expect(after.phase).toBe('auditing')
      expect(after.sessionId).toBe('created-session-1')
      expect(after.standbySessionId).toBe('coder-1')
    })

    test('an unknown context window allows reuse', async () => {
      const state = makeState({ sessionId: 'audit-1', standbySessionId: 'coder-1' })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Retry handler drops the second event',
        sectionIndex: 0,
      })

      const { calls, logs, service } = createHarness({
        state,
        sections: 2,
        config: configWithSessionReuse({ coderContextPercent: 50, auditorContextPercent: 50 }),
        contextLimit: async () => undefined,
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1', text: 'Dirty.', providerID: 'test', modelID: 'model' })],
          'coder-1': [assistantMessage({ id: 'm-coder-1', tokens: 900_000, providerID: 'test', modelID: 'model' })],
        },
      })

      await recordAuditorHandoff(handler!.loop, 'audit-1')
      await idle('audit-1')

      expect(createCalls(calls)).toHaveLength(0)
      expect(promptsTo(calls, 'coder-1')).toHaveLength(1)
      expect(compactCalls(calls)).toHaveLength(0)
      expect(logs.some((line) => line.includes('unknown context window'))).toBe(true)
      expect(service.getActiveState(state.loopName)!.sessionId).toBe('coder-1')
    })

    test('a failed context-window lookup allows reuse', async () => {
      const state = makeState({ sessionId: 'audit-1', standbySessionId: 'coder-1' })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Retry handler drops the second event',
        sectionIndex: 0,
      })

      const { calls, logs, service } = createHarness({
        state,
        sections: 2,
        config: configWithSessionReuse({ coderContextPercent: 50, auditorContextPercent: 50 }),
        contextLimit: async () => {
          throw new Error('model list unavailable')
        },
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1', text: 'Dirty.', providerID: 'test', modelID: 'model' })],
          'coder-1': [assistantMessage({ id: 'm-coder-1', tokens: 900_000, providerID: 'test', modelID: 'model' })],
        },
      })

      await recordAuditorHandoff(handler!.loop, 'audit-1')
      await idle('audit-1')

      expect(createCalls(calls)).toHaveLength(0)
      expect(promptsTo(calls, 'coder-1')).toHaveLength(1)
      expect(compactCalls(calls)).toHaveLength(0)
      expect(logs.some((line) => line.includes('context-window lookup failed'))).toBe(true)
      expect(service.getActiveState(state.loopName)!.sessionId).toBe('coder-1')
    })
  })

  describe('compaction on reuse', () => {
    test('an audit standby over its context percent is compacted, then audited in the same session', async () => {
      const state = makeState({ phase: 'coding', sessionId: 'coder-1', standbySessionId: 'fat-audit', auditCount: 0 })

      const { calls, service } = createHarness({
        state,
        sections: 2,
        config: configWithSessionReuse({ coderContextPercent: 50, auditorContextPercent: 50 }),
        contextLimit: async () => 100_000,
        messages: {
          'coder-1': [assistantMessage({ id: 'm-coder-1', tokens: 1_000, providerID: 'test', modelID: 'model' })],
          'fat-audit': [assistantMessage({ id: 'm-audit-1', tokens: 70_000, providerID: 'test', modelID: 'model' })],
        },
      })

      await recordCoderHandoff(handler!.loop, 'coder-1')
      await idle('coder-1')

      expect(createCalls(calls)).toHaveLength(0)
      expect(compactCalls(calls)).toEqual([{ sessionID: 'fat-audit', directory: state.worktreeDir }])
      const compactIndex = callIndex(calls, 'session.compact', 'fat-audit')
      const promptIndex = callIndex(calls, 'session.promptAsync', 'fat-audit')
      expect(compactIndex).toBeGreaterThan(-1)
      expect(promptIndex).toBeGreaterThan(compactIndex)
      expect(promptsTo(calls, 'fat-audit')[0]).toContain(AUDIT_FOLLOW_UP_MARKER)

      const after = service.getActiveState(state.loopName)!
      expect(after.phase).toBe('auditing')
      expect(after.sessionId).toBe('fat-audit')
      expect(after.standbySessionId).toBe('coder-1')
    })

    test('a failed audit compaction falls back to a fresh audit session with the full audit prompt', async () => {
      const state = makeState({ phase: 'coding', sessionId: 'coder-1', standbySessionId: 'fat-audit', auditCount: 0 })

      const { calls, logs, service } = createHarness({
        state,
        sections: 2,
        config: configWithSessionReuse({ coderContextPercent: 50, auditorContextPercent: 50 }),
        contextLimit: async () => 100_000,
        compact: async () => {
          throw new Error('inbox unavailable')
        },
        messages: {
          'coder-1': [assistantMessage({ id: 'm-coder-1', tokens: 1_000, providerID: 'test', modelID: 'model' })],
          'fat-audit': [assistantMessage({ id: 'm-audit-1', tokens: 70_000, providerID: 'test', modelID: 'model' })],
        },
      })

      await recordCoderHandoff(handler!.loop, 'coder-1')
      await idle('coder-1')

      expect(compactCalls(calls)).toEqual([{ sessionID: 'fat-audit', directory: state.worktreeDir }])
      expect(promptsTo(calls, 'fat-audit')).toHaveLength(0)
      expect(createCalls(calls)).toHaveLength(1)
      const freshAuditPrompts = promptsTo(calls, 'created-session-1')
      expect(freshAuditPrompts).toHaveLength(1)
      expect(freshAuditPrompts[0]).toContain('[Loop section audit 1/2]')
      expect(freshAuditPrompts[0]).not.toContain('(follow-up)')
      expect(deletedSessionIds(calls)).toContain('fat-audit')
      expect(logs.some((line) => line.includes('compaction of reused session fat-audit failed'))).toBe(true)

      const after = service.getActiveState(state.loopName)!
      expect(after.phase).toBe('auditing')
      expect(after.sessionId).toBe('created-session-1')
      expect(after.standbySessionId).toBe('coder-1')
    })

    test('an idle while the follow-up prompt is still queued does not advance the phase', async () => {
      const state = makeState({ sessionId: 'audit-1', standbySessionId: 'fat-coder' })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Retry handler drops the second event',
        sectionIndex: 0,
      })

      const { calls, service } = createHarness({
        state,
        sections: 2,
        config: configWithSessionReuse({ coderContextPercent: 50, auditorContextPercent: 50 }),
        contextLimit: async () => 100_000,
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1', text: 'Dirty.' })],
          'fat-coder': [assistantMessage({ id: 'm-coder-1', tokens: 60_000, providerID: 'test', modelID: 'model' })],
        },
      })

      await recordAuditorHandoff(handler!.loop, 'audit-1')
      await idle('audit-1')
      expect(compactCalls(calls)).toHaveLength(1)
      const createsAfterReuse = createCalls(calls).length
      const promptsAfterReuse = promptsTo(calls, 'fat-coder').length

      recordInboxEnqueued('fat-coder', 'inbox-follow-up-1')
      await idle('fat-coder')

      expect(hasSuppressedIdle('fat-coder')).toBe(true)
      expect(createCalls(calls)).toHaveLength(createsAfterReuse)
      expect(promptsTo(calls, 'fat-coder')).toHaveLength(promptsAfterReuse)
      const after = service.getActiveState(state.loopName)!
      expect(after.phase).toBe('coding')
      expect(after.sessionId).toBe('fat-coder')
    })

    test('a compaction record is never read as the reused session turn result', async () => {
      const state = makeState({ sessionId: 'audit-1', standbySessionId: 'coder-1' })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Retry handler drops the second event',
        sectionIndex: 0,
      })

      const { calls, logs, service } = createHarness({
        state,
        sections: 2,
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1', text: 'Dirty.' })],
          'coder-1': [
            assistantMessage({ id: 'm-coder-1', text: 'Old reply' }),
            { info: { id: 'm-compaction', role: 'compaction' }, parts: [] },
          ] as any,
        },
      })

      await recordAuditorHandoff(handler!.loop, 'audit-1')
      await idle('audit-1')
      expect(service.getActiveState(state.loopName)!.sessionId).toBe('coder-1')
      const createsAfterReuse = createCalls(calls).length

      await handler!.onEvent({
        event: { type: 'session.status', properties: { sessionID: 'coder-1', status: { type: 'busy' } } },
      })
      await idle('coder-1')

      expect(createCalls(calls)).toHaveLength(createsAfterReuse)
      expect(logs.some((line) => line.includes('last message role: compaction'))).toBe(true)
      const coderPrompts = promptsTo(calls, 'coder-1')
      expect(coderPrompts).toHaveLength(2)
      expect(coderPrompts[1]).toContain(FULL_PROMPT_MARKER)
      const after = service.getActiveState(state.loopName)!
      expect(after.phase).toBe('coding')
      expect(after.sessionId).toBe('coder-1')
      expect(after.standbySessionId).toBe('audit-1')
    })
  })

  describe('audit failure', () => {
    test('reuses the coder standby with the failure notice and no findings claim in the follow-up', async () => {
      const state = makeState({ phase: 'auditing', sessionId: 'audit-1', standbySessionId: 'coder-1' })
      const { calls, service } = createHarness({
        state,
        sections: 2,
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1' })],
          'coder-1': [assistantMessage({ id: 'm-coder-1' })],
        },
      })

      await handler!.onEvent({
        event: {
          type: 'session.error',
          properties: { sessionID: 'audit-1', error: { name: 'UnknownError', data: { message: 'boom' } } },
        },
      })

      expect(createCalls(calls)).toHaveLength(0)
      const coderPrompts = promptsTo(calls, 'coder-1')
      expect(coderPrompts).toHaveLength(1)
      expect(coderPrompts[0]).toContain('## Loop notice')
      expect(coderPrompts[0]).toContain('Auditor session failed: boom. Continuing without new findings.')
      expect(coderPrompts[0]).toContain('left no open findings')
      expect(coderPrompts[0]).not.toContain('findings below open')

      expect(deletedSessionIds(calls)).toContain('audit-1')
      const after = service.getActiveState(state.loopName)!
      expect(after.phase).toBe('coding')
      expect(after.sessionId).toBe('coder-1')
      expect(after.standbySessionId).toBeUndefined()

      const transitions = loopTransitionsRepo.listForLoop(PROJECT_ID, state.loopName)
      expect(
        transitions.some(
          (row) => row.eventType === 'audit-session-error' && row.transitionKind === 'error-recovery' && row.toPhase === 'coding',
        ),
      ).toBe(true)
    })
  })

  describe('release paths', () => {
    test('a clean section advance deletes the standby and captures its usage', async () => {
      const state = makeState({ sessionId: 'audit-1', standbySessionId: 'coder-1' })
      sectionPlansRepo.setStatus(PROJECT_ID, state.loopName, 0, 'in_progress')

      const { calls, service } = createHarness({
        state,
        sections: 2,
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1', text: 'All clear.' })],
          'coder-1': [assistantMessage({ id: 'm-coder-1', tokens: 100 })],
        },
      })

      await recordAuditorHandoff(handler!.loop, 'audit-1', {
        summary: { done: ['Implemented the section'], deviations: [], followUps: [] },
      })
      await idle('audit-1')

      expect(createCalls(calls)).toHaveLength(1)
      expect(deletedSessionIds(calls)).toContain('coder-1')
      const after = service.getActiveState(state.loopName)!
      expect(after.currentSectionIndex).toBe(1)
      expect(after.standbySessionId).toBeUndefined()
      expect(loopSessionUsageRepo.hasSession(PROJECT_ID, state.loopName, 'coder-1')).toBe(true)
      expect(loopSessionUsageRepo.listSessionUsage(PROJECT_ID, state.loopName).find((row) => row.sessionId === 'coder-1')?.role).toBe('code')
    })

    test('completion of a non-sectioned loop releases the standby with captured usage', async () => {
      const state = makeState({ phase: 'auditing', sessionId: 'audit-1', standbySessionId: 'coder-1', totalSections: 0, auditCount: 1 })
      const { calls, service } = createHarness({
        state,
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1', text: 'All clean.' })],
          'coder-1': [assistantMessage({ id: 'm-coder-1', tokens: 100 })],
        },
      })

      await recordAuditorHandoff(handler!.loop, 'audit-1')
      await idle('audit-1')

      expect(deletedSessionIds(calls)).toContain('coder-1')
      expect(service.getActiveState(state.loopName)).toBeNull()
      expect(loopsRepo.get(PROJECT_ID, state.loopName)!.standbySessionId).toBeNull()
      expect(loopSessionUsageRepo.listSessionUsage(PROJECT_ID, state.loopName).find((row) => row.sessionId === 'coder-1')?.role).toBe('code')
    })

    test('termination deletes the standby and clears the column', async () => {
      const state = makeState({ phase: 'auditing', sessionId: 'audit-1', standbySessionId: 'coder-1' })
      const { calls } = createHarness({
        state,
        sections: 2,
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1' })],
          'coder-1': [assistantMessage({ id: 'm-coder-1', tokens: 100 })],
        },
      })

      await handler!.loop.terminate(state.loopName, { kind: 'user_aborted' })

      expect(deletedSessionIds(calls)).toContain('coder-1')
      expect(loopsRepo.get(PROJECT_ID, state.loopName)!.standbySessionId).toBeNull()
    })

    test('a restart deletes the standby and never resumes it', async () => {
      const state = makeState({ phase: 'auditing', sessionId: 'audit-1', standbySessionId: 'coder-1' })
      const { calls } = createHarness({
        state,
        sections: 2,
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1' })],
          'coder-1': [assistantMessage({ id: 'm-coder-1' })],
        },
      })

      handler!.loop.restart(state.loopName, {
        newSessionId: 'restarted-session',
        newState: { ...state, sessionId: 'restarted-session', phase: 'coding', standbySessionId: undefined },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(deletedSessionIds(calls)).toContain('coder-1')
      expect(loopsRepo.get(PROJECT_ID, state.loopName)!.standbySessionId).toBeNull()
    })
  })

  describe('non-sectioned loops', () => {
    test('a dirty audit reuses the coder standby', async () => {
      const state = makeState({ phase: 'auditing', sessionId: 'audit-1', standbySessionId: 'coder-1', totalSections: 0, auditCount: 1 })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/plan.ts',
        line: 9,
        severity: 'bug',
        description: 'Plan phase two is missing',
      })

      const { calls, service } = createHarness({
        state,
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1', text: 'Still missing phase two.' })],
          'coder-1': [assistantMessage({ id: 'm-coder-1' })],
        },
      })

      await recordAuditorHandoff(handler!.loop, 'audit-1')
      await idle('audit-1')

      expect(createCalls(calls)).toHaveLength(0)
      const coderPrompts = promptsTo(calls, 'coder-1')
      expect(coderPrompts).toHaveLength(1)
      expect(coderPrompts[0]).toContain('[Loop iteration 2 / 5 (follow-up)]')
      expect(coderPrompts[0]).toContain('Plan phase two is missing')
      const after = service.getActiveState(state.loopName)!
      expect(after.phase).toBe('coding')
      expect(after.standbySessionId).toBe('audit-1')
    })
  })

  describe('stale-turn guard', () => {
    test('an idle on a reused session whose last assistant message is unchanged nudges for a handoff and stays in coding', async () => {
      const state = makeState({ sessionId: 'audit-1', standbySessionId: 'coder-1' })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/broken.ts',
        line: 5,
        severity: 'bug',
        description: 'Retry handler drops the second event',
        sectionIndex: 0,
      })

      const { calls, service } = createHarness({
        state,
        sections: 2,
        messages: {
          'audit-1': [assistantMessage({ id: 'm-audit-1', text: 'Dirty.' })],
          'coder-1': [assistantMessage({ id: 'm-coder-1', text: 'Old reply' })],
        },
      })

      await recordAuditorHandoff(handler!.loop, 'audit-1')
      await idle('audit-1')
      expect(service.getActiveState(state.loopName)!.sessionId).toBe('coder-1')
      const createsAfterReuse = createCalls(calls).length

      // The reused coder session still lists its previous reply: this idle must
      // be answered with a handoff nudge instead of reading that reply as the
      // result of the new coding turn.
      await handler!.onEvent({
        event: { type: 'session.status', properties: { sessionID: 'coder-1', status: { type: 'busy' } } },
      })
      await idle('coder-1')

      expect(createCalls(calls)).toHaveLength(createsAfterReuse)
      const coderPrompts = promptsTo(calls, 'coder-1')
      expect(coderPrompts).toHaveLength(2)
      expect(coderPrompts[0]).toContain(FOLLOW_UP_MARKER)
      expect(coderPrompts[1]).toContain('You ended your turn without calling `loop-handoff`.')
      expect(promptsTo(calls, 'audit-1')).toHaveLength(0)
      const after = service.getActiveState(state.loopName)!
      expect(after.phase).toBe('coding')
      expect(after.sessionId).toBe('coder-1')
    })
  })
})
