import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { __resetLoopRuntimeSharedState, type Loop } from '../../src/loop/runtime'
import type { LoopState } from '../../src/loop/state'
import { createLoopHandoffTools } from '../../src/tools/loop-handoff'
import type { ToolDefinition } from '../../src/tools/tool'
import { LOOP_COMPLETE_TOOL_NAME, LOOP_HANDOFF_TOOL_NAME } from '../../src/constants/loop'
import { coderHandoffSchema } from '../../src/loop/handoff'
import type { PluginConfig } from '../../src/types'
import { createFakeForgeClient } from '../helpers/fake-client'
import { buildLoopRuntime, makeLoopState } from '../helpers/loop-fixtures'
import { createTestDb } from '../helpers/test-db'
import { coderPayload, postActionPayload } from '../helpers/loop-handoff'

const PROJECT_ID = 'loop-handoff-project'
const LOOP_NAME = 'handoff-loop'
const CODER_SESSION = 'coder-session'
const AUDITOR_SESSION = 'auditor-session'
const POST_ACTION_SESSION = 'post-action-session'

const config: PluginConfig = {
  executionModel: 'test/model',
  auditorModel: 'test/auditor',
  loop: { enabled: true, defaultMaxIterations: 5 },
}

describe('loop handoff tools', () => {
  let testDb: ReturnType<typeof createTestDb>
  let db: ReturnType<typeof createTestDb>['db']
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let service: ReturnType<typeof buildLoopRuntime>['loopService']
  let loop: Loop
  let tools: Record<string, ToolDefinition>
  let statuses: Record<string, { type?: string }>
  let statusError: Error | null
  let statusHook: (() => void) | null
  let parentMap: Record<string, string | null>

  beforeEach(() => {
    testDb = createTestDb()
    db = testDb.db
    __resetLoopRuntimeSharedState()

    reviewFindingsRepo = createReviewFindingsRepo(db)

    statuses = {}
    statusError = null
    statusHook = null
    parentMap = {}

    const { client } = createFakeForgeClient({
      session: {
        status: (async () => {
          statusHook?.()
          if (statusError) throw statusError
          return statuses
        }) as never,
      },
    })

    const runtime = buildLoopRuntime(db, {
      projectId: PROJECT_ID,
      client,
      config,
      getParentSessionId: async (sessionId) => parentMap[sessionId] ?? null,
    })
    loop = runtime.loop
    service = runtime.loopService
    tools = createLoopHandoffTools({ loop } as never)
  })

  afterEach(() => {
    loop.clearAllRetryTimeouts()
    __resetLoopRuntimeSharedState()
    testDb.cleanup()
  })

  function startLoop(overrides: Partial<LoopState> = {}): LoopState {
    const state = makeLoopState({ loopName: LOOP_NAME, sessionId: CODER_SESSION, ...overrides })
    service.setState(LOOP_NAME, state)
    return state
  }

  async function execute(
    toolName: string,
    args: Record<string, unknown>,
    sessionID: string,
    signal = new AbortController().signal,
  ) {
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
      signal,
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
      if (record.role !== 'coder') throw new Error('expected coder handoff')
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

    test('writes no handoff when the tool call is aborted while the subagent check is in flight', async () => {
      startLoop()
      const controller = new AbortController()
      statusHook = () => controller.abort()

      const result = await execute(LOOP_HANDOFF_TOOL_NAME, coderPayload(), CODER_SESSION, controller.signal)

      expect(result.error).toContain('aborted')
      expect(handoffs()).toHaveLength(0)
    })
  })
})
