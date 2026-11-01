import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { LoopState } from '../../src/loop/state'
import { __resetLoopRuntimeSharedState, type Loop } from '../../src/loop/runtime'
import { recordInboxEnqueued, recordInboxSettled, __resetIdleGate } from '../../src/loop/idle-gate'
import {
  markPromptInFlight,
  getPromptInFlight,
  __resetInFlightGuard,
} from '../../src/loop/in-flight-guard'
import type { PluginConfig, LoopConfig } from '../../src/types'
import { createFakeForgeClient, type RecordedCall } from '../helpers/fake-client'
import type { ForgeClient } from '../../src/client/port'
import { createTestDb } from '../helpers/test-db'
import { makeLoopState, buildLoopRuntime } from '../helpers/loop-fixtures'
import { recordAuditorHandoff, recordCoderHandoff, recordPostActionComplete } from '../helpers/loop-handoff'
import { formatAuditHandoffResult, formatPostActionReport, formatPostActionSummary } from '../../src/loop/handoff'
import { buildHandoffNudgePrompt } from '../../src/loop/prompts'
import { LOOP_HANDOFF_TOOL_NAME } from '../../src/constants/loop'

const PROJECT_ID = 'test-project'

const mockConfig: PluginConfig = {
  executionModel: 'test/model',
  auditorModel: 'test/auditor',
  loop: {
    enabled: true,
    defaultMaxIterations: 5,
  },
}

describe('Loop Runtime', () => {
  let db: ReturnType<typeof createTestDb>['db']
  let testDb: ReturnType<typeof createTestDb>
  type Runtime = ReturnType<typeof buildLoopRuntime>
  let loopService: Runtime['loopService']
  let tempDir: string
  let reviewFindingsRepo: Runtime['reviewFindingsRepo']
  let sectionPlansRepo: Runtime['sectionPlansRepo']
  let loopSessionUsageRepo: Runtime['loopSessionUsageRepo']
  let loopTransitionsRepo: Runtime['loopTransitionsRepo']
  let currentLoop: Loop | null = null

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-runtime-test-'))
    testDb = createTestDb({ path: join(tempDir, 'forge.db') })
    db = testDb.db

    __resetIdleGate()
    __resetInFlightGuard()
    __resetLoopRuntimeSharedState()
  })

  afterEach(() => {
    if (currentLoop) {
      currentLoop.clearAllRetryTimeouts()
      currentLoop = null
    }
    testDb.cleanup()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
    __resetIdleGate()
    vi.useRealTimers()
  })

  const buildRuntime = (
    overrides: {
      client?: ForgeClient
      loopConfig?: Partial<PluginConfig>
      stallConfig?: LoopConfig
      withUsageRepo?: boolean
      getParentSessionId?: (sessionId: string) => Promise<string | null>
    } = {},
  ) => {
    const runtime = buildLoopRuntime(db, {
      projectId: PROJECT_ID,
      client: overrides.client,
      config: { ...mockConfig, ...(overrides.loopConfig ?? {}) },
      loopConfig: overrides.stallConfig,
      dataDir: tempDir,
      withUsageRepo: overrides.withUsageRepo,
      getParentSessionId: overrides.getParentSessionId,
    })

    loopService = runtime.loopService
    reviewFindingsRepo = runtime.reviewFindingsRepo
    sectionPlansRepo = runtime.sectionPlansRepo
    loopSessionUsageRepo = runtime.loopSessionUsageRepo
    loopTransitionsRepo = runtime.loopTransitionsRepo
    currentLoop = runtime.loop
    return runtime
  }

  describe('idle coding session advances to auditing', () => {
    test('idle event on a coding phase transitions to auditing phase', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await recordCoderHandoff(loop, state.sessionId)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      const updatedState = loopService.getActiveState(state.loopName)
      expect(updatedState).not.toBeNull()
      expect(updatedState!.phase).toBe('auditing')
    })

    test('does not transition to auditing when latest coding message is still user prompt', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Older code response.' }] },
            { info: { role: 'user' }, parts: [{ type: 'text', text: 'Latest code prompt that was not answered.' }] },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      const updatedState = loopService.getActiveState(state.loopName)
      expect(updatedState).not.toBeNull()
      expect(updatedState!.phase).toBe('coding')

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls.length).toBe(0)

      const codeCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
      expect(codeCalls.length).toBe(1)
      const nudgeText = ((codeCalls[0].params as any)?.parts as Array<{ text: string }>)
        .map(part => part.text)
        .join('\n')
      expect(nudgeText).toContain('Loop iteration')
    })
  })

  describe('clean non-sectioned audit terminates completed', () => {
    test('audit session returning clean assistant message terminates with completed', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear. No issues found.' }] },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 3,
      })
      loopService.setState(state.loopName, state)

      await recordAuditorHandoff(loop, state.sessionId)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      // After processing a clean audit result, the loop should terminate with completed
      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.terminationReason).toBe('completed')
    })
  })

  describe('auditor handoff', () => {
    function seedBugFinding(loopName: string): void {
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/handoff.ts',
        line: 1,
        severity: 'bug',
        description: 'Outstanding handoff bug',
      })
    }

    test('a clean auditor handoff sets lastAuditResult from the payload and stays applied', async () => {
      const { client } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 3,
      })
      loopService.setState(state.loopName, state)

      const payload = { notes: 'No outstanding findings.' }
      await recordAuditorHandoff(loop, state.sessionId, payload)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      const afterState = loopService.getAnyState(state.loopName)!
      expect(afterState.terminationReason).toBe('completed')
      expect(afterState.lastAuditResult).toBe(formatAuditHandoffResult(payload, {
        clean: true,
        blockingBugs: 0,
        sectionIndex: null,
      }))

      const handoffs = loopService.listHandoffs(state.loopName)
      expect(handoffs).toHaveLength(1)
      expect(handoffs[0]).toMatchObject({ role: 'auditor', sessionId: state.sessionId, status: 'applied' })
    })

    test('an aborted audit session with a pending handoff is processed and applies the handoff', async () => {
      const { client } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 3,
      })
      loopService.setState(state.loopName, state)
      seedBugFinding(state.loopName)

      await recordAuditorHandoff(loop, state.sessionId)

      await loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'AbortError' } },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('coding')

      const handoffs = loopService.listHandoffs(state.loopName)
      expect(handoffs).toHaveLength(1)
      expect(handoffs[0]).toMatchObject({ role: 'auditor', sessionId: state.sessionId, status: 'applied' })

      const rows = loopTransitionsRepo.listForLoop(PROJECT_ID, state.loopName)
      expect(rows.some(r => r.eventType === 'audit-session-aborted')).toBe(false)
    })

    test('an audit session whose assistant message is aborted but carries a pending handoff applies the handoff', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop', error: { name: 'MessageAbortedError' } }, parts: [] },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 3,
      })
      loopService.setState(state.loopName, state)
      seedBugFinding(state.loopName)

      await recordAuditorHandoff(loop, state.sessionId)

      await loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'AbortError' } },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('coding')
      expect(afterState!.lastAuditResult).toBe(formatAuditHandoffResult({}, {
        clean: false,
        blockingBugs: 1,
        sectionIndex: null,
      }))

      const handoffs = loopService.listHandoffs(state.loopName)
      expect(handoffs).toHaveLength(1)
      expect(handoffs[0]).toMatchObject({ role: 'auditor', sessionId: state.sessionId, status: 'applied' })

      const rows = loopTransitionsRepo.listForLoop(PROJECT_ID, state.loopName)
      expect(rows.some(r => r.eventType === 'audit-error')).toBe(false)
      expect(rows.some(r => r.eventType === 'auditor-handoff')).toBe(true)
    })

    test('an aborted audit session without a pending handoff rotates to coding and records audit-session-aborted', async () => {
      const { client } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 3,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'AbortError' } },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('coding')

      const rows = loopTransitionsRepo.listForLoop(PROJECT_ID, state.loopName)
      expect(rows.some(r => r.eventType === 'audit-session-aborted' && r.toPhase === 'coding')).toBe(true)
      expect(loopService.listHandoffs(state.loopName)).toHaveLength(0)
    })
  })

describe('post-action phase', () => {
  test('postAction enabled with skill → enters post_action phase on clean audit and completes on post-action idle', async () => {
    const { client, calls } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear. No issues found.' }] },
        ],
      },
    })
    const { loop } = buildRuntime({
      client,
      loopConfig: {
        loop: {
          enabled: true,
          defaultMaxIterations: 5,
          postAction: { enabled: true, skill: 'pr-review' },
        },
      },
    })

    const state = makeLoopState({
      phase: 'auditing',
      totalSections: 0,
      auditCount: 0,
      iteration: 1,
      maxIterations: 3,
    })
    loopService.setState(state.loopName, state)

    await recordAuditorHandoff(loop, state.sessionId)

    // First tick: clean audit → checkAuditClearAndTerminate → enterPostActionPhase
    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: state.sessionId,
      },
    })

    // Assert loop is still active and in post_action phase
    const afterState = loopService.getAnyState(state.loopName)
    expect(afterState).not.toBeNull()
    expect(afterState!.active).toBe(true)
    expect(afterState!.phase).toBe('post_action')
    expect(afterState!.sessionId).not.toBe(state.sessionId)

    // Assert a code prompt was sent containing the skill name
    const codeCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
    expect(codeCalls.length).toBeGreaterThan(0)
    // The last code prompt should be the post-action prompt
    const lastCodePrompt = codeCalls[codeCalls.length - 1]?.params as any
    const promptText = lastCodePrompt?.parts?.[0]?.text ?? ''
    expect(promptText).toContain('pr-review')
    expect(promptText).toContain('loop-complete')

    // Simulate the post_action session completing through loop-complete.
    const postActionSessionId = afterState!.sessionId
    const payload = {
      outcome: 'completed' as const,
      steps: [{ name: 'Post-action workflow', status: 'done' as const }],
      followUps: [],
    }
    await recordPostActionComplete(loop, postActionSessionId)

    // Send busy to clear the idle-gate (prompt was marked as sent)
    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'busy' },
        sessionID: postActionSessionId,
      },
    })

    // Send idle to trigger runPostActionPhase
    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: postActionSessionId,
      },
    })

    // Assert loop terminated with completed and rendered the handoff payload.
    const finalState = loopService.getAnyState(state.loopName)
    expect(finalState).not.toBeNull()
    expect(finalState!.active).toBe(false)
    expect(finalState!.terminationReason).toBe('completed')
    expect(finalState!.completionSummary).toBe(formatPostActionSummary(payload))
    expect(finalState!.postActionReport).toBe(formatPostActionReport(payload))
  })

  test('postAction disabled → terminates completed immediately (unchanged behavior)', async () => {
    const { client } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear. No issues found.' }] },
        ],
      },
    })
    const { loop } = buildRuntime({ client })
    // Default config has no postAction — verifies no regression

    const state = makeLoopState({
      phase: 'auditing',
      totalSections: 0,
      auditCount: 0,
      iteration: 1,
      maxIterations: 3,
    })
    loopService.setState(state.loopName, state)

    await recordAuditorHandoff(loop, state.sessionId)

    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: state.sessionId,
      },
    })

    const afterState = loopService.getAnyState(state.loopName)
    expect(afterState).not.toBeNull()
    expect(afterState!.active).toBe(false)
    expect(afterState!.terminationReason).toBe('completed')
  })

  describe('sectioned loop completion (last open section)', () => {
    const auditReplyText = 'Section audit complete.'
    const cleanSectionHandoff = { summary: { done: ['Implemented the section'], deviations: [], followUps: [] } }

    function seedSections(loopName: string, statuses: Array<'pending' | 'in_progress' | 'completed'>) {
      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName,
        sections: statuses.map((_, index) => ({ index, title: `Section ${index + 1}`, content: `Content ${index + 1}` })),
      })
      statuses.forEach((status, index) => {
        sectionPlansRepo.setStatus(PROJECT_ID, loopName, index, status)
        if (status === 'completed') {
          sectionPlansRepo.setSummary(PROJECT_ID, loopName, index, { done: 'done', deviations: 'none', followUps: 'none' })
          sectionPlansRepo.setCompletedAt(PROJECT_ID, loopName, index, Date.now())
        }
      })
    }

    function seedFinding(loopName: string, file: string, line: number, sectionIndex: number | null) {
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file,
        line,
        severity: 'bug',
        description: `Outstanding bug at ${file}:${line}`,
        sectionIndex,
      })
    }

    function seedAuditingLoop(loopName: string, sessionId: string, totalSections: number, currentSectionIndex: number) {
      const state = makeLoopState({
        loopName,
        sessionId,
        phase: 'auditing',
        totalSections,
        currentSectionIndex,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
      })
      loopService.setState(loopName, state)
      loopService.registerLoopSession(sessionId, loopName)
      return state
    }

    function auditTick(loop: Loop, sessionId: string) {
      return loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID: sessionId } })
    }

    function codePrompts(calls: RecordedCall[]): string[] {
      return calls
        .filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
        .map(c => (c.params as any)?.parts?.[0]?.text ?? '')
    }

    test('clean last open section enters post_action when configured', async () => {
      const { client, calls } = createFakeForgeClient({
        session: { messages: async () => [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: auditReplyText }] }] },
      })
      const { loop } = buildRuntime({
        client,
        loopConfig: { loop: { enabled: true, defaultMaxIterations: 5, postAction: { enabled: true, skill: 'pr-review' } } },
      })

      const loopName = 'last-open-post-action'
      seedAuditingLoop(loopName, 'last-open-audit', 2, 1)
      seedSections(loopName, ['completed', 'in_progress'])

      await recordAuditorHandoff(loop, 'last-open-audit', cleanSectionHandoff)

      await auditTick(loop, 'last-open-audit')

      const afterState = loopService.getActiveState(loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.phase).toBe('post_action')
      expect(afterState!.active).toBe(true)
      expect(sectionPlansRepo.get(PROJECT_ID, loopName, 1)!.status).toBe('completed')
      expect(codePrompts(calls).some(text => text.includes('pr-review'))).toBe(true)

      // Record the post_action entry row from the auditor handoff verdict.
      const rows = loopTransitionsRepo.listForLoop(PROJECT_ID, loopName)
      expect(rows.some(r => r.eventType === 'auditor-handoff' && r.toPhase === 'post_action')).toBe(true)

      const postActionSessionId = afterState!.sessionId
      await recordPostActionComplete(loop, postActionSessionId)
      await loop.tick({ type: 'session.status', properties: { status: { type: 'busy' }, sessionID: postActionSessionId } })
      await loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID: postActionSessionId } })
      expect(loopService.getAnyState(loopName)!.terminationReason).toBe('completed')
    })

    test('clean last open section terminates completed without post_action', async () => {
      const { client } = createFakeForgeClient({
        session: { messages: async () => [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: auditReplyText }] }] },
      })
      const { loop } = buildRuntime({ client })

      const loopName = 'last-open-terminate'
      seedAuditingLoop(loopName, 'last-open-audit', 2, 1)
      seedSections(loopName, ['completed', 'in_progress'])

      await recordAuditorHandoff(loop, 'last-open-audit', cleanSectionHandoff)

      await auditTick(loop, 'last-open-audit')

      const afterState = loopService.getAnyState(loopName)!
      expect(afterState.active).toBe(false)
      expect(afterState.terminationReason).toBe('completed')
      expect(afterState.phase).toBe('auditing')
      expect(sectionPlansRepo.get(PROJECT_ID, loopName, 1)!.status).toBe('completed')
    })

    test('clean last open section with an earlier-section bug retries the same section and inlines that finding', async () => {
      const { client, calls } = createFakeForgeClient({
        session: { messages: async () => [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: auditReplyText }] }] },
      })
      const { loop } = buildRuntime({ client })

      const loopName = 'last-open-earlier-bug'
      seedAuditingLoop(loopName, 'last-open-audit', 2, 1)
      seedSections(loopName, ['completed', 'in_progress'])
      seedFinding(loopName, 'src/earlier.ts', 7, 0)

      await recordAuditorHandoff(loop, 'last-open-audit')

      await auditTick(loop, 'last-open-audit')

      const afterState = loopService.getActiveState(loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('coding')
      expect(afterState!.currentSectionIndex).toBe(1)
      const prompt = codePrompts(calls).at(-1) ?? ''
      expect(prompt).toContain('src/earlier.ts:7')
      expect(prompt).toContain('Outstanding bug at src/earlier.ts:7')
    })

    test('clean last open section with a cross-section bug retries the same section and inlines that finding', async () => {
      const { client, calls } = createFakeForgeClient({
        session: { messages: async () => [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: auditReplyText }] }] },
      })
      const { loop } = buildRuntime({ client })

      const loopName = 'last-open-cross-bug'
      seedAuditingLoop(loopName, 'last-open-audit', 2, 1)
      seedSections(loopName, ['completed', 'in_progress'])
      seedFinding(loopName, 'src/cross.ts', 11, null)

      await recordAuditorHandoff(loop, 'last-open-audit')

      await auditTick(loop, 'last-open-audit')

      const afterState = loopService.getActiveState(loopName)
      expect(afterState!.phase).toBe('coding')
      expect(afterState!.currentSectionIndex).toBe(1)
      expect(codePrompts(calls).at(-1)).toContain('src/cross.ts:11')
    })

    test('a bug attributed to a later section does not block an earlier section', async () => {
      const { client, calls } = createFakeForgeClient({
        session: { messages: async () => [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: auditReplyText }] }] },
      })
      const { loop } = buildRuntime({ client })

      const loopName = 'non-last-section'
      seedAuditingLoop(loopName, 'first-section-audit', 2, 0)
      seedSections(loopName, ['in_progress', 'pending'])
      seedFinding(loopName, 'src/later.ts', 9, 1)

      await recordAuditorHandoff(loop, 'first-section-audit', cleanSectionHandoff)

      await auditTick(loop, 'first-section-audit')

      const afterState = loopService.getActiveState(loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.phase).toBe('coding')
      expect(afterState!.currentSectionIndex).toBe(1)
      expect(sectionPlansRepo.get(PROJECT_ID, loopName, 0)!.status).toBe('completed')
      expect(codePrompts(calls).at(-1)).not.toContain('src/later.ts:9')
    })

    test('a non-last section retries when an earlier section still has a blocking bug', async () => {
      const { client, calls } = createFakeForgeClient({
        session: { messages: async () => [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: auditReplyText }] }] },
      })
      const { loop } = buildRuntime({ client })

      const loopName = 'non-last-earlier-bug'
      seedAuditingLoop(loopName, 'second-section-audit', 3, 1)
      seedSections(loopName, ['completed', 'in_progress', 'pending'])
      seedFinding(loopName, 'src/earlier.ts', 5, 0)

      await recordAuditorHandoff(loop, 'second-section-audit')

      await auditTick(loop, 'second-section-audit')

      const afterState = loopService.getActiveState(loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('coding')
      expect(afterState!.currentSectionIndex).toBe(1)
      expect(codePrompts(calls).at(-1)).toContain('src/earlier.ts:5')
    })

    test('a clean last-index section advances to an earlier section left open by a rewind', async () => {
      const { client } = createFakeForgeClient({
        session: { messages: async () => [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: auditReplyText }] }] },
      })
      const { loop } = buildRuntime({ client })

      const loopName = 'rewind-earlier-open'
      seedAuditingLoop(loopName, 'rewind-audit', 3, 2)
      seedSections(loopName, ['in_progress', 'completed', 'in_progress'])

      await recordAuditorHandoff(loop, 'rewind-audit', cleanSectionHandoff)

      await auditTick(loop, 'rewind-audit')

      const afterState = loopService.getActiveState(loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('coding')
      // Advances to the lowest section that is still open, not idx + 1 and not completion.
      expect(afterState!.currentSectionIndex).toBe(0)
      expect(sectionPlansRepo.get(PROJECT_ID, loopName, 2)!.status).toBe('completed')
      expect(sectionPlansRepo.get(PROJECT_ID, loopName, 0)!.status).toBe('in_progress')
    })

    test('rewind: all other sections completed makes an earlier index the last open section', async () => {
      const { client } = createFakeForgeClient({
        session: { messages: async () => [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: auditReplyText }] }] },
      })
      const { loop } = buildRuntime({ client })

      const loopName = 'rewind-last-open'
      seedAuditingLoop(loopName, 'rewind-audit', 3, 0)
      seedSections(loopName, ['in_progress', 'completed', 'completed'])

      await recordAuditorHandoff(loop, 'rewind-audit', cleanSectionHandoff)

      await auditTick(loop, 'rewind-audit')

      const afterState = loopService.getAnyState(loopName)!
      expect(afterState.active).toBe(false)
      expect(afterState.terminationReason).toBe('completed')
      expect(sectionPlansRepo.get(PROJECT_ID, loopName, 0)!.status).toBe('completed')
    })
  })

  test('postAction enabled with prompt only → enters post_action phase and sends prompt text', async () => {
    const { client, calls } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear. No issues found.' }] },
        ],
      },
    })
    const { loop } = buildRuntime({
      client,
      loopConfig: {
        loop: {
          enabled: true,
          defaultMaxIterations: 5,
          postAction: {
            enabled: true,
            prompt: 'Run a lightweight post-action smoke review.',
          },
        },
      },
    })

    const state = makeLoopState({
      phase: 'auditing',
      totalSections: 0,
      auditCount: 0,
      iteration: 1,
      maxIterations: 3,
    })
    loopService.setState(state.loopName, state)

    await recordAuditorHandoff(loop, state.sessionId)

    // First tick: clean audit → checkAuditClearAndTerminate → enterPostActionPhase
    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: state.sessionId,
      },
    })

    // Assert loop is still active and in post_action phase
    const afterState = loopService.getAnyState(state.loopName)
    expect(afterState).not.toBeNull()
    expect(afterState!.active).toBe(true)
    expect(afterState!.phase).toBe('post_action')
    expect(afterState!.sessionId).not.toBe(state.sessionId)

    // Assert a code prompt was sent containing the configured prompt text
    const codeCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
    expect(codeCalls.length).toBeGreaterThan(0)
    const lastCodePrompt = codeCalls[codeCalls.length - 1]?.params as any
    const promptText = lastCodePrompt?.parts?.[0]?.text ?? ''
    expect(promptText).toContain('Run a lightweight post-action smoke review')
    // No skill configured → no Load the / Skill tool instructions
    expect(promptText).not.toContain('Load the')
    expect(promptText).not.toContain('Skill tool')

    // Simulate the post_action session completing through loop-complete.
    const postActionSessionId = afterState!.sessionId
    await recordPostActionComplete(loop, postActionSessionId)

    // Send busy to clear idle-gate
    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'busy' },
        sessionID: postActionSessionId,
      },
    })

    // Send idle to trigger runPostActionPhase
    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: postActionSessionId,
      },
    })

    // Assert loop terminated with completed
    const finalState = loopService.getAnyState(state.loopName)
    expect(finalState).not.toBeNull()
    expect(finalState!.active).toBe(false)
    expect(finalState!.terminationReason).toBe('completed')
  })

  test('postAction prompt send failure → terminates completed as best effort', async () => {
    const { client, calls } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear. No issues found.' }] },
        ],
        promptAsync: async () => { throw new Error('prompt failed') },
      },
    })
    const { loop } = buildRuntime({
      client,
      loopConfig: {
        loop: {
          enabled: true,
          defaultMaxIterations: 5,
          postAction: { enabled: true, skill: 'pr-review' },
        },
      },
    })

    const state = makeLoopState({
      phase: 'auditing',
      totalSections: 0,
      auditCount: 0,
      iteration: 1,
      maxIterations: 3,
    })
    loopService.setState(state.loopName, state)

    await recordAuditorHandoff(loop, state.sessionId)

    // Tick: clean audit → enterPostActionPhase → promptAsync throws
    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: state.sessionId,
      },
    })

    // session.create was called for the post-action session (in addition to any prior creates)
    const createCalls = calls.filter(c => c.method === 'session.create')
    expect(createCalls.length).toBeGreaterThan(0)

    // Loop terminated with completed despite the prompt failure
    const finalState = loopService.getAnyState(state.loopName)
    expect(finalState).not.toBeNull()
    expect(finalState!.active).toBe(false)
    expect(finalState!.terminationReason).toBe('completed')
  })

  test('post_action idle with missing worktreeDir → terminates missing_worktree_dir', async () => {
    const { client } = createFakeForgeClient()
    const { loop } = buildRuntime({ client })

    const state = makeLoopState({
      phase: 'post_action',
      worktreeDir: '',
    })
    loopService.setState(state.loopName, state)
    loopService.registerLoopSession(state.sessionId, state.loopName)

    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: state.sessionId,
      },
    })

    const finalState = loopService.getAnyState(state.loopName)
    expect(finalState).not.toBeNull()
    expect(finalState!.active).toBe(false)
    expect(finalState!.terminationReason).toBe('missing_worktree_dir')
  })

  test('post_action idle without loop-complete → nudges, then completes once the handoff is recorded', async () => {
    const { client, calls } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'When the reviewers report back I will merge everything.' }] },
        ],
      },
    })
    const { loop } = buildRuntime({ client })
    const state = makeLoopState({ phase: 'post_action' })
    loopService.setState(state.loopName, state)
    loopService.registerLoopSession(state.sessionId, state.loopName)

    await loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID: state.sessionId } })

    const continued = loopService.getAnyState(state.loopName)!
    expect(continued.active).toBe(true)
    expect(continued.phase).toBe('post_action')
    const continuePrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.sessionID === state.sessionId)
    expect(continuePrompts).toHaveLength(1)
    expect((continuePrompts[0]!.params as any).parts[0].text).toContain('You ended your turn without calling `loop-complete`')

    const payload = {
      outcome: 'completed' as const,
      steps: [{ name: 'merge reviewer findings', status: 'done' as const }],
      followUps: [],
    }
    await recordPostActionComplete(loop, state.sessionId, payload)
    await loop.tick({ type: 'session.status', properties: { status: { type: 'busy' }, sessionID: state.sessionId } })
    await loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID: state.sessionId } })

    const finalState = loopService.getAnyState(state.loopName)!
    expect(finalState.active).toBe(false)
    expect(finalState.terminationReason).toBe('completed')
    expect(finalState.completionSummary).toBe(formatPostActionSummary(payload))
    expect(finalState.postActionReport).toBe(formatPostActionReport(payload))
  })

  test('post_action without loop-complete → stops nudging after the cap and completes best effort', async () => {
    const { client, calls } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'still waiting' }] },
        ],
      },
    })
    const { loop } = buildRuntime({ client })
    const state = makeLoopState({ phase: 'post_action' })
    loopService.setState(state.loopName, state)
    loopService.registerLoopSession(state.sessionId, state.loopName)

    for (let i = 0; i < 4; i++) {
      await loop.tick({ type: 'session.status', properties: { status: { type: 'busy' }, sessionID: state.sessionId } })
      await loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID: state.sessionId } })
    }

    const nudges = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.sessionID === state.sessionId)
    expect(nudges).toHaveLength(3)
    for (const nudge of nudges) {
      expect((nudge.params as any).parts[0].text).toContain('You ended your turn without calling `loop-complete`')
    }
    const finalState = loopService.getAnyState(state.loopName)!
    expect(finalState.active).toBe(false)
    expect(finalState.terminationReason).toBe('completed')
  })

  test('handoff nudges spent by the auditor do not reduce the coder budget after an audit error rotation', async () => {
    const { client, calls } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'nothing to report' }] },
        ],
      },
    })
    const { loop } = buildRuntime({ client })

    const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 1, iteration: 1, maxIterations: 5 })
    loopService.setState(state.loopName, state)
    loopService.registerLoopSession(state.sessionId, state.loopName)

    const runTurn = async (sessionID: string): Promise<void> => {
      await loop.tick({ type: 'session.status', properties: { status: { type: 'busy' }, sessionID } })
      await loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID } })
    }

    await runTurn(state.sessionId)
    await runTurn(state.sessionId)

    const auditorNudges = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
    expect(auditorNudges).toHaveLength(2)

    await loop.tick({
      type: 'session.error',
      properties: { sessionID: state.sessionId, error: { name: 'ProviderError', data: { message: 'auditor failed' } } },
    })

    const coderState = loopService.getActiveState(state.loopName)!
    expect(coderState.phase).toBe('coding')
    expect(coderState.sessionId).not.toBe(state.sessionId)
    const coderSessionId = coderState.sessionId

    for (let i = 0; i < 3; i++) await runTurn(coderSessionId)

    expect(loopService.getActiveState(state.loopName)?.phase).toBe('coding')
    const codingNudges = calls.filter(c => c.method === 'session.promptAsync'
      && (c.params as any)?.agent === 'code'
      && (c.params as any)?.sessionID === coderSessionId
      && String((c.params as any)?.parts?.[0]?.text ?? '').includes('You ended your turn without calling `loop-handoff`'))
    expect(codingNudges).toHaveLength(3)

    await runTurn(coderSessionId)

    const finalState = loopService.getAnyState(state.loopName)!
    expect(finalState.active).toBe(false)
    expect(finalState.terminationReason).toBe('handoff_missing')
  })

  test('post_action idle with an assistant error completes best-effort and keeps a pending loop-complete record', async () => {
    const { client } = createFakeForgeClient({
      session: {
        messages: async () => [
          {
            info: { role: 'assistant', finish: 'stop', error: { name: 'ProviderError', data: { message: 'provider failed' } } },
            parts: [],
          },
        ],
      },
    })
    const { loop } = buildRuntime({ client })
    const state = makeLoopState({ phase: 'post_action' })
    loopService.setState(state.loopName, state)
    loopService.registerLoopSession(state.sessionId, state.loopName)

    const payload = {
      outcome: 'completed_with_issues' as const,
      steps: [{ name: 'merge reviewer findings', status: 'failed' as const, detail: 'provider failed' }],
      followUps: ['retry the merge'],
    }
    await recordPostActionComplete(loop, state.sessionId, payload)

    await loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID: state.sessionId } })

    const finalState = loopService.getAnyState(state.loopName)!
    expect(finalState.active).toBe(false)
    expect(finalState.terminationReason).toBe('completed')
    expect(finalState.completionSummary).toBe(formatPostActionSummary(payload))
    expect(finalState.postActionReport).toBe(formatPostActionReport(payload))
  })

  test('post_action session error → terminates completed as best effort', async () => {
    const { client } = createFakeForgeClient()
    const { loop } = buildRuntime({ client })

    const state = makeLoopState({
      phase: 'post_action',
    })
    loopService.setState(state.loopName, state)
    loopService.registerLoopSession(state.sessionId, state.loopName)

    await loop.tick({
      type: 'session.error',
      properties: {
        sessionID: state.sessionId,
        error: {
          name: 'ProviderError',
          data: { message: 'provider failed' },
        },
      },
    })

    const finalState = loopService.getAnyState(state.loopName)
    expect(finalState).not.toBeNull()
    expect(finalState!.active).toBe(false)
    expect(finalState!.terminationReason).toBe('completed')
  })

  test('post_action session error with a pending loop-complete completes with the report', async () => {
    const { client } = createFakeForgeClient({
      session: {
        messages: async () => [
          {
            info: { role: 'assistant', finish: 'stop', error: { name: 'ProviderError', data: { message: 'provider failed' } } },
            parts: [],
          },
        ],
      },
    })
    const { loop } = buildRuntime({ client })

    const state = makeLoopState({
      phase: 'post_action',
    })
    loopService.setState(state.loopName, state)
    loopService.registerLoopSession(state.sessionId, state.loopName)

    const payload = {
      outcome: 'completed' as const,
      steps: [{ name: 'merge reviewer findings', status: 'done' as const }],
      followUps: [],
    }
    await recordPostActionComplete(loop, state.sessionId, payload)

    await loop.tick({
      type: 'session.error',
      properties: {
        sessionID: state.sessionId,
        error: {
          name: 'ProviderError',
          data: { message: 'provider failed' },
        },
      },
    })

    const finalState = loopService.getAnyState(state.loopName)!
    expect(finalState.active).toBe(false)
    expect(finalState.terminationReason).toBe('completed')
    expect(finalState.completionSummary).toBe(formatPostActionSummary(payload))
    expect(finalState.postActionReport).toBe(formatPostActionReport(payload))
    expect(loopService.listHandoffs(state.loopName)[0]).toMatchObject({ role: 'post_action', status: 'applied' })
  })

  test('post_action abort with a pending loop-complete → processes the handoff and completes', async () => {
    const { client } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'done' }] },
        ],
      },
    })
    const { loop } = buildRuntime({ client })

    const state = makeLoopState({
      phase: 'post_action',
    })
    loopService.setState(state.loopName, state)
    loopService.registerLoopSession(state.sessionId, state.loopName)

    const payload = {
      outcome: 'completed' as const,
      steps: [{ name: 'Post-action workflow', status: 'done' as const }],
      followUps: [],
    }
    await recordPostActionComplete(loop, state.sessionId, payload)

    await loop.tick({
      type: 'session.error',
      properties: {
        sessionID: state.sessionId,
        error: {
          name: 'AbortError',
        },
      },
    })

    const finalState = loopService.getAnyState(state.loopName)
    expect(finalState).not.toBeNull()
    expect(finalState!.active).toBe(false)
    expect(finalState!.terminationReason).toBe('completed')
    expect(finalState!.completionSummary).toBe(formatPostActionSummary(payload))
    expect(finalState!.postActionReport).toBe(formatPostActionReport(payload))
  })

  test('post_action abort without assistant response → terminates completed best effort', async () => {
    const { client } = createFakeForgeClient({
      session: {
        messages: async () => [],
      },
    })
    const { loop } = buildRuntime({ client })

    const state = makeLoopState({
      phase: 'post_action',
    })
    loopService.setState(state.loopName, state)
    loopService.registerLoopSession(state.sessionId, state.loopName)

    await loop.tick({
      type: 'session.error',
      properties: {
        sessionID: state.sessionId,
        error: {
          name: 'AbortError',
        },
      },
    })

    const finalState = loopService.getAnyState(state.loopName)
    expect(finalState).not.toBeNull()
    expect(finalState!.active).toBe(false)
    expect(finalState!.terminationReason).toBe('completed')
  })

  test('postAction with configured model → sends post-action prompt with that model', async () => {
    const { client, calls } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear. No issues found.' }] },
        ],
      },
    })
    const { loop } = buildRuntime({
      client,
      loopConfig: {
        loop: {
          enabled: true,
          defaultMaxIterations: 5,
          postAction: { enabled: true, skill: 'pr-review', model: 'custom/post-model' },
        },
      },
    })

    const state = makeLoopState({
      phase: 'auditing',
      totalSections: 0,
      auditCount: 0,
      iteration: 1,
      maxIterations: 3,
      auditorModel: 'state/auditor-model',
    })
    loopService.setState(state.loopName, state)

    await recordAuditorHandoff(loop, state.sessionId)

    await loop.tick({
      type: 'session.status',
      properties: { status: { type: 'idle' }, sessionID: state.sessionId },
    })

    const afterState = loopService.getAnyState(state.loopName)
    expect(afterState!.phase).toBe('post_action')

    // The post-action prompt should be sent with the configured model, not the auditor model.
    const codeCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
    const lastCodePrompt = codeCalls[codeCalls.length - 1]?.params as any
    expect(lastCodePrompt?.model).toEqual({ providerID: 'custom', modelID: 'post-model' })
  })

  test('postAction without configured model → sends post-action prompt with auditor model', async () => {
    const { client, calls } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear. No issues found.' }] },
        ],
      },
    })
    const { loop } = buildRuntime({
      client,
      loopConfig: {
        loop: {
          enabled: true,
          defaultMaxIterations: 5,
          postAction: { enabled: true, skill: 'pr-review' },
        },
      },
    })

    const state = makeLoopState({
      phase: 'auditing',
      totalSections: 0,
      auditCount: 0,
      iteration: 1,
      maxIterations: 3,
      auditorModel: 'state/auditor-model',
    })
    loopService.setState(state.loopName, state)

    await recordAuditorHandoff(loop, state.sessionId)

    await loop.tick({
      type: 'session.status',
      properties: { status: { type: 'idle' }, sessionID: state.sessionId },
    })

    const codeCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
    const lastCodePrompt = codeCalls[codeCalls.length - 1]?.params as any
    expect(lastCodePrompt?.model).toEqual({ providerID: 'state', modelID: 'auditor-model' })
  })
})

describe('runtime re-provisioning updates state.workspaceId', () => {
  test('ensureWorkspaceForLoop provisions workspace and sets workspaceId', async () => {
    const { client } = createFakeForgeClient({
      session: {
        messages: async () => [
          { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
        ],
      },
      workspace: {
        create: async () => ({ id: 'ws_new', directory: '/tmp/wt/new', branch: 'opencode/new' }),
      },
    })

    const { loop } = buildRuntime({ client })

    const state = makeLoopState({
      phase: 'coding',
      totalSections: 0,
      auditCount: 0,
      worktree: true,
      workspaceId: undefined,
      worktreeBranch: 'test/original-branch',
      worktreeDir: '/tmp/wt/original',
    })
    loopService.setState(state.loopName, state)

    await recordCoderHandoff(loop, state.sessionId)

    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: state.sessionId,
      },
    })

    // workspaceId IS persisted to DB by setWorkspaceId
    const afterState = loopService.getAnyState(state.loopName)
    expect(afterState).not.toBeNull()
    expect(afterState!.workspaceId).toBe('ws_new')
  })
})

describe('stall handling terminates with stall timeout when configured cap is reached', () => {
    test('repeated stall recovery attempts eventually terminate with stall_timeout', async () => {
      const stallConfig: LoopConfig = {
        stallTimeoutMs: 50,
        maxConsecutiveStalls: 2,
      }

      const { client } = createFakeForgeClient()

      const { loop } = buildRuntime({ client, stallConfig })

      const state = makeLoopState({
        phase: 'coding',
        totalSections: 0,
      })
      loopService.setState(state.loopName, state)

      // Start watchdog
      vi.useFakeTimers()
      loop.startWatchdog(state.loopName)
      loop.recordActivity(state.loopName, 'initial')

      // Advance past the first stall detection and recovery
      await vi.advanceTimersByTimeAsync(150)

      // Record activity again and advance to another stall detection cycle
      loop.recordActivity(state.loopName, 'after-recovery')
      await vi.advanceTimersByTimeAsync(150)

      // After two stalls (exceeding max of 2), the loop must be terminated with stall_timeout
      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.terminationReason).toBe('stall_timeout')
    })
  })

  describe('watchdog busy-stall recovery routes wedged auditor sessions through the fallback chain', () => {
    function createWatchdogLoop(
      config: PluginConfig,
      client: ForgeClient,
      loopCfg: LoopConfig,
    ): Loop {
      return buildRuntime({ client, loopConfig: config, stallConfig: loopCfg }).loop
    }

    async function stopWatchdogAndDrain(loop: Loop, loopName: string): Promise<void> {
      loop.clearLoopTimers(loopName)
      await vi.advanceTimersByTimeAsync(400)
    }

    test('a wedged auditing session is aborted and re-dispatched on the next fallback model instead of a generic continue nudge', async () => {
      let fallbackDispatched = false
      const { client, calls } = createFakeForgeClient({
        session: {
          status: async () => {
            if (fallbackDispatched) return {}
            return { 'loop-session-id': { type: 'busy' } }
          },
          promptAsync: async (params: any) => {
            if (params?.agent === 'auditor-loop' && params?.model?.modelID === 'auditor-2') {
              fallbackDispatched = true
            }
          },
        },
      })
      const loop = createWatchdogLoop(
        { ...mockConfig, auditorFallbackModels: ['fb/auditor-2'] },
        client,
        { stallTimeoutMs: 10_000, busyStallTimeoutMs: 30, maxConsecutiveStalls: 100 },
      )

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0, auditorFallbackIndex: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      vi.useFakeTimers()
      loop.startWatchdog(state.loopName)
      await vi.advanceTimersByTimeAsync(600)

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(1)

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(1)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'auditor-2' } })
      expect((auditorCalls[0].params as any).parts?.[0]?.text).not.toBe('Continue where you left off.')

      await stopWatchdogAndDrain(loop, state.loopName)
    })

    test('a wedged coding session receives bounded generic continue nudges on the code agent', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          status: async () => ({ 'loop-session-id': { type: 'busy' } }),
        },
      })
      const loop = createWatchdogLoop(
        { ...mockConfig },
        client,
        { stallTimeoutMs: 100, busyStallTimeoutMs: 30, maxConsecutiveStalls: 3 },
      )

      const state = makeLoopState({ phase: 'coding', totalSections: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      vi.useFakeTimers()
      loop.startWatchdog(state.loopName)
      await vi.advanceTimersByTimeAsync(1500)

      const codeCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
      expect(codeCalls.length).toBeGreaterThanOrEqual(1)
      expect((codeCalls[0].params as any).parts?.[0]?.text).toBe('Continue where you left off.')
      expect((codeCalls[0].params as any).model).toEqual({ providerID: 'test', modelID: 'model' })
      expect(loopService.getAnyState(state.loopName)?.terminationReason).toBe('stall_timeout')

      await stopWatchdogAndDrain(loop, state.loopName)
    })

    test('a wedged auditor with no remaining fallback is nudged with a generic continue that keeps the stall counter climbing until termination', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          status: async () => ({ 'loop-session-id': { type: 'busy' } }),
        },
      })
      const loop = createWatchdogLoop(
        { ...mockConfig },
        client,
        { stallTimeoutMs: 100, busyStallTimeoutMs: 30, maxConsecutiveStalls: 3 },
      )

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0, auditorFallbackIndex: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      vi.useFakeTimers()
      loop.startWatchdog(state.loopName)
      await vi.advanceTimersByTimeAsync(1500)

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.terminationReason).toBe('stall_timeout')

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls.length).toBeGreaterThan(0)
      expect((auditorCalls[0].params as any).parts?.[0]?.text).toBe('Continue where you left off.')

      await stopWatchdogAndDrain(loop, state.loopName)
    })
  })

  describe('in-flight prompt guard', () => {
    test('rejects audit prompt while code prompt in-flight', async () => {
      markPromptInFlight(PROJECT_ID, 'test-loop', 'other-session-id', 'code')

      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
          ],
        },
      })
      const { loop, logs } = buildRuntime({ client })

      const state = makeLoopState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      const hasGuardError = logs.some(
        (l) => l.level === 'error' && l.message.includes('[in-flight-guard]'),
      )
      expect(hasGuardError).toBe(true)

      const prior = getPromptInFlight(PROJECT_ID, 'test-loop')
      expect(prior).toBeDefined()
      expect(prior!.sessionId).toBe('other-session-id')
      expect(prior!.agent).toBe('code')
    })

    test('rejects duplicate auditor prompt for same audit session', async () => {
      markPromptInFlight(PROJECT_ID, 'test-loop', 'sess', 'auditor-loop')

      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Implementation complete.' }] },
          ],
        },
      })
      const { loop, logs } = buildRuntime({ client })

      const state = makeLoopState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      const hasGuardError = logs.some(
        (l) => l.level === 'error' && l.message.includes('[in-flight-guard]'),
      )
      expect(hasGuardError).toBe(true)

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(0)

      const prior = getPromptInFlight(PROJECT_ID, 'test-loop')
      expect(prior).toBeDefined()
      expect(prior!.sessionId).toBe('sess')
      expect(prior!.agent).toBe('auditor-loop')
    })

    test('clears in-flight after busy event', async () => {
      const state = makeLoopState({ phase: 'coding' })
      markPromptInFlight(PROJECT_ID, 'test-loop', state.sessionId, 'code')

      const { loop } = buildRuntime()
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'busy' },
          sessionID: state.sessionId,
        },
      })

      expect(getPromptInFlight(PROJECT_ID, 'test-loop')).toBeUndefined()
    })

    test('busy event from non-owning session does not clear in-flight', async () => {
      markPromptInFlight(PROJECT_ID, 'test-loop', 'sess-owner', 'auditor-loop')

      const { loop } = buildRuntime()
      const state = makeLoopState({ phase: 'coding' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession('sess-old', 'test-loop')

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'busy' },
          sessionID: 'sess-old',
        },
      })

      const entry = getPromptInFlight(PROJECT_ID, 'test-loop')
      expect(entry).toBeDefined()
      expect(entry!.sessionId).toBe('sess-owner')
      expect(entry!.agent).toBe('auditor-loop')
    })

    test('clears in-flight when promptAsync throws a transient error', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Implementation complete.' }] },
          ],
          promptAsync: async (params: any) => {
            if (params?.agent === 'code' && params?.sessionID === 'loop-session-id') {
              throw new Error('transient transport error')
            }
          },
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      expect(getPromptInFlight(PROJECT_ID, 'test-loop')).toBeUndefined()
    })

    test('clears in-flight on prompt completion', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear.' }] },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      expect(getPromptInFlight(PROJECT_ID, 'test-loop')).toBeUndefined()
    })

    test('handlePromptError short-circuits on ConcurrentPromptError, preserving loop active state', async () => {
      markPromptInFlight(PROJECT_ID, 'test-loop', 'other-session-id', 'code')

      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      const afterState = loop.service.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)

      const prior = getPromptInFlight(PROJECT_ID, 'test-loop')
      expect(prior).toBeDefined()
      expect(prior!.sessionId).toBe('other-session-id')
      expect(prior!.agent).toBe('code')
    })
  })

  describe('session retention', () => {
    test('retains the coder session as standby on coding phase transition', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear.' }] },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await recordCoderHandoff(loop, state.sessionId)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      const deleteCalls = calls.filter(c => c.method === 'session.delete')
      expect(deleteCalls.map((c: any) => c.params.sessionID)).not.toContain(state.sessionId)

      const after = loop.service.getActiveState(state.loopName)!
      expect(after.phase).toBe('auditing')
      expect(after.standbySessionId).toBe(state.sessionId)
    })

    test('tolerates delete failure without crashing', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear.' }] },
          ],
          delete: async () => { throw new Error('delete failed') },
        },
      })
      const { loop, logs } = buildRuntime({ client })

      const state = makeLoopState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      await recordCoderHandoff(loop, state.sessionId)
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      await loop.cancel(state.loopName)

      const deletedSids = calls.filter(c => c.method === 'session.delete').map((c: any) => c.params.sessionID)
      expect(deletedSids).toContain(state.sessionId)
      await vi.waitFor(() => {
        expect(logs.some(l => l.level === 'error' && l.message.includes(`failed to delete trimmed session ${state.sessionId}`))).toBe(true)
      })
      expect(loopService.getAnyState(state.loopName)!.active).toBe(false)
    })

    test('terminate flushes retained sessions', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear.' }] },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
      })
      loopService.setState(state.loopName, state)

      // First rotation: coding→audit
      await recordCoderHandoff(loop, state.sessionId)
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // Terminate the loop: terminateLoop should clean up retained sessions
      await loop.cancel(state.loopName)

      const deleteCalls = calls.filter(c => c.method === 'session.delete')
      const deletedSids = deleteCalls.map((c: any) => c.params.sessionID)
      expect(deletedSids).toContain(state.sessionId)
    })
  })

  describe('usage capture', () => {
    function mockAssistantMessage(cost: number, tokens: { input: number; output: number; reasoning: number }) {
      return {
        info: {
          role: 'assistant' as const,
          finish: 'stop',
          cost,
          tokens: {
            input: tokens.input,
            output: tokens.output,
            reasoning: tokens.reasoning,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [{ type: 'text' as const, text: 'Implementation complete.' }],
      }
    }

    test('code session retention captures usage with state.executionModel', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [mockAssistantMessage(0.001, { input: 100, output: 50, reasoning: 10 })],
        },
      })
      const { loop } = buildRuntime({ client, withUsageRepo: true })

      const state = makeLoopState({
        phase: 'coding',
        executionModel: 'test/exec-model',
        auditorModel: 'test/auditor-model',
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      await loop.cancel(state.loopName)

      // Wait a tick for async capture to complete
      await new Promise(resolve => setTimeout(resolve, 10))

      const usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()
      expect(usage!.byModel).toHaveProperty('test/exec-model')
      expect(usage!.byModel['test/exec-model'].inputTokens).toBe(100)
    })

    test('audit termination captures usage with state.auditorModel', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [mockAssistantMessage(0.002, { input: 200, output: 100, reasoning: 20 })],
        },
      })
      const { loop } = buildRuntime({ client, withUsageRepo: true })

      const state = makeLoopState({
        phase: 'auditing',
        executionModel: 'test/exec-model',
        auditorModel: 'test/audit-model',
        auditCount: 0,
        iteration: 1,
        maxIterations: 3,
      })
      loopService.setState(state.loopName, state)

      await recordAuditorHandoff(loop, state.sessionId)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // Wait for async capture
      await new Promise(resolve => setTimeout(resolve, 10))

      const usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()
      expect(usage!.byModel).toHaveProperty('test/audit-model')
      expect(usage!.byModel['test/audit-model'].inputTokens).toBe(200)
    })

    test('state models take precedence over current config', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [mockAssistantMessage(0.001, { input: 150, output: 75, reasoning: 15 })],
        },
      })
      const { loop } = buildRuntime({ client, withUsageRepo: true })

      const state = makeLoopState({
        phase: 'coding',
        executionModel: 'state/exec-model',
      })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      await loop.cancel(state.loopName)

      await new Promise(resolve => setTimeout(resolve, 10))

      const usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()
      // Should use state.executionModel, not config.executionModel
      expect(usage!.byModel).toHaveProperty('state/exec-model')
    })

    test('capture failure logs error but does not block termination', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => { throw new Error('messages fetch failed') },
        },
      })
      const { loop, logs } = buildRuntime({ client, withUsageRepo: true })

      const state = makeLoopState({ phase: 'coding' })
      loopService.setState(state.loopName, state)

      await loop.cancel(state.loopName)

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)

      const hasCaptureError = logs.some(l => l.level === 'error' && l.message.includes('failed to capture usage'))
      expect(hasCaptureError).toBe(true)
    })

    test('retained sessions preserve role and model: coder standby captured on termination', async () => {
      const messagesBySession = new Map<string, Array<Record<string, unknown>>>()
      messagesBySession.set('coding-session-1', [
        mockAssistantMessage(0.001, { input: 100, output: 50, reasoning: 10 }),
      ])
      const { client } = createFakeForgeClient({
        session: {
          messages: async (params: any) => messagesBySession.get(params.sessionID) ?? [],
        },
      })
      const { loop } = buildRuntime({ client, withUsageRepo: true })

      const state = makeLoopState({
        phase: 'coding',
        executionModel: 'state/exec-model',
        auditorModel: 'state/audit-model',
        auditCount: 0,
        loopName: 'test-loop-mixed-1',
        sessionId: 'coding-session-1',
      })
      loopService.setState(state.loopName, state)

      // First transition: coding→audit, the coding session becomes the standby
      await recordCoderHandoff(loop, state.sessionId)
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      const afterFirstTick = loopService.getActiveState(state.loopName)!
      expect(afterFirstTick.phase).toBe('auditing')
      expect(afterFirstTick.standbySessionId).toBe('coding-session-1')

      // Set up messages for the audit session
      messagesBySession.set(afterFirstTick.sessionId, [
        mockAssistantMessage(0.002, { input: 200, output: 100, reasoning: 20 }),
      ])

      // The standby is retained, not captured, while the loop runs
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)).toBeNull()

      // Terminating the loop captures the standby under the code role and the
      // current audit session under the auditor role.
      await loop.cancel(state.loopName)

      await new Promise(resolve => setTimeout(resolve, 10))

      const usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()
      expect(usage!.byModel).toHaveProperty('state/exec-model')
      expect(usage!.byModel['state/exec-model'].inputTokens).toBe(100)
      expect(usage!.byModel).toHaveProperty('state/audit-model')
      expect(usage!.byModel['state/audit-model'].inputTokens).toBe(200)
    })

    test('retained audit session cleaned up on termination with correct attribution', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [mockAssistantMessage(0.002, { input: 200, output: 100, reasoning: 20 })],
        },
      })
      const { loop } = buildRuntime({ client, withUsageRepo: true })

      // Start in auditing phase
      const state = makeLoopState({
        phase: 'auditing',
        executionModel: 'state/exec-model',
        auditorModel: 'state/audit-model',
        auditCount: 0,
        iteration: 1,
        maxIterations: 3,
      })
      loopService.setState(state.loopName, state)

      // Rotation: audit→coding, queues audit session as 'auditor' role
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // Now terminate the loop
      await loop.cancel(state.loopName)

      // Wait for async capture
      await new Promise(resolve => setTimeout(resolve, 10))

      const usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()

      // Retained audit session should be captured with state.auditorModel
      expect(usage!.byModel).toHaveProperty('state/audit-model')
      expect(usage!.byModel['state/audit-model'].inputTokens).toBe(200)
    })

    test('retained sessions cleaned up on clearLoopTimers with correct attribution', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [mockAssistantMessage(0.001, { input: 150, output: 75, reasoning: 15 })],
        },
      })
      const { loop } = buildRuntime({ client, withUsageRepo: true })

      const state = makeLoopState({
        phase: 'coding',
        executionModel: 'state/exec-model',
        auditorModel: 'state/audit-model',
      })
      loopService.setState(state.loopName, state)

      // Rotation: coding→audit, queues coding session as 'code' role
      await recordCoderHandoff(loop, state.sessionId)
      await loop.tick({
        type: 'session.status',
        properties: { status: { type: 'idle' }, sessionID: state.sessionId },
      })

      // Call clearLoopTimers to clean up retained sessions
      await loop.clearLoopTimers(state.loopName)

      // Wait for async capture
      await new Promise(resolve => setTimeout(resolve, 10))

      const usage = loopSessionUsageRepo.getAggregate(PROJECT_ID, state.loopName)
      expect(usage).not.toBeNull()

      // Retained coding session should be captured with state.executionModel
      expect(usage!.byModel).toHaveProperty('state/exec-model')
      expect(usage!.byModel['state/exec-model'].inputTokens).toBe(150)
    })
  })

  describe('variant dispatch', () => {
    test('coding prompt sends executionVariant from loop state', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({
        phase: 'auditing',
        totalSections: 0,
        auditCount: 1,
        executionVariant: 'thinking-max',
        auditorVariant: 'audit-high',
      })
      loopService.setState(state.loopName, state)

      // Add a bug finding so the audit is dirty and transitions back to coding
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test bug',
      })

      await recordAuditorHandoff(loop, state.sessionId)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      // After auditing phase processes dirty audit, it transitions to coding and sends code prompts
      const codePrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
      expect(codePrompts.length).toBeGreaterThan(0)
      for (const call of codePrompts) {
        expect((call.params as any)?.variant).toBe('thinking-max')
      }
    })

    test('auditor prompt sends auditorVariant from loop state', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
        executionVariant: 'thinking-max',
        auditorVariant: 'audit-high',
      })
      loopService.setState(state.loopName, state)

      await recordCoderHandoff(loop, state.sessionId)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      // The auditor prompt should have the auditorVariant
      const auditorPrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorPrompts.length).toBeGreaterThan(0)
      for (const call of auditorPrompts) {
        expect((call.params as any)?.variant).toBe('audit-high')
      }
    })

    test('auditorFallbackIndex 0 keeps primary auditor model and variant', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
          ],
        },
      })
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/auditor-2'] } })

      const state = makeLoopState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
        auditorFallbackIndex: 0,
        auditorVariant: 'audit-high',
      })
      loopService.setState(state.loopName, state)

      await recordCoderHandoff(loop, state.sessionId)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      const auditorPrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorPrompts.length).toBeGreaterThan(0)
      for (const call of auditorPrompts) {
        expect((call.params as any)?.model).toEqual({ providerID: 'test', modelID: 'auditor' })
        expect((call.params as any)?.variant).toBe('audit-high')
      }
    })

    test('auditorFallbackIndex 1 uses fallback model and drops variant', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
          ],
        },
      })
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/auditor-2'] } })

      const state = makeLoopState({
        phase: 'coding',
        totalSections: 0,
        auditCount: 0,
        auditorFallbackIndex: 1,
        auditorVariant: 'audit-high',
      })
      loopService.setState(state.loopName, state)

      await recordCoderHandoff(loop, state.sessionId)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      const auditorPrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorPrompts.length).toBeGreaterThan(0)
      for (const call of auditorPrompts) {
        expect((call.params as any)?.model).toEqual({ providerID: 'fb', modelID: 'auditor-2' })
        expect((call.params as any)?.variant).toBeUndefined()
      }
    })

    test('model fallback omits variant when model is undefined', async () => {
      let failCount = 2
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Audit passed.' }] },
          ],
          promptAsync: async () => {
            if (failCount > 0) {
              failCount--
              throw Object.assign(new Error('simulated model failure'), { name: 'TestError', data: { message: 'simulated model failure' } })
            }
          },
        },
      })
      const { loop } = buildRuntime({ client, loopConfig: { executionModel: 'test/model' } })

      const state = makeLoopState({
        phase: 'auditing',
        totalSections: 0,
        auditCount: 1,
        executionModel: 'test/model',
        executionVariant: 'thinking-max',
      })
      loopService.setState(state.loopName, state)

      // Add a bug finding so the audit is dirty and transitions back to coding
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test bug',
      })

      await recordAuditorHandoff(loop, state.sessionId)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      // Model-based attempts should have been made (and failed)
      const codePrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
      expect(codePrompts.length).toBeGreaterThan(0)
      // After model fails, fallback without model should NOT send variant
      const fallbackPrompts = codePrompts.filter(c => !(c.params as any)?.variant)
      expect(fallbackPrompts.length).toBeGreaterThan(0)
    })

    test('post-action prompt with no configured model sends auditor model and auditor variant', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear. No issues found.' }] },
          ],
        },
      })
      const { loop } = buildRuntime({
        client,
        loopConfig: {
          loop: {
            enabled: true,
            defaultMaxIterations: 5,
            postAction: { enabled: true, skill: 'pr-review' },
          },
        },
      })

      const state = makeLoopState({
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 3,
        executionVariant: 'thinking-max',
        auditorVariant: 'audit-high',
      })
      loopService.setState(state.loopName, state)

      await recordAuditorHandoff(loop, state.sessionId)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      const afterState = loopService.getAnyState(state.loopName)!
      expect(afterState.phase).toBe('post_action')

      const postActionPrompts = calls.filter(
        c => c.method === 'session.promptAsync' && (c.params as any)?.sessionID === afterState.sessionId,
      )
      expect(postActionPrompts.length).toBeGreaterThan(0)
      for (const call of postActionPrompts) {
        expect((call.params as any)?.model).toEqual({ providerID: 'test', modelID: 'auditor' })
        expect((call.params as any)?.variant).toBe('audit-high')
      }
    })

    test('post-action prompt with configured model omits the variant on the primary and uses the auditor variant on the fallback', async () => {
      let failCount = 2
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'All clear. No issues found.' }] },
          ],
          promptAsync: async () => {
            if (failCount > 0) {
              failCount--
              throw Object.assign(new Error('simulated model failure'), { name: 'TestError', data: { message: 'simulated model failure' } })
            }
          },
        },
      })
      const { loop } = buildRuntime({
        client,
        loopConfig: {
          loop: {
            enabled: true,
            defaultMaxIterations: 5,
            postAction: { enabled: true, skill: 'pr-review', model: 'cfg/post' },
          },
        },
      })

      const state = makeLoopState({
        phase: 'auditing',
        totalSections: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 3,
        executionVariant: 'thinking-max',
        auditorVariant: 'audit-high',
      })
      loopService.setState(state.loopName, state)

      await recordAuditorHandoff(loop, state.sessionId)

      await loop.tick({
        type: 'session.status',
        properties: {
          status: { type: 'idle' },
          sessionID: state.sessionId,
        },
      })

      const afterState = loopService.getAnyState(state.loopName)!
      expect(afterState.phase).toBe('post_action')

      const postActionPrompts = calls.filter(
        c => c.method === 'session.promptAsync' && (c.params as any)?.sessionID === afterState.sessionId,
      )
      const primaryAttempts = postActionPrompts.filter(c => (c.params as any)?.model?.modelID === 'post')
      expect(primaryAttempts.length).toBe(2)
      for (const call of primaryAttempts) {
        expect((call.params as any)?.variant).toBeUndefined()
      }
      const fallbackAttempts = postActionPrompts.filter(c => (c.params as any)?.model?.modelID === 'auditor')
      expect(fallbackAttempts.length).toBe(1)
      expect((fallbackAttempts[0].params as any)?.variant).toBe('audit-high')
    })
  })

  describe('provider limit abort', () => {
    test('retry event with usage-limit message terminates', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'coding' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await loop.tick({
        type: 'session.status',
        properties: {
          sessionID: state.sessionId,
          status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('generic retry event does not terminate', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'coding' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await loop.tick({
        type: 'session.status',
        properties: {
          sessionID: state.sessionId,
          status: { type: 'retry', attempt: 1, message: 'rate limited, retrying', next: 5000 },
        },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBe(0)
    })

    test('session.error APIError 403 terminates', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'coding' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: state.sessionId,
          error: { name: 'APIError', data: { message: 'forbidden', statusCode: 403 } },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('session.error ProviderAuthError terminates in coding phase', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'coding' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: state.sessionId,
          error: { name: 'ProviderAuthError', data: { message: 'invalid API key' } },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('session.error UnknownError without limit text does not terminate', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'coding' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: state.sessionId,
          error: { name: 'UnknownError', data: { message: 'something went wrong' } },
        },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBe(0)
    })

    test('auditing phase usage-limit error terminates instead of rotating', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'auditing' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: state.sessionId,
          error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      // Should NOT have rotated to coding
      const createCalls = calls.filter(c => c.method === 'session.create')
      expect(createCalls.length).toBe(0)

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('stale session provider-limit error terminates the active loop', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })

      const originalSessionId = 'original-session-id'
      const state = makeLoopState({ sessionId: originalSessionId, phase: 'coding' })
      loop.start({ state })

      // Simulate session rotation: new session becomes current
      const rotatedSessionId = 'rotated-session-id'
      const rotatedState = makeLoopState({ sessionId: rotatedSessionId, phase: 'coding' })
      loop.restart(state.loopName, { newState: rotatedState, newSessionId: rotatedSessionId })

      // Stale session emits a provider-limit error
      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: originalSessionId,
          error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('stale session non-provider-limit error does not terminate', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })

      const originalSessionId = 'original-session-id'
      const state = makeLoopState({ sessionId: originalSessionId, phase: 'coding' })
      loop.start({ state })

      // Simulate session rotation
      const rotatedSessionId = 'rotated-session-id'
      const rotatedState = makeLoopState({ sessionId: rotatedSessionId, phase: 'coding' })
      loop.restart(state.loopName, { newState: rotatedState, newSessionId: rotatedSessionId })

      // Stale session emits a non-provider-limit error
      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: originalSessionId,
          error: { name: 'UnknownError', data: { message: 'something went wrong' } },
        },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBe(0)
    })

    test('stale audit session provider-limit error terminates the active loop', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })

      const codingSessionId = 'coding-session-id'
      const state = makeLoopState({ sessionId: codingSessionId, phase: 'coding' })
      loop.start({ state })

      // Register an audit session (simulates audit creation replacing the coding session)
      const auditSessionId = 'audit-session-id'
      loop.registerSessionReverseIndex(auditSessionId, state.loopName)
      loopService.replaceSession(state.loopName, {
        newSessionId: auditSessionId,
        phase: 'auditing',
      })

      // Rotate back to coding (simulates post-audit rotation)
      const newCodingSessionId = 'new-coding-session-id'
      loop.restart(state.loopName, {
        newState: makeLoopState({ sessionId: newCodingSessionId, phase: 'coding' }),
        newSessionId: newCodingSessionId,
      })

      // The retired audit session emits a provider-limit error
      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: auditSessionId,
          error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('child session provider-limit retry terminates the owning loop', async () => {
      const { client, calls } = createFakeForgeClient()
      const parentLookup = new Map<string, string>()
      const { loop } = buildRuntime({
        client,
        getParentSessionId: async (sid: string) => parentLookup.get(sid) ?? null,
      })

      const codingSessionId = 'coding-session-id'
      const state = makeLoopState({ sessionId: codingSessionId, phase: 'coding' })
      loop.start({ state })

      // Register a child session whose parent is the coding session
      const childSessionId = 'child-session-id'
      parentLookup.set(childSessionId, codingSessionId)

      // Child session emits a provider-limit retry status
      await loop.tick({
        type: 'session.status',
        properties: {
          sessionID: childSessionId,
          status: { type: 'retry', attempt: 1, message: 'You have reached your usage limit', next: 60000 },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('generic child session retry does not terminate', async () => {
      const { client, calls } = createFakeForgeClient()
      const parentLookup = new Map<string, string>()
      const { loop } = buildRuntime({
        client,
        getParentSessionId: async (sid: string) => parentLookup.get(sid) ?? null,
      })

      const codingSessionId = 'coding-session-id'
      const state = makeLoopState({ sessionId: codingSessionId, phase: 'coding' })
      loop.start({ state })

      const childSessionId = 'child-session-id'
      parentLookup.set(childSessionId, codingSessionId)

      // Child session emits a generic retry (not provider-limit)
      await loop.tick({
        type: 'session.status',
        properties: {
          sessionID: childSessionId,
          status: { type: 'retry', attempt: 1, message: 'rate limited, retrying', next: 5000 },
        },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBe(0)
    })

    test('transient ancestry lookup rejection does not reject retry status handling and leaves loop running', async () => {
      const fake = createFakeForgeClient()
      const { loop, logs } = buildRuntime({
        client: fake.client,
        getParentSessionId: async () => { throw new Error('transient ancestry failure') },
      })
      const codingSessionId = 'coding-session-id'
      const state = makeLoopState({ sessionId: codingSessionId, phase: 'coding' })
      loopService.setState(state.loopName, state)

      await expect(
        loop.tick({
          type: 'session.status',
          properties: {
            sessionID: 'child-session-id',
            status: { type: 'retry', attempt: 1, message: 'You have reached your usage limit', next: 60000 },
          },
        }),
      ).resolves.toBeUndefined()

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)

      const abortCalls = fake.calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBe(0)
      expect(logs.some(l => l.level === 'error' && l.message.includes('ancestry lookup failed'))).toBe(true)
    })

    test('persisted assistant error with usage-limit text terminates as provider_limit', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            {
              info: {
                role: 'assistant',
                finish: 'stop',
                error: {
                  name: 'ProviderError',
                  data: { message: 'You have reached your usage limit', statusCode: 403 },
                },
              },
              parts: [{ type: 'text', text: '' }],
            },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'coding' })
      loopService.setState(state.loopName, state)

      // Send busy then idle to trigger runCodingPhase
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'busy' } },
      })
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'idle' } },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('persisted assistant ProviderAuthError terminates as provider_limit', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            {
              info: {
                role: 'assistant',
                finish: 'stop',
                error: {
                  name: 'ProviderAuthError',
                  data: { message: 'invalid API key' },
                },
              },
              parts: [{ type: 'text', text: '' }],
            },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'coding' })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'busy' } },
      })
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'idle' } },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')
    })

    test('persisted assistant error with 403 status terminates as provider_limit', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            {
              info: {
                role: 'assistant',
                finish: 'stop',
                error: {
                  name: 'APIError',
                  data: { message: 'forbidden', statusCode: 403 },
                },
              },
              parts: [{ type: 'text', text: '' }],
            },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'coding' })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'busy' } },
      })
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'idle' } },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')
    })

    test('persisted assistant error with 429 does not terminate as provider_limit', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => [
            {
              info: {
                role: 'assistant',
                finish: 'stop',
                error: {
                  name: 'APIError',
                  data: { message: 'rate limited', statusCode: 429 },
                },
              },
              parts: [{ type: 'text', text: '' }],
            },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'coding' })
      loopService.setState(state.loopName, state)

      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'busy' } },
      })
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'idle' } },
      })

      // Should NOT terminate as provider_limit — 429 is not a fatal limit
      const afterState = loopService.getActiveState(state.loopName)
      if (afterState) {
        // If still active, no provider_limit termination
        if (afterState.active) {
          expect(afterState.terminationReason).toBeUndefined()
        } else {
          // If terminated, it should be error_max_retries, not provider_limit
          expect(afterState.terminationReason).not.toContain('provider_limit:')
        }
      }
    })

    test('concurrent cancel during provider-limit termination executes side effects once', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'coding' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      // Start provider-limit termination via session.error
      const errorPromise = loop.tick({
        type: 'session.error',
        properties: {
          sessionID: state.sessionId,
          error: { name: 'ProviderAuthError', data: { message: 'invalid API key' } },
        },
      })

      // Concurrently cancel (simulates user cancel racing with provider-limit detection)
      const cancelPromise = loop.cancel(state.loopName)

      await Promise.all([errorPromise, cancelPromise])

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      // Either path may win the race; the admission guard ensures exactly one executes
      expect(['errored', 'cancelled']).toContain(afterState!.status)

      // abort should be called exactly once (not twice from the race)
      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBe(1)
    })
  })

  describe('auditor model fallback', () => {
    function auditLimitPromptAsync(params: any): void {
      if (params?.agent === 'auditor-loop') {
        const err = new Error('You have reached your usage limit')
        ;(err as any).statusCode = 403
        throw err
      }
    }

    function makeCodingIdleMessages(): Array<{ info: { role: string; finish: string }; parts: Array<{ type: string; text: string }> }> {
      return [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Coded something.' }] }]
    }

    async function driveAuditSend(loop: Loop, state: LoopState): Promise<void> {
      await recordCoderHandoff(loop, state.sessionId)
      await loop.tick({ type: 'session.status', properties: { sessionID: state.sessionId, status: { type: 'busy' } } })
      await loop.tick({ type: 'session.status', properties: { sessionID: state.sessionId, status: { type: 'idle' } } })
    }

    test('audit prompt send failure with a configured fallback re-dispatches with the fallback auditor model', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => makeCodingIdleMessages(),
          promptAsync: async (params: any) => {
            if (params?.agent === 'auditor-loop' && params?.model?.modelID === 'auditor') {
              const err = new Error('Request failed')
              ;(err as any).data = { message: 'You have reached your usage limit', statusCode: 429 }
              throw err
            }
          },
        },
      })
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/auditor-2'] } })

      const state = makeLoopState({ phase: 'coding', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await driveAuditSend(loop, state)

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(1)

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls.length).toBe(2)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'test', modelID: 'auditor' } })
      expect(auditorCalls[1].params).toMatchObject({ model: { providerID: 'fb', modelID: 'auditor-2' } })
    })

    test('audit prompt send failure with no configured fallback terminates', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => makeCodingIdleMessages(),
          promptAsync: async (params: any) => auditLimitPromptAsync(params),
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'coding', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await driveAuditSend(loop, state)

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')
      expect(afterState!.auditorFallbackIndex).toBe(0)
    })

    test('two configured fallbacks where every send is limited re-dispatches twice then terminates', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => makeCodingIdleMessages(),
          promptAsync: async (params: any) => auditLimitPromptAsync(params),
        },
      })
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/a', 'fb/b'] } })

      const state = makeLoopState({ phase: 'coding', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await driveAuditSend(loop, state)

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')
      expect(afterState!.auditorFallbackIndex).toBe(2)

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      // initial (test/auditor) + resend #1 (fb/a) + resend #2 (fb/b)
      expect(auditorCalls.length).toBe(3)
    })

    test('coding phase provider limit still terminates immediately and leaves auditorFallbackIndex at 0', async () => {
      const { client } = createFakeForgeClient()
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/auditor-2'] } })

      const state = makeLoopState({ phase: 'coding' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')
      expect(afterState!.auditorFallbackIndex).toBe(0)
    })

    test('no loop_transitions row is written for a fallback advance', async () => {
      const { client } = createFakeForgeClient({
        session: {
          messages: async () => makeCodingIdleMessages(),
          promptAsync: async (params: any) => {
            if (params?.agent === 'auditor-loop' && params?.model?.modelID === 'auditor') {
              const err = new Error('You have reached your usage limit')
              ;(err as any).statusCode = 403
              throw err
            }
          },
        },
      })
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/auditor-2'] } })

      const state = makeLoopState({ phase: 'coding', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await driveAuditSend(loop, state)

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState!.active).toBe(true)

      // The coding→auditing rotation is the only phase change; the fallback
      // advance is not a phase transition and must not write a row.
      const rows = loopTransitionsRepo.listForLoop(PROJECT_ID, state.loopName)
      expect(rows).toHaveLength(1)
      expect(rows[0].fromPhase).toBe('coding')
      expect(rows[0].toPhase).toBe('auditing')
    })

    test('an abort emitted by fallback re-dispatch leaves the loop in the auditor phase with the fallback prompt active', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [{ info: { role: 'user', finish: 'stop' }, parts: [{ type: 'text', text: 'prompt' }] }],
        },
      })
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/auditor-2'] } })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      // A provider-limit retry triggers the fallback, which aborts the session
      // internally and re-dispatches on the fallback model.
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })

      let afterState = loopService.getActiveState(state.loopName)
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(1)

      // The internal session.abort surfaces as a queued AbortError event after
      // the fallback prompt was already dispatched. It must be consumed, not
      // treated as an audit failure that rotates the loop back to coding.
      await loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'AbortError' } },
      })

      afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(1)

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(1)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'auditor-2' } })
    })

    test('duplicate provider-limit signals for the same failed prompt cause exactly one advance and one resend', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/auditor-2'] } })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      // One failed prompt emits both a retry status and an error event.
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })
      await loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } } },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(1)

      // Exactly one fallback resend — the duplicate signal must not advance again.
      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(1)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'auditor-2' } })
    })

    test('a later limit from the fallback prompt advances to the next fallback entry', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/a', 'fb/b'] } })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      // Original prompt fails: retry + error (duplicate) → one advance to index 1.
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })
      await loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } } },
      })

      let afterState = loopService.getActiveState(state.loopName)
      expect(afterState!.active).toBe(true)
      expect(afterState!.auditorFallbackIndex).toBe(1)

      // The fallback prompt begins its own lifecycle.
      await loop.tick({ type: 'session.status', properties: { sessionID: state.sessionId, status: { type: 'busy' } } })

      // A genuine limit from the fallback prompt must advance to the next entry.
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })

      afterState = loopService.getActiveState(state.loopName)
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(2)

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(2)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'a' } })
      expect(auditorCalls[1].params).toMatchObject({ model: { providerID: 'fb', modelID: 'b' } })
    })

    test('single primary retry then fallback busy then a single fallback retry advances exactly once more', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/a', 'fb/b'] } })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      // The primary emits ONLY a single retry-limit signal (no error companion),
      // so the companion coalescing budget stays at zero after the advance.
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })

      let afterState = loopService.getActiveState(state.loopName)
      expect(afterState!.active).toBe(true)
      expect(afterState!.auditorFallbackIndex).toBe(1)

      // The fallback prompt begins its own lifecycle.
      await loop.tick({ type: 'session.status', properties: { sessionID: state.sessionId, status: { type: 'busy' } } })

      // A single fallback retry must NOT be absorbed as the primary's companion;
      // it is a genuine failure of the replacement prompt and advances to #2.
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })

      afterState = loopService.getActiveState(state.loopName)
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(2)

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(2)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'a' } })
      expect(auditorCalls[1].params).toMatchObject({ model: { providerID: 'fb', modelID: 'b' } })
    })

    test('primary retry then fallback busy then a replacement-only provider-limit error advances to the next fallback', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/a', 'fb/b'] } })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      // The primary emits a single retry-limit signal: advance 0→1 and
      // re-dispatch on fb/a.
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })

      let afterState = loopService.getActiveState(state.loopName)
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(1)

      // The replacement prompt begins its own lifecycle, closing the companion window.
      await loop.tick({ type: 'session.status', properties: { sessionID: state.sessionId, status: { type: 'busy' } } })

      // The replacement fails with ONLY a provider-limit session.error (no
      // preceding retry). This is a genuine failure of the active replacement
      // prompt and must NOT be absorbed as the primary's companion.
      await loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } } },
      })

      afterState = loopService.getActiveState(state.loopName)
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(2)

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(2)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'a' } })
      expect(auditorCalls[1].params).toMatchObject({ model: { providerID: 'fb', modelID: 'b' } })
    })

    test('replacement-only provider-limit error with no remaining fallback exhausts the chain and terminates', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/a'] } })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      // The primary emits a single retry-limit signal: advance 0→1 and
      // re-dispatch on fb/a.
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })

      let afterState = loopService.getActiveState(state.loopName)
      expect(afterState!.active).toBe(true)
      expect(afterState!.auditorFallbackIndex).toBe(1)

      // The replacement begins its lifecycle, then fails with only a
      // provider-limit error — no remaining fallback, so the chain exhausts.
      await loop.tick({ type: 'session.status', properties: { sessionID: state.sessionId, status: { type: 'busy' } } })
      await loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } } },
      })

      const finalState = loopService.getAnyState(state.loopName)
      expect(finalState).not.toBeNull()
      expect(finalState!.active).toBe(false)
      expect(finalState!.status).toBe('errored')
      expect(finalState!.terminationReason).toContain('provider_limit:')
      expect(finalState!.auditorFallbackIndex).toBe(1)

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(1)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'a' } })
    })

    test('concurrent abort and replacement-busy events leave the loop auditing with one fallback dispatch', async () => {
      let releaseSend!: () => void
      const sendGate = new Promise<void>((resolve) => { releaseSend = resolve })
      let markSendStarted!: () => void
      const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve })

      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [{ info: { role: 'user', finish: 'stop' }, parts: [{ type: 'text', text: 'prompt' }] }],
          promptAsync: async (params: any) => {
            if (params?.agent === 'auditor-loop' && params?.model?.modelID === 'auditor-2') {
              markSendStarted()
              await sendGate
            }
          },
        },
      })
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/auditor-2'] } })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      // Begin the fallback re-dispatch without awaiting it. The provider-limit
      // handler holds the state lock, aborts the session (queuing an
      // AbortError), and sends the fallback prompt, held in-flight at sendGate.
      const retryP = loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })
      await sendStarted // fallback resend is in-flight; internalFallbackAborts is set

      // Queue the intentional-abort event, then the replacement busy, while the
      // fallback send is still pending. Without serialization the busy cleanup
      // clears the abort marker before the queued AbortError consumes it,
      // rotating the loop back to coding.
      const abortP = loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'AbortError' } },
      })
      const busyP = loop.tick({ type: 'session.status', properties: { sessionID: state.sessionId, status: { type: 'busy' } } })

      releaseSend()
      await Promise.all([retryP, abortP, busyP])

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(1)

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(1)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'auditor-2' } })
    })

    test('concurrent retry/error/busy delivery causes exactly one advancement and resend; a later limit advances normally', async () => {
      let releaseSend!: () => void
      const sendGate = new Promise<void>((resolve) => { releaseSend = resolve })
      let markSendStarted!: () => void
      const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve })

      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [{ info: { role: 'user', finish: 'stop' }, parts: [{ type: 'text', text: 'prompt' }] }],
          promptAsync: async (params: any) => {
            if (params?.agent === 'auditor-loop' && params?.model?.modelID === 'a') {
              markSendStarted()
              await sendGate
            }
          },
        },
      })
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/a', 'fb/b'] } })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      // The original failure emits a retry status and a duplicate error. The
      // retry advances 0→1 and sends fallback #1, held in-flight at sendGate.
      const retryP = loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })
      await sendStarted // fallback #1 is in-flight; coalescedLimitSessions is set

      // Queue the duplicate error, let it reach its lock acquisition (mirroring
      // production, where the duplicate error is dispatched well before the
      // replacement prompt's busy), then queue the busy.
      const errorP = loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } } },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const busyP = loop.tick({ type: 'session.status', properties: { sessionID: state.sessionId, status: { type: 'busy' } } })

      releaseSend()
      await Promise.all([retryP, errorP, busyP])

      let afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(1)

      // Exactly one resend — the duplicate error must not advance again.
      let auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(1)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'a' } })

      // A genuine limit from the replacement prompt still advances normally.
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })
      afterState = loopService.getActiveState(state.loopName)
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(2)

      auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(2)
      expect(auditorCalls[1].params).toMatchObject({ model: { providerID: 'fb', modelID: 'b' } })
    })

    function persistedAuditLimitMessage() {
      return [
        { info: { role: 'assistant', finish: 'error', error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } } }, parts: [] },
      ]
    }

    test('two pre-busy retry limit signals from one prompt cause exactly one advance and resend', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/a', 'fb/b'] } })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      // The primary emits TWO retry-limit signals for the SAME failed prompt
      // before the replacement (fb/a) begins its own lifecycle (no busy yet).
      // Both belong to the one failure and must advance the chain exactly once.
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(1)

      // Exactly one resend on fb/a — the second retry was coalesced, not advanced.
      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(1)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'a' } })
    })

    test('concurrent fallback dispatch discards the aborted turn handoff, then busy and idle run the audit phase exactly once', async () => {
      let releaseSend!: () => void
      const sendGate = new Promise<void>((resolve) => { releaseSend = resolve })
      let markSendStarted!: () => void
      const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve })

      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Found a bug: edge case' }] }],
          promptAsync: async (params: any) => {
            if (params?.agent === 'auditor-loop' && params?.model?.modelID === 'auditor-2') {
              markSendStarted()
              await sendGate
            }
          },
        },
      })
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/auditor-2'] } })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await recordAuditorHandoff(loop, state.sessionId)

      // Begin the fallback re-dispatch (held in-flight at sendGate, holding the
      // state lock). While it is held, the fast fallback emits busy then idle.
      const retryP = loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })
      await sendStarted // fallback resend is in-flight; idle-gate marker pending

      // busy clears the idle-gate pending marker synchronously, then both queue
      // behind the lock held by the fallback dispatch.
      const busyP = loop.tick({ type: 'session.status', properties: { sessionID: state.sessionId, status: { type: 'busy' } } })
      const idleP = loop.tick({ type: 'session.status', properties: { sessionID: state.sessionId, status: { type: 'idle' } } })

      releaseSend()
      await Promise.all([retryP, busyP, idleP])

      // The idle must NOT be discarded: the audit phase runs exactly once. The
      // handoff recorded before the abort belonged to the aborted turn, so the
      // internal resend discarded it and this run nudges the auditor for a new one
      // instead of completing the loop with a stale record.
      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(1)

      const handoffs = loopService.listHandoffs(state.loopName)
      expect(handoffs).toHaveLength(1)
      expect(handoffs[0].status).toBe('discarded')

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(2)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'auditor-2' } })
      expect(auditorCalls[1].params).toMatchObject({ model: { providerID: 'fb', modelID: 'auditor-2' } })
      const nudgeText = ((auditorCalls[1].params as any).parts as Array<{ text: string }>).map(part => part.text).join('\n')
      expect(nudgeText).toContain('You ended your turn without calling `loop-handoff`.')
    })

    test('persisted provider-limit in auditing assistant error attempts the configured fallback', async () => {
      const { client, calls } = createFakeForgeClient({
        session: { messages: async () => persistedAuditLimitMessage() },
      })
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/auditor-2'] } })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await loop.tick({ type: 'session.status', properties: { sessionID: state.sessionId, status: { type: 'idle' } } })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(1)

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(1)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'auditor-2' } })
    })

    test('persisted provider-limit in auditing assistant error with no fallback terminates', async () => {
      const { client } = createFakeForgeClient({
        session: { messages: async () => persistedAuditLimitMessage() },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await loop.tick({ type: 'session.status', properties: { sessionID: state.sessionId, status: { type: 'idle' } } })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')
      expect(afterState!.auditorFallbackIndex).toBe(0)
    })

    test('session.error ProviderAuthError on the current audit session re-dispatches on the fallback auditor model', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/auditor-2'] } })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'ProviderAuthError', data: { message: 'You have reached your usage limit' } } },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(1)

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(1)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'auditor-2' } })
    })

    test('stale (non-current) audit session provider-limit error with a configured fallback terminates and leaves auditorFallbackIndex at 0', async () => {
      const { client } = createFakeForgeClient()
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/auditor-2'] } })

      const auditSessionId = 'audit-session-id'
      const state = makeLoopState({ sessionId: auditSessionId, phase: 'auditing' })
      loop.start({ state })

      // Rotate to a new current audit session; the old one becomes stale.
      const newAuditSessionId = 'new-audit-session-id'
      loop.restart(state.loopName, {
        newState: makeLoopState({ sessionId: newAuditSessionId, phase: 'auditing' }),
        newSessionId: newAuditSessionId,
      })

      // The retired audit session emits a provider-limit error. It is stale, so
      // the choke point must decline to fall back and the loop must terminate.
      await loop.tick({
        type: 'session.error',
        properties: { sessionID: auditSessionId, error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } } },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')
      expect(afterState!.auditorFallbackIndex).toBe(0)
    })

    test('delayed old-prompt abort after busy is consumed; a limit after busy advances to the next entry', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/a', 'fb/b'] } })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      // Original failure: retry advances 0→1 and re-dispatches on fb/a.
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })

      let afterState = loopService.getActiveState(state.loopName)
      expect(afterState!.active).toBe(true)
      expect(afterState!.auditorFallbackIndex).toBe(1)

      // The replacement prompt begins its lifecycle; this closes the failed
      // prompt's companion window and clears the coalesced-limit record.
      await loop.tick({ type: 'session.status', properties: { sessionID: state.sessionId, status: { type: 'busy' } } })

      // A delayed AbortError from the failed prompt's internal abort arrives
      // after busy and is consumed (not treated as an audit failure).
      await loop.tick({ type: 'session.error', properties: { sessionID: state.sessionId, error: { name: 'AbortError' } } })

      afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(1)

      // A provider-limit error from the active replacement prompt is genuine and
      // advances to the next fallback entry.
      await loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } } },
      })

      afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(2)

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(2)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'a' } })
      expect(auditorCalls[1].params).toMatchObject({ model: { providerID: 'fb', modelID: 'b' } })
    })

    test('multiple internal aborts from one chain walk are all consumed without suppressing a later genuine abort', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [{ info: { role: 'user', finish: 'stop' }, parts: [{ type: 'text', text: 'prompt' }] }],
          promptAsync: async (params: any) => {
            if (params?.agent === 'auditor-loop' && params?.model?.modelID === 'a') {
              const err = new Error('You have reached your usage limit')
              ;(err as any).statusCode = 403
              throw err
            }
          },
        },
      })
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/a', 'fb/b'] } })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      // The failure triggers one chain walk: fallback #1 is limited (advance to
      // #2) and #2 succeeds. Each resend issues an internal abort on the same
      // reused session, so two AbortErrors are outstanding.
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })

      let afterState = loopService.getActiveState(state.loopName)
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(2)

      let auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(2)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'a' } })
      expect(auditorCalls[1].params).toMatchObject({ model: { providerID: 'fb', modelID: 'b' } })

      // Both internal AbortErrors must be consumed (not treated as audit failure).
      await loop.tick({ type: 'session.error', properties: { sessionID: state.sessionId, error: { name: 'AbortError' } } })
      await loop.tick({ type: 'session.error', properties: { sessionID: state.sessionId, error: { name: 'AbortError' } } })

      afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(2)

      // A third, genuine abort is no longer suppressed and rotates to coding.
      await loop.tick({ type: 'session.error', properties: { sessionID: state.sessionId, error: { name: 'AbortError' } } })
      afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('coding')
      expect(afterState!.auditorFallbackIndex).toBe(2)
    })

    test('a rejected internal abort leaves no marker, so a later genuine abort follows normal audit failure recovery', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [{ info: { role: 'user', finish: 'stop' }, parts: [{ type: 'text', text: 'prompt' }] }],
          abort: async () => {
            throw new Error('session already idle')
          },
        },
      })
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/auditor-2'] } })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      // The provider-limit retry triggers a fallback re-dispatch whose internal
      // abort REJECTS because the session is already idle.
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })

      let afterState = loopService.getActiveState(state.loopName)
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(1)

      // The replacement prompt is genuinely aborted before idle. The failed
      // internal abort must not have left a marker that consumes this AbortError,
      // so it follows normal audit failure recovery and rotates back to coding.
      await loop.tick({ type: 'session.error', properties: { sessionID: state.sessionId, error: { name: 'AbortError' } } })

      afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('coding')

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(1)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'auditor-2' } })
    })

    test('a queued abort-generated idle during fallback settlement is suppressed once the replacement prompt is pending', async () => {
      let loopRef: Loop | null = null
      let queuedIdle: Promise<void> | null = null
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => makeCodingIdleMessages(),
          abort: async (params: any) => {
            // The internal abort surfaces as a session idle for the aborted (failed)
            // prompt while the fallback settle delay is in progress. The failed
            // prompt's pending marker is already cleared by sendLoopPrompt, so this
            // idle passes the pre-lock gate and queues behind the state lock held by
            // the fallback dispatch.
            if (loopRef) queuedIdle = loopRef.tick({ type: 'session.status', properties: { sessionID: params.sessionID, status: { type: 'idle' } } })
          },
          promptAsync: async (params: any) => {
            if (params?.agent === 'auditor-loop' && params?.model?.modelID === 'auditor') {
              const err = new Error('You have reached your usage limit')
              ;(err as any).statusCode = 403
              throw err
            }
          },
        },
      })
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/auditor-2'] } })
      loopRef = loop

      const state = makeLoopState({ phase: 'coding', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await driveAuditSend(loop, state)
      if (queuedIdle) await queuedIdle

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(1)

      // Exactly one fallback dispatch: the replacement prompt. The queued stale
      // idle must not run the auditing phase again on the reused session.
      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(2)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'test', modelID: 'auditor' } })
      expect(auditorCalls[1].params).toMatchObject({ model: { providerID: 'fb', modelID: 'auditor-2' } })
    })

    test('an idle-only internal abort does not leave a marker that consumes a later genuine replacement abort', async () => {
      let loopRef: Loop | null = null
      let queuedIdle: Promise<void> | null = null
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [{ info: { role: 'user', finish: 'stop' }, parts: [{ type: 'text', text: 'prompt' }] }],
          abort: async (params: any) => {
            // The internal abort surfaces as a session idle (no AbortError). It
            // is queued during the settle delay and will be suppressed once the
            // replacement prompt is pending.
            if (loopRef) queuedIdle = loopRef.tick({ type: 'session.status', properties: { sessionID: params.sessionID, status: { type: 'idle' } } })
          },
        },
      })
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/auditor-2'] } })
      loopRef = loop

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      // The provider-limit retry triggers a fallback re-dispatch whose internal
      // abort emits only a `session.status: idle` (no AbortError).
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })
      if (queuedIdle) await queuedIdle

      let afterState = loopService.getActiveState(state.loopName)
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(1)

      const auditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(auditorCalls).toHaveLength(1)
      expect(auditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'auditor-2' } })

      // The replacement prompt is genuinely aborted by the user/provider. The
      // idle-only internal abort must not have left a marker that consumes this
      // AbortError, so it follows normal audit-failure recovery and rotates back
      // to coding instead of leaving the loop auditing a stopped prompt.
      await loop.tick({ type: 'session.error', properties: { sessionID: state.sessionId, error: { name: 'AbortError' } } })

      afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('coding')
      expect(afterState!.auditorFallbackIndex).toBe(1)
    })

    test('a provider-limit fallback advance is reset to 0 by the next successful audit, restoring primary model and variant', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => makeCodingIdleMessages(),
        },
      })
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/auditor-2'] } })

      // A persistent bug finding keeps audits dirty so a successful audit rotates
      // back to coding instead of terminating, giving us a second audit dispatch.
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: 'test-loop',
        file: 'src/fallback-reset.ts',
        line: 1,
        severity: 'bug',
        description: 'persistent issue',
      })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 0, auditorVariant: 'audit-high' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      // First audit: the primary hits a provider limit (advances 0→1) and
      // re-dispatches on the fallback.
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })

      let afterState = loopService.getActiveState(state.loopName)
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('auditing')
      expect(afterState!.auditorFallbackIndex).toBe(1)

      // The fallback prompt completes with a dirty audit result, which rotates
      // back to coding and must reset the persisted index to 0.
      await recordAuditorHandoff(loop, state.sessionId)
      await loop.tick({ type: 'session.status', properties: { sessionID: state.sessionId, status: { type: 'busy' } } })
      await loop.tick({ type: 'session.status', properties: { sessionID: state.sessionId, status: { type: 'idle' } } })

      afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('coding')
      expect(afterState!.auditorFallbackIndex).toBe(0)

      const firstAuditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      expect(firstAuditorCalls).toHaveLength(1)
      expect(firstAuditorCalls[0].params).toMatchObject({ model: { providerID: 'fb', modelID: 'auditor-2' } })

      // The dirty audit rotated to a fresh coding session.
      const newSessionId = afterState!.sessionId
      expect(newSessionId).not.toBe(state.sessionId)
      loopService.registerLoopSession(newSessionId, state.loopName)

      // Second audit: coding idles again and must dispatch on the PRIMARY auditor
      // model with the configured auditorVariant restored (index is back to 0).
      await recordCoderHandoff(loop, newSessionId)
      await loop.tick({ type: 'session.status', properties: { sessionID: newSessionId, status: { type: 'busy' } } })
      await loop.tick({ type: 'session.status', properties: { sessionID: newSessionId, status: { type: 'idle' } } })

      const allAuditorCalls = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
      const lastAuditor = allAuditorCalls[allAuditorCalls.length - 1]
      expect(lastAuditor.params).toMatchObject({ model: { providerID: 'test', modelID: 'auditor' }, variant: 'audit-high' })
    })
  })

  describe('child session error resolution via ancestor chain', () => {
    test('child session session.error with provider limit terminates the owning loop', async () => {
      const { client, calls } = createFakeForgeClient()
      const parentLookup = new Map<string, string>()
      const { loop } = buildRuntime({
        client,
        getParentSessionId: async (sid: string) => parentLookup.get(sid) ?? null,
      })

      const codingSessionId = 'coding-session-id'
      const state = makeLoopState({ sessionId: codingSessionId, phase: 'coding' })
      loop.start({ state })

      // Register a child session whose parent is the coding session
      const childSessionId = 'child-session-id'
      parentLookup.set(childSessionId, codingSessionId)

      // Child session emits a provider-limit error
      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: childSessionId,
          error: { name: 'ProviderAuthError', data: { message: 'You have reached your usage limit' } },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })

    test('child session session.error without provider limit does not terminate', async () => {
      const { client, calls } = createFakeForgeClient()
      const parentLookup = new Map<string, string>()
      const { loop } = buildRuntime({
        client,
        getParentSessionId: async (sid: string) => parentLookup.get(sid) ?? null,
      })

      const codingSessionId = 'coding-session-id'
      const state = makeLoopState({ sessionId: codingSessionId, phase: 'coding' })
      loop.start({ state })

      const childSessionId = 'child-session-id'
      parentLookup.set(childSessionId, codingSessionId)

      // Child session emits a non-provider-limit error
      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: childSessionId,
          error: { name: 'UnknownError', data: { message: 'something went wrong' } },
        },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBe(0)
    })

    test('transient ancestry lookup rejection does not reject session.error handling and leaves loop running', async () => {
      const fake = createFakeForgeClient()
      const { loop, logs } = buildRuntime({
        client: fake.client,
        getParentSessionId: async () => { throw new Error('transient ancestry failure') },
      })
      const state = makeLoopState({ sessionId: 'coding-session-id', phase: 'coding' })
      loopService.setState(state.loopName, state)

      await expect(
        loop.tick({
          type: 'session.error',
          properties: {
            sessionID: 'child-session-id',
            error: { name: 'ProviderAuthError', data: { message: 'You have reached your usage limit' } },
          },
        }),
      ).resolves.toBeUndefined()

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)

      const abortCalls = fake.calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBe(0)
      expect(logs.some(l => l.level === 'error' && l.message.includes('ancestry lookup failed'))).toBe(true)
    })
  })

  describe('reverse index lifecycle', () => {
    test('unregisterSessionReverseIndex removes session from reverse index', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ sessionId: 'session-1', phase: 'coding' })
      loop.start({ state })

      // Register session-2 in reverse index (simulating a path that doesn't call start)
      loop.registerSessionReverseIndex('session-2', state.loopName)

      // session-2 should resolve to the loop via reverse index
      // (verified by emitting an error that should be handled)
      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: 'session-2',
          error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } },
        },
      })

      // The error should have terminated the loop because session-2 resolves via reverse index
      const afterRegister = loopService.getAnyState(state.loopName)
      expect(afterRegister).not.toBeNull()
      expect(afterRegister!.active).toBe(false)
      expect(afterRegister!.terminationReason).toContain('provider_limit:')

      // Track abort calls before the unregister test
      const abortCallsBefore = calls.filter(c => c.method === 'session.abort').length

      // Restart the loop to test unregister
      const newState = makeLoopState({ sessionId: 'session-3', phase: 'coding' })
      loop.restart(state.loopName, { newState, newSessionId: 'session-3' })

      // Register session-4 and then unregister it
      loop.registerSessionReverseIndex('session-4', state.loopName)
      loop.unregisterSessionReverseIndex('session-4')

      // session-4 error should be ignored (not resolved to any loop)
      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: 'session-4',
          error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } },
        },
      })

      const afterUnregister = loopService.getActiveState(state.loopName)
      expect(afterUnregister).not.toBeNull()
      expect(afterUnregister!.active).toBe(true)

      // No new abort calls should have been made after the unregister test
      const abortCallsAfter = calls.filter(c => c.method === 'session.abort').length
      expect(abortCallsAfter).toBe(abortCallsBefore)
    })

    test('restart retains old session in reverse index', async () => {
      const { client, calls } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })

      const originalSessionId = 'original-session-id'
      const state = makeLoopState({ sessionId: originalSessionId, phase: 'coding' })
      loop.start({ state })

      // Restart with new session
      const newSessionId = 'new-session-id'
      const newState = makeLoopState({ sessionId: newSessionId, phase: 'coding' })
      loop.restart(state.loopName, { newState, newSessionId: newSessionId })

      // Old session should still resolve via reverse index
      await loop.tick({
        type: 'session.error',
        properties: {
          sessionID: originalSessionId,
          error: { name: 'ProviderError', data: { message: 'You have reached your usage limit' } },
        },
      })

      const afterState = loopService.getAnyState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(false)
      expect(afterState!.status).toBe('errored')
      expect(afterState!.terminationReason).toContain('provider_limit:')

      const abortCalls = calls.filter(c => c.method === 'session.abort')
      expect(abortCalls.length).toBeGreaterThan(0)
    })
  })

  describe('queued-prompt idle suppression', () => {
    test('idle is ignored while a prompt is queued, then resumes once delivered', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Done.' }] },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'coding', totalSections: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)

      recordInboxEnqueued(state.sessionId, 'inbox-1')
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'idle' } },
      })

      expect(loopService.getActiveState(state.loopName)!.phase).toBe('coding')
      expect(calls.filter(c => c.method === 'session.promptAsync').length).toBe(0)

      recordInboxSettled(state.sessionId, 'inbox-1')
      await recordCoderHandoff(loop, state.sessionId)
      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'idle' } },
      })

      expect(loopService.getActiveState(state.loopName)!.phase).toBe('auditing')
    })

    test('coding idle does not nudge while a prompt is queued', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'user' }, parts: [{ type: 'text', text: 'queued prompt' }] },
          ],
        },
      })
      const { loop, logs } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'coding' })
      loopService.setState(state.loopName, state)

      recordInboxEnqueued(state.sessionId, 'inbox-1')

      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'idle' } },
      })

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('coding')
      expect(calls.filter(c => c.method === 'session.promptAsync').length).toBe(0)
      expect(logs.some(l => l.message.includes('[idle-gate]') && l.message.includes('a prompt is still queued'))).toBe(true)
    })
  })

  describe('active-session idle suppression', () => {
    test('coding idle does not nudge while the session is busy', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'user' }, parts: [{ type: 'text', text: 'in flight' }] },
          ],
          status: async () => ({ 'loop-session-id': { type: 'busy' } }),
        },
      })
      const { loop, logs } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'coding' })
      loopService.setState(state.loopName, state)

      vi.useFakeTimers()
      try {
        await loop.tick({
          type: 'session.status',
          properties: { sessionID: state.sessionId, status: { type: 'idle' } },
        })
        await vi.advanceTimersByTimeAsync(2000)
      } finally {
        vi.useRealTimers()
      }

      const afterState = loopService.getActiveState(state.loopName)
      expect(afterState).not.toBeNull()
      expect(afterState!.active).toBe(true)
      expect(afterState!.phase).toBe('coding')
      expect(calls.filter(c => c.method === 'session.promptAsync').length).toBe(0)
      expect(logs.some(l => l.message.includes('Loop sessions are still busy or retrying'))).toBe(true)
    })

    test('coding idle sends the full prompt nudge once the session reports idle', async () => {
      let statusType: 'busy' | 'idle' = 'busy'
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'user' }, parts: [{ type: 'text', text: 'in flight' }] },
          ],
          status: async () => ({ 'loop-session-id': { type: statusType } }),
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'coding' })
      loopService.setState(state.loopName, state)

      vi.useFakeTimers()
      try {
        await loop.tick({
          type: 'session.status',
          properties: { sessionID: state.sessionId, status: { type: 'idle' } },
        })
        expect(calls.filter(c => c.method === 'session.promptAsync').length).toBe(0)

        statusType = 'idle'
        await loop.tick({
          type: 'session.status',
          properties: { sessionID: state.sessionId, status: { type: 'idle' } },
        })
        await vi.advanceTimersByTimeAsync(2000)
      } finally {
        vi.useRealTimers()
      }

      const codePrompts = calls.filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
      expect(codePrompts.length).toBe(1)
    })
  })

  describe('handoff turn-end gates', () => {
    function promptTexts(calls: RecordedCall[], sessionID: string, agent?: 'code' | 'auditor-loop'): string[] {
      return calls
        .filter(c => c.method === 'session.promptAsync'
          && (c.params as any)?.sessionID === sessionID
          && (agent === undefined || (c.params as any)?.agent === agent))
        .map(c => ((c.params as any)?.parts as Array<{ text?: string }> | undefined)?.[0]?.text ?? '')
    }

    function handoffNudgeTexts(calls: RecordedCall[], sessionID: string, agent?: 'code' | 'auditor-loop'): string[] {
      return promptTexts(calls, sessionID, agent).filter(text => text.includes('You ended your turn without calling `loop-handoff`.'))
    }

    test('a rotation that reuses the same coder session and iteration starts a fresh nudge budget of three', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'turn reply' }] },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'coding', sessionId: 'coder-1', totalSections: 0, iteration: 1, maxIterations: 5 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession('coder-1', state.loopName)

      const runTurn = async (sessionID: string): Promise<void> => {
        await loop.tick({ type: 'session.status', properties: { status: { type: 'busy' }, sessionID } })
        await loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID } })
      }

      await runTurn('coder-1')
      await runTurn('coder-1')
      expect(handoffNudgeTexts(calls, 'coder-1', 'code')).toHaveLength(2)

      // Rotate to the auditor at the same iteration and hand the coder back as the
      // standby, so the audit-failure recovery reuses that same session and iteration.
      loopService.replaceSession(state.loopName, { newSessionId: 'audit-1', phase: 'auditing' })
      loopService.registerLoopSession('audit-1', state.loopName)
      loopService.setStandbySessionId(state.loopName, 'coder-1')

      await loop.tick({
        type: 'session.error',
        properties: { sessionID: 'audit-1', error: { name: 'UnknownError', data: { message: 'auditor crashed' } } },
      })

      const rotated = loopService.getActiveState(state.loopName)!
      expect(rotated.phase).toBe('coding')
      expect(rotated.sessionId).toBe('coder-1')
      expect(rotated.iteration).toBe(1)

      for (let turn = 0; turn < 3; turn++) await runTurn('coder-1')
      expect(loopService.getActiveState(state.loopName)!.phase).toBe('coding')
      expect(handoffNudgeTexts(calls, 'coder-1', 'code')).toHaveLength(5)

      await runTurn('coder-1')

      const finished = loopService.getAnyState(state.loopName)!
      expect(finished.active).toBe(false)
      expect(finished.terminationReason).toBe('handoff_missing')
    })

    test('a post-action turn whose last assistant message is unfinished gets the short nudge, not the full workflow prompt', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'length' }, parts: [{ type: 'text', text: 'Merge steps: ' }] },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'post_action' })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID: state.sessionId } })

      const prompts = promptTexts(calls, state.sessionId)
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toBe(buildHandoffNudgePrompt('post_action'))

      const afterState = loopService.getActiveState(state.loopName)!
      expect(afterState.active).toBe(true)
      expect(afterState.phase).toBe('post_action')
    })

    test('an audit session error discards a pending auditor handoff so the next coder handoff is not a replacement', async () => {
      const { client } = createFakeForgeClient()
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 1 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await recordAuditorHandoff(loop, state.sessionId)

      await loop.tick({
        type: 'session.error',
        properties: { sessionID: state.sessionId, error: { name: 'UnknownError', data: { message: 'auditor crashed' } } },
      })

      const handoffs = loopService.listHandoffs(state.loopName)
      expect(handoffs).toHaveLength(1)
      expect(handoffs[0]).toMatchObject({ role: 'auditor', sessionId: state.sessionId, status: 'discarded' })

      const coderSessionId = loopService.getActiveState(state.loopName)!.sessionId
      expect(coderSessionId).not.toBe(state.sessionId)
      const result = await loop.recordHandoff({
        sessionId: coderSessionId,
        tool: LOOP_HANDOFF_TOOL_NAME,
        args: {
          changes: [{ summary: 'Fixed the auditor failure', reason: 'Restores green checks' }],
          verification: [{ command: 'pnpm test', cwd: '.', outcome: 'pass', changedAfter: false }],
        },
      })
      expect(result).toEqual({ ok: true, replaced: false })
    })

    test('an internal auditor resend for a provider limit discards the aborted turn handoff', async () => {
      const { client } = createFakeForgeClient()
      const { loop } = buildRuntime({ client, loopConfig: { auditorFallbackModels: ['fb/auditor-2'] } })

      const state = makeLoopState({ phase: 'auditing', totalSections: 0, auditCount: 1 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)

      await recordAuditorHandoff(loop, state.sessionId)

      await loop.tick({
        type: 'session.status',
        properties: { sessionID: state.sessionId, status: { type: 'retry', attempt: 2, message: 'You have reached your usage limit', next: 60000 } },
      })

      const handoffs = loopService.listHandoffs(state.loopName)
      expect(handoffs).toHaveLength(1)
      expect(handoffs[0].status).toBe('discarded')
      expect(loopService.getActiveState(state.loopName)!.auditorFallbackIndex).toBe(1)
    })

    test('a clean section audit whose pending handoff has no summary is discarded and the auditor is nudged instead of completing the section', async () => {
      const { client, calls } = createFakeForgeClient({
        session: {
          messages: async () => [
            { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'Section reviewed.' }] },
          ],
        },
      })
      const { loop } = buildRuntime({ client })

      const state = makeLoopState({ phase: 'auditing', totalSections: 1, currentSectionIndex: 0, auditCount: 0 })
      loopService.setState(state.loopName, state)
      loopService.registerLoopSession(state.sessionId, state.loopName)
      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        sections: [{ index: 0, title: 'Section one', content: 'Section one content' }],
      })
      loopService.startSection(state.loopName, 0)

      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName: state.loopName,
        file: 'src/section.ts',
        line: 3,
        severity: 'bug',
        description: 'Section bug',
        sectionIndex: 0,
      })
      await recordAuditorHandoff(loop, state.sessionId)
      // The auditor resolves its last blocking bug after recording the dirty handoff,
      // leaving a clean section with a summary-less record behind.
      reviewFindingsRepo.delete(PROJECT_ID, 'src/section.ts', 3)

      await loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID: state.sessionId } })

      const handoffs = loopService.listHandoffs(state.loopName)
      expect(handoffs).toHaveLength(1)
      expect(handoffs[0].status).toBe('discarded')

      const afterState = loopService.getActiveState(state.loopName)!
      expect(afterState.active).toBe(true)
      expect(afterState.phase).toBe('auditing')
      const section = loopService.getSectionPlan(afterState, 0)!
      expect(section.status).not.toBe('completed')

      const auditorPrompts = promptTexts(calls, state.sessionId, 'auditor-loop')
      expect(auditorPrompts).toHaveLength(1)
      expect(auditorPrompts[0]).toContain('You ended your turn without calling `loop-handoff`.')
    })

    test('a failed nudge retry is abandoned when the phase turned over before it fired', async () => {
      vi.useFakeTimers()
      try {
        const { client, calls } = createFakeForgeClient({
          session: {
            messages: async () => [
              { info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'turn reply' }] },
            ],
            promptAsync: async (params: any) => {
              if (params?.agent === 'code') throw new Error('send failed')
            },
          },
        })
        const { loop } = buildRuntime({ client })

        const state = makeLoopState({ phase: 'coding', sessionId: 'coder-1', totalSections: 0 })
        loopService.setState(state.loopName, state)
        loopService.registerLoopSession('coder-1', state.loopName)

        await loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID: 'coder-1' } })
        const attemptsAfterNudge = promptTexts(calls, 'coder-1', 'code').length
        expect(attemptsAfterNudge).toBeGreaterThan(0)

        loopService.replaceSession(state.loopName, { newSessionId: 'audit-1', phase: 'auditing' })
        loopService.registerLoopSession('audit-1', state.loopName)
        await vi.advanceTimersByTimeAsync(2500)

        expect(promptTexts(calls, 'coder-1', 'code')).toHaveLength(attemptsAfterNudge)
      } finally {
        vi.useRealTimers()
      }
    })

    test('an errored audit defers while a child session is still busy', async () => {
      vi.useFakeTimers()
      try {
        let statuses: Record<string, { type?: string }> = { 'child-1': { type: 'busy' } }
        const { client } = createFakeForgeClient({
          session: {
            status: async () => statuses,
            messages: async (params: any) => (params?.sessionID === 'audit-1'
              ? [{
                  info: { role: 'assistant', finish: 'stop', error: { name: 'UnknownError', data: { message: 'auditor crashed' } } },
                  parts: [],
                }]
              : []),
          },
        })
        const { loop } = buildRuntime({
          client,
          getParentSessionId: async (sessionId) => (sessionId === 'child-1' ? 'audit-1' : null),
        })

        const state = makeLoopState({ phase: 'auditing', sessionId: 'audit-1', totalSections: 0, auditCount: 1 })
        loopService.setState(state.loopName, state)
        loopService.registerLoopSession('audit-1', state.loopName)

        await loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID: 'audit-1' } })

        const deferred = loopService.getActiveState(state.loopName)!
        expect(deferred.active).toBe(true)
        expect(deferred.phase).toBe('auditing')
        expect(deferred.sessionId).toBe('audit-1')
        expect(loopTransitionsRepo.listForLoop(PROJECT_ID, state.loopName).some(row => row.eventType === 'audit-error')).toBe(false)

        statuses = {}
        await vi.advanceTimersByTimeAsync(1700)

        const rotated = loopService.getActiveState(state.loopName)!
        expect(rotated.phase).toBe('coding')
        const rows = loopTransitionsRepo.listForLoop(PROJECT_ID, state.loopName)
        expect(rows.some(row => row.eventType === 'audit-error' && row.fromPhase === 'auditing' && row.toPhase === 'coding')).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('code-graph snapshots', () => {
    type ExecResult = { exitCode: number; stdout: string; stderr: string }

    function fakeSandboxManager(exec: (command: string) => Promise<ExecResult>): LoopRuntimeDeps['sandboxManager'] {
      return {
        getActive: () => ({ containerName: 'codegraph-container' }),
        runtime: { exec: (_container: string, command: string) => exec(command) },
      } as unknown as LoopRuntimeDeps['sandboxManager']
    }

    function successfulExec(command: string): ExecResult {
      if (command === 'command -v codegraph') return { exitCode: 0, stdout: '/usr/local/bin/codegraph\n', stderr: '' }
      if (command.includes('codegraph.db')) return { exitCode: 0, stdout: 'present\n', stderr: '' }
      if (command.includes('codegraph affected')) {
        return { exitCode: 0, stdout: JSON.stringify({ affectedTests: ['test/a.test.ts'] }), stderr: '' }
      }
      if (command.includes('codegraph node')) return { exitCode: 0, stdout: 'function fromSectionFile() {}', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    function seedSectionedAudit(loopName: string, sessionId: string, worktreeDir: string, phase: LoopState['phase'] = 'auditing'): void {
      mkdirSync(join(worktreeDir, 'src'), { recursive: true })
      writeFileSync(join(worktreeDir, 'src/a.ts'), 'export const a = 1\n')
      writeFileSync(join(worktreeDir, 'src/b.ts'), 'export const b = 1\n')
      const state = makeState({
        loopName,
        sessionId,
        phase,
        totalSections: 2,
        currentSectionIndex: 0,
        auditCount: 0,
        iteration: 1,
        maxIterations: 5,
        sandbox: true,
        worktreeDir,
      })
      loopService.setState(loopName, state)
      loopService.registerLoopSession(sessionId, loopName)
      sectionPlansRepo.bulkInsert({
        projectId: PROJECT_ID,
        loopName,
        sections: [
          { index: 0, title: 'Section 1', content: '## Phase 1\n### Files\n- `src/a.ts`' },
          { index: 1, title: 'Section 2', content: '## Phase 2\n### Files\n- `src/a.ts` (new)\n- `src/b.ts`' },
        ],
      })
      sectionPlansRepo.setStatus(PROJECT_ID, loopName, 0, 'in_progress')
    }

    function codePrompts(calls: RecordedCall[]): string[] {
      return calls
        .filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'code')
        .map(c => (c.params as any)?.parts?.[0]?.text ?? '')
    }

    function advanceToSectionTwo(loop: Loop, sessionId: string): Promise<void> {
      return (async () => {
        await recordAuditorHandoff(loop, sessionId, { summary: { done: ['Did it'], deviations: [], followUps: [] } })
        await loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID: sessionId } })
      })()
    }

    test('clean section advance snapshots section 2 and points its first prompt at the report', async () => {
      const worktreeDir = mkdtempSync(join(tempDir, 'section-cg-'))
      const { client, calls } = createFakeForgeClient({
        session: { messages: async () => [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'clear' }] }] },
      })
      const { loop } = createRuntime({
        client,
        sandboxManager: fakeSandboxManager(async (command) => successfulExec(command)),
      })

      const loopName = 'codegraph-section'
      seedSectionedAudit(loopName, 'codegraph-audit', worktreeDir)
      await advanceToSectionTwo(loop, 'codegraph-audit')

      const after = loopService.getActiveState(loopName)!
      expect(after.phase).toBe('coding')
      expect(after.currentSectionIndex).toBe(1)

      const prompt = codePrompts(calls).at(-1) ?? ''
      expect(prompt).toContain('## Code graph')
      expect(prompt).toContain('.forge/codegraph/section-2.md')

      const row = sectionPlansRepo.get(PROJECT_ID, loopName, 1)!
      expect(row.codeGraph).toContain('# Code graph: section 2: Section 2')
      const report = readFileSync(join(worktreeDir, '.forge/codegraph/section-2.md'), 'utf8')
      expect(report).toBe(row.codeGraph)
      expect(report).toContain('test/a.test.ts')
    })

    test('disabled loop.codeGraph leaves the prompt without a pointer and still advances', async () => {
      const worktreeDir = mkdtempSync(join(tempDir, 'section-cg-off-'))
      const { client, calls } = createFakeForgeClient({
        session: { messages: async () => [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'clear' }] }] },
      })
      const { loop } = createRuntime({
        client,
        loopConfig: { loop: { enabled: true, codeGraph: { enabled: false } } },
        sandboxManager: fakeSandboxManager(async (command) => successfulExec(command)),
      })

      const loopName = 'codegraph-disabled'
      seedSectionedAudit(loopName, 'codegraph-off-audit', worktreeDir)
      await advanceToSectionTwo(loop, 'codegraph-off-audit')

      expect(loopService.getActiveState(loopName)!.currentSectionIndex).toBe(1)
      expect(codePrompts(calls).at(-1) ?? '').not.toContain('## Code graph')
      expect(sectionPlansRepo.get(PROJECT_ID, loopName, 1)!.codeGraph).toBeNull()
    })

    test('a failing sandbox exec leaves the prompt without a pointer and still advances', async () => {
      const worktreeDir = mkdtempSync(join(tempDir, 'section-cg-fail-'))
      const { client, calls } = createFakeForgeClient({
        session: { messages: async () => [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'clear' }] }] },
      })
      const { loop } = createRuntime({
        client,
        sandboxManager: fakeSandboxManager(async () => {
          throw new Error('sandbox unavailable')
        }),
      })

      const loopName = 'codegraph-failing'
      seedSectionedAudit(loopName, 'codegraph-fail-audit', worktreeDir)
      await advanceToSectionTwo(loop, 'codegraph-fail-audit')

      expect(loopService.getActiveState(loopName)!.currentSectionIndex).toBe(1)
      expect(codePrompts(calls).at(-1) ?? '').not.toContain('## Code graph')
      expect(sectionPlansRepo.get(PROJECT_ID, loopName, 1)!.codeGraph).toBeNull()
    })

    function initAttemptWorktree(prefix: string): string {
      const dir = mkdtempSync(join(tempDir, prefix))
      execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir, encoding: 'utf-8' })
      writeFileSync(join(dir, 'base.txt'), 'base\n')
      execSync('git add -A && git commit -qm init', { cwd: dir, encoding: 'utf-8' })
      return dir
    }

    function auditorPrompts(calls: RecordedCall[]): string[] {
      return calls
        .filter(c => c.method === 'session.promptAsync' && (c.params as any)?.agent === 'auditor-loop')
        .map(c => (c.params as any)?.parts?.[0]?.text ?? '')
    }

    function assistantIdleMessages(): Array<{ info: { role: string; finish: string }; parts: Array<{ type: string; text: string }> }> {
      return [{ info: { role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text: 'done' }] }]
    }

    test('snapshot B stores the attempt report and points the audit prompt at it', async () => {
      const worktreeDir = initAttemptWorktree('attempt-cg-')
      const { client, calls } = createFakeForgeClient({ session: { messages: async () => assistantIdleMessages() } })
      const loopAttemptsRepo = createLoopAttemptsRepo(db)
      const { loop } = createRuntime({
        client,
        loopAttemptsRepo,
        sandboxManager: fakeSandboxManager(async (command) => successfulExec(command)),
      })

      const loopName = 'codegraph-attempt'
      const sessionId = 'codegraph-attempt-coder'
      seedSectionedAudit(loopName, sessionId, worktreeDir, 'coding')
      writeFileSync(join(worktreeDir, 'src/a.ts'), 'export const a = 2\n')

      await recordCoderHandoff(loop, sessionId)
      await loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID: sessionId } })

      expect(loopService.getActiveState(loopName)!.phase).toBe('auditing')
      const attempt = loopAttemptsRepo.latest(PROJECT_ID, loopName, 'section:0')!
      expect(attempt.codeGraph).toContain('# Code graph: audit attempt 1 (section:0)')
      expect(attempt.codeGraph).toContain('src/a.ts')
      expect(attempt.codeGraph).toContain('test/a.test.ts')

      const prompt = auditorPrompts(calls).at(-1) ?? ''
      expect(prompt).toContain('## Code graph')
      expect(prompt).toContain('.forge/codegraph/audit-section-0-attempt-1.md')
      expect(readFileSync(join(worktreeDir, '.forge/codegraph/audit-section-0-attempt-1.md'), 'utf8')).toBe(attempt.codeGraph)
    })

    test('a dirty audit sends a coder follow-up that still points at the report', async () => {
      const worktreeDir = initAttemptWorktree('attempt-cg-dirty-')
      const { client, calls } = createFakeForgeClient({ session: { messages: async () => assistantIdleMessages() } })
      const loopAttemptsRepo = createLoopAttemptsRepo(db)
      const { loop } = createRuntime({
        client,
        loopAttemptsRepo,
        sandboxManager: fakeSandboxManager(async (command) => successfulExec(command)),
      })

      const loopName = 'codegraph-attempt-dirty'
      const coderSessionId = 'codegraph-dirty-coder'
      seedSectionedAudit(loopName, coderSessionId, worktreeDir, 'coding')
      writeFileSync(join(worktreeDir, 'src/a.ts'), 'export const a = 2\n')

      await recordCoderHandoff(loop, coderSessionId)
      await loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID: coderSessionId } })

      const auditSessionId = loopService.getActiveState(loopName)!.sessionId
      expect(auditSessionId).not.toBe(coderSessionId)
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/a.ts',
        line: 1,
        severity: 'bug',
        description: 'still broken',
        sectionIndex: 0,
      })
      await recordAuditorHandoff(loop, auditSessionId, { notes: 'bug remains' })
      await loop.tick({ type: 'session.status', properties: { status: { type: 'busy' }, sessionID: auditSessionId } })
      await loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID: auditSessionId } })

      expect(loopService.getActiveState(loopName)!.phase).toBe('coding')
      const prompt = codePrompts(calls).at(-1) ?? ''
      expect(prompt).toContain('## Code graph')
      expect(prompt).toContain('.forge/codegraph/audit-section-0-attempt-1.md')
    })

    test('a failing sandbox exec still rotates to audit without a pointer', async () => {
      const worktreeDir = initAttemptWorktree('attempt-cg-fail-')
      const { client, calls } = createFakeForgeClient({ session: { messages: async () => assistantIdleMessages() } })
      const loopAttemptsRepo = createLoopAttemptsRepo(db)
      const { loop } = createRuntime({
        client,
        loopAttemptsRepo,
        sandboxManager: fakeSandboxManager(async () => {
          throw new Error('sandbox unavailable')
        }),
      })

      const loopName = 'codegraph-attempt-failing'
      const sessionId = 'codegraph-attempt-fail-coder'
      seedSectionedAudit(loopName, sessionId, worktreeDir, 'coding')
      writeFileSync(join(worktreeDir, 'src/a.ts'), 'export const a = 2\n')

      await recordCoderHandoff(loop, sessionId)
      await loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID: sessionId } })

      expect(loopService.getActiveState(loopName)!.phase).toBe('auditing')
      expect(loopAttemptsRepo.latest(PROJECT_ID, loopName, 'section:0')!.codeGraph).toBeNull()
      expect(auditorPrompts(calls).at(-1) ?? '').not.toContain('## Code graph')
    })
  })
})
