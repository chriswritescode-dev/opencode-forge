import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopService } from '../../src/loop/service'
import { createLoop, __resetLoopRuntimeSharedState, type Loop } from '../../src/loop/runtime'
import type { LoopState } from '../../src/loop/state'
import { createLoopHandoffTools } from '../../src/tools/loop-handoff'
import type { ToolDefinition } from '../../src/tools/tool'
import { LOOP_COMPLETE_TOOL_NAME, LOOP_HANDOFF_TOOL_NAME } from '../../src/constants/loop'
import { coderHandoffSchema } from '../../src/loop/handoff'
import type { Logger, PluginConfig } from '../../src/types'
import { createFakeForgeClient } from '../helpers/fake-client'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { coderPayload, postActionPayload } from '../helpers/loop-handoff'

const PROJECT_ID = 'loop-handoff-project'
const LOOP_NAME = 'handoff-loop'
const CODER_SESSION = 'coder-session'
const AUDITOR_SESSION = 'auditor-session'
const POST_ACTION_SESSION = 'post-action-session'

const config: PluginConfig = {
  executionModel: 'test/model',
  auditorModel: 'test/auditor',
  loop: { enabled: true, model: 'test/loop', defaultMaxIterations: 5 },
}

const logger: Logger = { log: () => {}, error: () => {}, debug: () => {} }

describe('loop handoff tools', () => {
  let db: Database
  let tempDir: string
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let service: ReturnType<typeof createLoopService>
  let loop: Loop
  let tools: Record<string, ToolDefinition>
  let statuses: Record<string, { type?: string }>
  let statusError: Error | null
  let parentMap: Record<string, string | null>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-handoff-tool-test-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    __resetLoopRuntimeSharedState()

    loopsRepo = createLoopsRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    const plansRepo = createPlansRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    service = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, logger, undefined, undefined, sectionPlansRepo)

    statuses = {}
    statusError = null
    parentMap = {}

    const { client } = createFakeForgeClient({
      session: {
        status: (async () => {
          if (statusError) throw statusError
          return statuses
        }) as never,
      },
    })

    loop = createLoop({
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      sectionPlansRepo,
      projectId: PROJECT_ID,
      client,
      logger,
      getConfig: () => config,
      loopService: service,
      getParentSessionId: async (sessionId) => parentMap[sessionId] ?? null,
    })
    tools = createLoopHandoffTools({ loop } as never)
  })

  afterEach(() => {
    loop.clearAllRetryTimeouts()
    __resetLoopRuntimeSharedState()
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  function makeState(overrides: Partial<LoopState> = {}): LoopState {
    return {
      active: true,
      sessionId: CODER_SESSION,
      loopName: LOOP_NAME,
      worktreeDir: tempDir,
      projectDir: tempDir,
      worktreeBranch: 'test/handoff',
      iteration: 1,
      maxIterations: 5,
      startedAt: new Date().toISOString(),
      prompt: 'Implement the handoff phase',
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
      totalSections: 0,
      ...overrides,
    }
  }

  function startLoop(overrides: Partial<LoopState> = {}): LoopState {
    const state = makeState(overrides)
    service.setState(LOOP_NAME, state)
    return state
  }

  async function execute(toolName: string, args: Record<string, unknown>, sessionID: string) {
    const definition = tools[toolName]
    if (!definition) throw new Error(`missing tool ${toolName}`)
    const parsed = z.object(definition.args).safeParse(args)
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      throw new Error(`Invalid arguments for tool "${toolName}": ${details.join('; ')}`)
    }
    const result = await definition.execute(parsed.data as never, {
      sessionID,
      messageID: 'message-1',
      agent: 'code',
      signal: new AbortController().signal,
    })
    return JSON.parse(result)
  }

  function handoffs() {
    return service.listHandoffs(LOOP_NAME)
  }

  describe('session ownership', () => {
    test('rejects a non-loop session and writes no row', async () => {
      startLoop()
      const result = await execute(LOOP_HANDOFF_TOOL_NAME, coderPayload(), 'stranger-session')
      expect(result.error).toContain('Not the current session of an active loop')
      expect(handoffs()).toHaveLength(0)
    })

    test('rejects a subagent session of the loop and writes no row', async () => {
      startLoop()
      parentMap['child-session'] = CODER_SESSION
      const result = await execute(LOOP_HANDOFF_TOOL_NAME, coderPayload(), 'child-session')
      expect(result.error).toContain('Not the current session of an active loop')
      expect(handoffs()).toHaveLength(0)
    })

    test('rejects the standby session and writes no row', async () => {
      startLoop({ standbySessionId: 'standby-session' })
      const result = await execute(LOOP_HANDOFF_TOOL_NAME, coderPayload(), 'standby-session')
      expect(result.error).toContain('Not the current session of an active loop')
      expect(handoffs()).toHaveLength(0)
    })
  })

  describe('tool and phase pairing', () => {
    test('rejects loop-complete outside post-action', async () => {
      startLoop({ phase: 'coding' })
      const result = await execute(LOOP_COMPLETE_TOOL_NAME, postActionPayload(), CODER_SESSION)
      expect(result.error).toContain('loop-complete is only for the post-action session')
      expect(handoffs()).toHaveLength(0)
    })

    test('rejects loop-handoff in post-action', async () => {
      startLoop({ phase: 'post_action', sessionId: POST_ACTION_SESSION })
      const result = await execute(LOOP_HANDOFF_TOOL_NAME, coderPayload(), POST_ACTION_SESSION)
      expect(result.error).toContain('In post-action, call loop-complete instead')
      expect(handoffs()).toHaveLength(0)
    })
  })

  describe('subagent quiescence', () => {
    test('rejects a busy child session, names it, and writes no row', async () => {
      startLoop()
      parentMap['child-session'] = CODER_SESSION
      statuses['child-session'] = { type: 'busy' }

      const result = await execute(LOOP_HANDOFF_TOOL_NAME, coderPayload(), CODER_SESSION)

      expect(result.error).toContain('Wait for these subagent sessions to finish')
      expect(result.error).toContain('child-session')
      expect(handoffs()).toHaveLength(0)
    })

    test('rejects when the status query fails instead of treating the loop as quiescent', async () => {
      startLoop()
      statusError = new Error('status unavailable')

      const result = await execute(LOOP_HANDOFF_TOOL_NAME, coderPayload(), CODER_SESSION)

      expect(result.error).toContain('Could not check subagent sessions')
      expect(result.error).toContain('status unavailable')
      expect(handoffs()).toHaveLength(0)
    })

    test('ignores a busy current session and a busy standby session', async () => {
      startLoop({ standbySessionId: 'standby-session' })
      parentMap['standby-session'] = CODER_SESSION
      statuses[CODER_SESSION] = { type: 'busy' }
      statuses['standby-session'] = { type: 'busy' }

      const result = await execute(LOOP_HANDOFF_TOOL_NAME, coderPayload(), CODER_SESSION)

      expect(result.ok).toBe(true)
      expect(handoffs()).toHaveLength(1)
    })
  })

  describe('role schema validation', () => {
    test('returns the zod issue path for an invalid coder payload', async () => {
      startLoop()
      const result = await execute(
        LOOP_HANDOFF_TOOL_NAME,
        { verification: coderPayload().verification },
        CODER_SESSION,
      )
      expect(result.error).toContain('changes')
      expect(handoffs()).toHaveLength(0)
    })

    test('rejects an auditor-only field in a coder handoff through the strict schema', async () => {
      startLoop()
      const result = await execute(
        LOOP_HANDOFF_TOOL_NAME,
        { ...coderPayload(), summary: { done: ['did it'] } },
        CODER_SESSION,
      )
      expect(result.error).toContain('summary')
      expect(handoffs()).toHaveLength(0)
    })

    test('rejects a coder-only field in an auditor handoff through the strict schema', async () => {
      startLoop({ phase: 'auditing', sessionId: AUDITOR_SESSION })
      const result = await execute(LOOP_HANDOFF_TOOL_NAME, coderPayload(), AUDITOR_SESSION)
      expect(result.error).toContain('changes')
      expect(handoffs()).toHaveLength(0)
    })

    test('rejects loop-complete without steps at the tool boundary', async () => {
      startLoop({ phase: 'post_action', sessionId: POST_ACTION_SESSION })
      await expect(execute(
        LOOP_COMPLETE_TOOL_NAME,
        { outcome: 'completed', followUps: [] },
        POST_ACTION_SESSION,
      )).rejects.toThrow(/steps/)
      expect(handoffs()).toHaveLength(0)
    })
  })

  describe('audit summary rules', () => {
    test('rejects a clean sectioned audit without a summary', async () => {
      startLoop({ phase: 'auditing', sessionId: AUDITOR_SESSION, totalSections: 1, currentSectionIndex: 0 })
      const result = await execute(LOOP_HANDOFF_TOOL_NAME, {}, AUDITOR_SESSION)
      expect(result.error).toContain('This section has no blocking bug findings')
      expect(handoffs()).toHaveLength(0)
    })

    test('rejects a summary while blocking bug findings remain open', async () => {
      startLoop({ phase: 'auditing', sessionId: AUDITOR_SESSION, totalSections: 1, currentSectionIndex: 0 })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: LOOP_NAME,
        file: 'src/handoff.ts',
        line: 10,
        severity: 'bug',
        description: 'The handoff row is never applied',
        sectionIndex: 0,
      })

      const result = await execute(
        LOOP_HANDOFF_TOOL_NAME,
        { summary: { done: ['wrote the writer'] } },
        AUDITOR_SESSION,
      )
      expect(result.error).toContain('blocking bug finding')
      expect(result.error).toContain('omit summary')
      expect(handoffs()).toHaveLength(0)
    })

    test('rejects a summary for a non-sectioned audit', async () => {
      startLoop({ phase: 'auditing', sessionId: AUDITOR_SESSION })
      const result = await execute(
        LOOP_HANDOFF_TOOL_NAME,
        { summary: { done: ['wrote the writer'] } },
        AUDITOR_SESSION,
      )
      expect(result.error).toContain('summary applies only to section audits')
      expect(handoffs()).toHaveLength(0)
    })

    test('accepts a clean sectioned audit with a summary', async () => {
      startLoop({ phase: 'auditing', sessionId: AUDITOR_SESSION, totalSections: 2, currentSectionIndex: 1 })
      const result = await execute(
        LOOP_HANDOFF_TOOL_NAME,
        { summary: { done: ['wrote the writer'], followUps: ['add a regression test'] } },
        AUDITOR_SESSION,
      )
      expect(result.ok).toBe(true)

      const [record] = handoffs()
      expect(record.role).toBe('auditor')
      expect(record.phase).toBe('auditing')
      expect(record.sectionIndex).toBe(1)
      expect(record.payload).toEqual({
        summary: { done: ['wrote the writer'], deviations: [], followUps: ['add a regression test'] },
      })
      expect(record.payload).not.toHaveProperty('deviations')
    })

    test('accepts a dirty sectioned audit without a summary through the tool argument parse', async () => {
      startLoop({ phase: 'auditing', sessionId: AUDITOR_SESSION, totalSections: 1, currentSectionIndex: 0 })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: LOOP_NAME,
        file: 'src/handoff.ts',
        line: 11,
        severity: 'bug',
        description: 'The handoff row is never applied',
        sectionIndex: 0,
      })

      const result = await execute(LOOP_HANDOFF_TOOL_NAME, {}, AUDITOR_SESSION)

      expect(result.ok).toBe(true)
      const [record] = handoffs()
      expect(record.payload).toEqual({})
      expect(record.payload).not.toHaveProperty('deviations')
    })
  })

  describe('recording', () => {
    test('writes the schema-parsed coder payload with defaults applied', async () => {
      startLoop({ totalSections: 2, currentSectionIndex: 1 })
      const args = {
        changes: [{ summary: 'Added the handoff writer', reason: 'phase protocol' }],
        verification: [{ command: 'pnpm typecheck', cwd: 'root', outcome: 'pass', changedAfter: false }],
      }

      const result = await execute(LOOP_HANDOFF_TOOL_NAME, args, CODER_SESSION)

      expect(result.ok).toBe(true)
      expect(result.message).toContain('Handoff recorded')
      const [record] = handoffs()
      expect(record.role).toBe('coder')
      expect(record.phase).toBe('coding')
      expect(record.sectionIndex).toBe(1)
      expect(record.iteration).toBe(1)
      expect(record.payload).toEqual(coderHandoffSchema.parse(args))
      expect(record.payload.deviations).toEqual([])
    })

    test('replaces the pending handoff on a second call and says so', async () => {
      startLoop()
      await execute(LOOP_HANDOFF_TOOL_NAME, coderPayload(), CODER_SESSION)

      const replacement = coderPayload({
        changes: [{ summary: 'Replaced the approach', reason: 'the first one failed validation' }],
      })
      const result = await execute(LOOP_HANDOFF_TOOL_NAME, replacement, CODER_SESSION)

      expect(result.ok).toBe(true)
      expect(result.message).toContain('It replaced your earlier handoff from this turn.')
      expect(handoffs()).toHaveLength(1)
      expect(handoffs()[0].payload).toEqual(coderHandoffSchema.parse(replacement))
    })

    test('records a post-action completion with defaults applied', async () => {
      startLoop({ phase: 'post_action', sessionId: POST_ACTION_SESSION })
      const args = { outcome: 'completed_with_issues', steps: [{ name: 'merge', status: 'skipped' }] }

      const result = await execute(LOOP_COMPLETE_TOOL_NAME, args, POST_ACTION_SESSION)

      expect(result.ok).toBe(true)
      const [record] = handoffs()
      expect(record.role).toBe('post_action')
      expect(record.phase).toBe('post_action')
      expect(record.sectionIndex).toBeNull()
      expect(record.payload).toEqual({ ...args, followUps: [] })
    })
  })
})
