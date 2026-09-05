import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import { createLoopTransitionsRepo } from '../../src/storage/repos/loop-transitions-repo'
import { createLoopAttemptsRepo } from '../../src/storage/repos/loop-attempts-repo'
import { createLoopService, type LoopService } from '../../src/loop/service'
import type { LoopState } from '../../src/loop/state'
import { createLoop, type Loop } from '../../src/loop/runtime'
import { sessionsAwaitingBusy } from '../../src/loop/idle-gate'
import { __resetInFlightGuard } from '../../src/loop/in-flight-guard'
import type { Logger, PluginConfig } from '../../src/types'
import { createFakeForgeClient, type RecordedCall } from '../helpers/fake-client'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import { captureAuditSnapshot, compareAuditSnapshots, deleteAuditSnapshot } from '../../src/utils/audit-snapshot'

vi.mock('../../src/utils/audit-snapshot', () => ({
  captureAuditSnapshot: vi.fn(),
  compareAuditSnapshots: vi.fn(),
  deleteAuditSnapshot: vi.fn(),
}))

const PROJECT_ID = 'test-project'
const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)
const COMMIT_C = 'c'.repeat(40)
const DELTA_SUMMARY = ' src/ledger.ts | 12 ++++++-----\n1 file changed, 8 insertions, 4 deletions'
const FIRST_AUDIT_FALLBACK = 'First audit in this scope; review the full scope.'

const mockConfig: PluginConfig = {
  executionModel: 'test/model',
  auditorModel: 'test/auditor',
  loop: {
    enabled: true,
    model: 'test/loop',
    defaultMaxIterations: 5,
  },
}

const silentLogger: Logger = { log: () => {}, error: () => {}, debug: () => {} }

interface FakeMessage {
  info: { id?: string; role: string; finish?: string; error?: { name?: string; data?: { message?: string; statusCode?: number } } }
  parts: Array<{ type: string; text?: string }>
}

function assistantMessage(id: string, text: string): FakeMessage {
  return { info: { id, role: 'assistant', finish: 'stop' }, parts: [{ type: 'text', text }] }
}

function coderDecisionsBlock(notes: string): string {
  return `<!-- coder-decisions:start -->\n### Decisions\n- ${notes}\n### Verification\n- pnpm test --project node — pass\n### Notes for auditor\n- none\n<!-- coder-decisions:end -->`
}

function makeLoopState(loopName: string, sessionId: string, overrides: Partial<LoopState> = {}): LoopState {
  return {
    active: true,
    sessionId,
    loopName,
    worktreeDir: '/tmp/attempt-handoff-worktree',
    projectDir: '/tmp/attempt-handoff-project',
    worktreeBranch: 'test/branch',
    iteration: 1,
    maxIterations: 5,
    startedAt: new Date().toISOString(),
    prompt: 'Test plan v1',
    phase: 'coding',
    errorCount: 0,
    auditCount: 0,
    status: 'running',
    worktree: false,
    modelFailed: false,
    sandbox: false,
    executionModel: 'test/model',
    auditorModel: 'test/auditor',
    currentSectionIndex: 0,
    totalSections: 0,
    finalAuditDone: false,
    ...overrides,
  }
}

function queueSnapshotCommits(commits: string[]): void {
  const queue = [...commits]
  vi.mocked(captureAuditSnapshot).mockImplementation(async (_cwd: string, ref: string) => {
    const commit = queue.shift()
    if (!commit) throw new Error('snapshot queue exhausted')
    return { commit, ref }
  })
}

function snapshotRefs(): string[] {
  return vi.mocked(captureAuditSnapshot).mock.calls.map(call => (call as unknown as [string, string])[1])
}

async function idleTick(loop: Loop, sessionId: string): Promise<void> {
  await loop.tick({ type: 'session.status', properties: { status: { type: 'idle' }, sessionID: sessionId } })
}

async function busyTick(loop: Loop, sessionId: string): Promise<void> {
  await loop.tick({ type: 'session.status', properties: { status: { type: 'busy' }, sessionID: sessionId } })
}

function promptsTo(calls: RecordedCall[], sessionId: string, agent?: 'code' | 'auditor-loop'): string[] {
  return calls
    .filter(c => c.method === 'session.promptAsync'
      && (c.params as { sessionID?: string })?.sessionID === sessionId
      && (agent === undefined || (c.params as { agent?: string })?.agent === agent))
    .map(c => ((c.params as { parts?: Array<{ text?: string }> })?.parts?.[0]?.text ?? ''))
}

function auditorPrompts(calls: RecordedCall[]): string[] {
  return calls
    .filter(c => c.method === 'session.promptAsync' && (c.params as { agent?: string })?.agent === 'auditor-loop')
    .map(c => (c.params as { parts?: Array<{ text?: string }> })?.parts?.[0]?.text ?? '')
}

describe('durable attempt handoff', () => {
  let db: Database
  let tempDir: string
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let plansRepo: ReturnType<typeof createPlansRepo>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  let sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>
  let loopTransitionsRepo: ReturnType<typeof createLoopTransitionsRepo>
  let attemptsRepo: ReturnType<typeof createLoopAttemptsRepo>
  let currentLoop: Loop | null = null

  const harnessLogger: Logger = { log: () => {}, error: () => {}, debug: () => {} }

  interface RuntimeHarness {
    loop: Loop
    calls: RecordedCall[]
    statuses: Record<string, { type?: string }>
    messagesBySession: Map<string, FakeMessage[]>
    service: LoopService
  }

  function createRuntimeHarness(deps: {
    statuses?: Record<string, { type?: string }>
    statusImpl?: () => Promise<unknown>
    getParentSessionId?: (sessionId: string) => Promise<string | null>
    withAttemptsRepo?: boolean
  }): RuntimeHarness {
    const statuses: Record<string, { type?: string }> = deps.statuses ?? {}
    const messagesBySession = new Map<string, FakeMessage[]>()
    let sessionCounter = 0
    const { client, calls } = createFakeForgeClient({
      session: {
        create: (async () => ({ id: `h-ses-${++sessionCounter}` })) as any,
        messages: (async (params: { sessionID?: string }) => messagesBySession.get(params?.sessionID ?? '') ?? []) as any,
        status: (deps.statusImpl ?? (async () => statuses)) as any,
      },
    })
    const loop = createLoop({
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      sectionPlansRepo,
      loopTransitionsRepo,
      ...(deps.withAttemptsRepo === false ? {} : { loopAttemptsRepo: attemptsRepo }),
      projectId: PROJECT_ID,
      client,
      logger: harnessLogger,
      getConfig: () => mockConfig,
      ...(deps.getParentSessionId ? { getParentSessionId: deps.getParentSessionId } : {}),
    })
    currentLoop = loop
    return { loop, calls, statuses, messagesBySession, service: loop.service }
  }

  function createDurableService(): LoopService {
    return createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      silentLogger,
      undefined,
      undefined,
      sectionPlansRepo,
      loopTransitionsRepo,
      undefined,
      undefined,
      attemptsRepo,
    )
  }

  async function drivePlanLoopThroughDirtyAudit(harness: RuntimeHarness, loopName: string): Promise<{ auditSessionId: string; coderBId: string }> {
    const state = makeLoopState(loopName, 'coder-a')
    harness.service.setState(loopName, state)
    harness.messagesBySession.set('coder-a', [
      assistantMessage('msg-a1', `Implemented the ledger.\n${coderDecisionsBlock('chose the append-only ledger approach')}`),
    ])
    await idleTick(harness.loop, 'coder-a')

    const auditSessionId = harness.service.getActiveState(loopName)!.sessionId
    expect(auditSessionId).not.toBe('coder-a')
    harness.messagesBySession.set(auditSessionId, [
      assistantMessage('msg-audit1', 'The retry handler still drops the second event; the idempotent-replay acceptance criterion is unmet.'),
    ])
    reviewFindingsRepo.write({
      projectId: PROJECT_ID,
      loopName,
      file: 'src/ledger.ts',
      line: 7,
      severity: 'bug',
      description: 'Retry handler drops the second event',
    })
    await busyTick(harness.loop, auditSessionId)
    await idleTick(harness.loop, auditSessionId)

    const afterAudit = harness.service.getActiveState(loopName)!
    expect(afterAudit.phase).toBe('coding')
    return { auditSessionId, coderBId: afterAudit.sessionId }
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'attempt-handoff-test-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    loopsRepo = createLoopsRepo(db)
    plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    sectionPlansRepo = createSectionPlansRepo(db)
    loopTransitionsRepo = createLoopTransitionsRepo(db)
    attemptsRepo = createLoopAttemptsRepo(db, silentLogger)
    sessionsAwaitingBusy.clear()
    __resetInFlightGuard()
    vi.mocked(captureAuditSnapshot).mockReset()
    vi.mocked(compareAuditSnapshots).mockReset()
    vi.mocked(deleteAuditSnapshot).mockReset()
    vi.mocked(captureAuditSnapshot).mockRejectedValue(new Error('no snapshot queued'))
    vi.mocked(deleteAuditSnapshot).mockResolvedValue(undefined)
  })

  afterEach(() => {
    if (currentLoop) {
      currentLoop.clearAllRetryTimeouts()
      currentLoop = null
    }
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
    sessionsAwaitingBusy.clear()
    __resetInFlightGuard()
    vi.useRealTimers()
  })

  describe('runtime flow', () => {
    test('idle coding captures decisions and snapshot, binds the audit, and a dirty audit finalizes before the next coder pass', async () => {
      const loopName = 'handoff-plan-loop'
      queueSnapshotCommits([COMMIT_A])
      vi.mocked(compareAuditSnapshots).mockResolvedValue(DELTA_SUMMARY)
      const harness = createRuntimeHarness({})

      const state = makeLoopState(loopName, 'coder-a')
      harness.service.setState(loopName, state)
      harness.messagesBySession.set('coder-a', [
        assistantMessage('msg-a1', `Implemented the ledger.\n${coderDecisionsBlock('chose the append-only ledger approach')}`),
      ])
      await idleTick(harness.loop, 'coder-a')

      const rows = harness.service.getAttemptHistory(loopName, 'plan')
      expect(rows.length).toBe(1)
      const row1 = rows[0]
      expect(row1.completionKey).toBe('coder-a:msg-a1')
      expect(row1.sourceSessionId).toBe('coder-a')
      expect(row1.scope).toBe('plan')
      expect(row1.attemptNumber).toBe(1)
      expect(row1.coderDecisions).toContain('chose the append-only ledger approach')
      expect(row1.snapshotCommit).toBe(COMMIT_A)

      expect(row1.snapshotRef).toMatch(/^refs\/forge\/audits\//)
      expect(row1.fallbackReason).toBe(FIRST_AUDIT_FALLBACK)
      expect(row1.outcome).toBeNull()
      expect(row1.worktreeDir).toBe(state.worktreeDir)

      const auditState = harness.service.getActiveState(loopName)!
      expect(auditState.phase).toBe('auditing')
      const auditSessionId = auditState.sessionId
      expect(auditSessionId).not.toBe('coder-a')
      expect(row1.auditorSessionId).toBe(auditSessionId)

      const firstAuditPrompt = auditorPrompts(harness.calls).at(-1)!
      expect(firstAuditPrompt).toContain('chose the append-only ledger approach')
      expect(firstAuditPrompt).toContain('Audit attempt history (scope: plan)')
      expect(firstAuditPrompt).toContain('No usable snapshot delta on the latest attempt')
      expect(firstAuditPrompt).toContain(FIRST_AUDIT_FALLBACK)

      harness.messagesBySession.set(auditSessionId, [
        assistantMessage('msg-audit1', 'The retry handler still drops the second event; the idempotent-replay acceptance criterion is unmet.'),
      ])
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/ledger.ts',
        line: 7,
        severity: 'bug',
        description: 'Retry handler drops the second event',
      })
      await busyTick(harness.loop, auditSessionId)
      await idleTick(harness.loop, auditSessionId)

      const finalized = harness.service.getAttemptHistory(loopName, 'plan')
      expect(finalized.length).toBe(1)
      expect(finalized[0].outcome).toBe('dirty')
      expect(finalized[0].auditedAt).not.toBeNull()
      expect(finalized[0].findingsAfter.map(f => f.file)).toEqual(['src/ledger.ts'])

      const afterAudit = harness.service.getActiveState(loopName)!
      expect(afterAudit.phase).toBe('coding')
      const coderBId = afterAudit.sessionId
      expect(coderBId).not.toBe('coder-a')

      const continuationPrompt = promptsTo(harness.calls, coderBId, 'code').at(-1)!
      expect(continuationPrompt).toContain('Coder decisions from latest attempt 1')
      expect(continuationPrompt).toContain('chose the append-only ledger approach')
      expect(continuationPrompt).toContain('outcome: dirty')
    })

    test('subsequent code pass records the exact snapshot delta and the audit prompt carries latest notes and prior hypotheses', async () => {
      const loopName = 'handoff-plan-delta'
      queueSnapshotCommits([COMMIT_A, COMMIT_B])
      vi.mocked(compareAuditSnapshots).mockResolvedValue(DELTA_SUMMARY)
      const harness = createRuntimeHarness({})

      const { coderBId } = await drivePlanLoopThroughDirtyAudit(harness, loopName)

      harness.messagesBySession.set(coderBId, [
        assistantMessage('msg-b1', `Patched the retry handler.\n${coderDecisionsBlock('second pass guards replay idempotency')}`),
      ])
      await busyTick(harness.loop, coderBId)
      await idleTick(harness.loop, coderBId)

      const rows = harness.service.getAttemptHistory(loopName, 'plan')
      expect(rows.length).toBe(2)
      const row2 = rows[1]
      expect(row2.attemptNumber).toBe(2)
      expect(row2.previousCommit).toBe(COMMIT_A)
      expect(row2.diffSummary).toBe(DELTA_SUMMARY)
      expect(row2.snapshotCommit).toBe(COMMIT_B)
      expect(row2.fallbackReason).toBeNull()
      expect(row2.coderDecisions).toContain('second pass guards replay idempotency')

      const auditState = harness.service.getActiveState(loopName)!
      expect(auditState.phase).toBe('auditing')
      expect(row2.auditorSessionId).toBe(auditState.sessionId)

      const secondAuditPrompt = auditorPrompts(harness.calls).at(-1)!
      expect(secondAuditPrompt).toContain('second pass guards replay idempotency')
      expect(secondAuditPrompt).toContain('Prior attempted coder decisions')
      expect(secondAuditPrompt).toContain('chose the append-only ledger approach')
      expect(secondAuditPrompt).toContain(`git diff --no-ext-diff --no-textconv ${COMMIT_A} ${COMMIT_B} --`)
    })

    test('final-audit fix repeat keeps recording under the same final scope and builds the delta from the first final snapshot', async () => {
      const loopName = 'handoff-final-scope'
      queueSnapshotCommits([COMMIT_A, COMMIT_B])
      vi.mocked(compareAuditSnapshots).mockResolvedValue(DELTA_SUMMARY)
      const harness = createRuntimeHarness({})

      const state = makeLoopState(loopName, 'fix-a', { phase: 'final_audit_fix', iteration: 2, auditCount: 1 })
      harness.service.setState(loopName, state)
      harness.messagesBySession.set('fix-a', [
        assistantMessage('msg-f1', `Fixed the race.\n${coderDecisionsBlock('final fix round one decisions')}`),
      ])
      await idleTick(harness.loop, 'fix-a')

      const firstRows = harness.service.getAttemptHistory(loopName, 'final')
      expect(firstRows.length).toBe(1)
      const row1 = firstRows[0]
      expect(row1.scope).toBe('final')
      expect(row1.completionKey).toBe('fix-a:msg-f1')
      expect(row1.coderDecisions).toContain('final fix round one decisions')
      expect(row1.fallbackReason).toBe(FIRST_AUDIT_FALLBACK)
      expect(row1.snapshotCommit).toBe(COMMIT_A)
      expect(harness.calls.filter(call => call.method === 'session.messages'
        && (call.params as { sessionID?: string; limit?: number }).sessionID === 'fix-a'
        && (call.params as { limit?: number }).limit === 4)).toHaveLength(1)

      const auditState = harness.service.getActiveState(loopName)!
      expect(auditState.phase).toBe('final_auditing')
      const auditSessionId = auditState.sessionId
      expect(row1.auditorSessionId).toBe(auditSessionId)

      harness.messagesBySession.set(auditSessionId, [assistantMessage('msg-fa1', 'The race is still reproducible under replay.')])
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/replay.ts',
        line: 3,
        severity: 'bug',
        description: 'Replay still races',
      })
      await busyTick(harness.loop, auditSessionId)
      await idleTick(harness.loop, auditSessionId)

      const finishedRows = harness.service.getAttemptHistory(loopName, 'final')
      expect(finishedRows[0].outcome).toBe('dirty')

      const fixBId = harness.service.getActiveState(loopName)!.sessionId
      expect(harness.service.getActiveState(loopName)!.phase).toBe('final_audit_fix')
      harness.messagesBySession.set(fixBId, [
        assistantMessage('msg-f2', `Fixed it for real.\n${coderDecisionsBlock('final fix round two decisions')}`),
      ])
      await busyTick(harness.loop, fixBId)
      await idleTick(harness.loop, fixBId)

      const rows = harness.service.getAttemptHistory(loopName, 'final')
      expect(rows.length).toBe(2)
      expect(rows[0].scope).toBe('final')
      expect(rows[1].scope).toBe('final')
      expect(rows[1].attemptNumber).toBe(2)
      expect(rows[1].previousCommit).toBe(COMMIT_A)
      expect(rows[1].diffSummary).toBe(DELTA_SUMMARY)
      expect(rows[1].snapshotCommit).toBe(COMMIT_B)
      expect(rows[1].coderDecisions).toContain('final fix round two decisions')
    })
  })

  describe('quiescence gate', () => {
    test('proceeds immediately when the session status record is empty', async () => {
      const loopName = 'handoff-quiesce-empty'
      queueSnapshotCommits([COMMIT_A])
      const harness = createRuntimeHarness({})

      const state = makeLoopState(loopName, 'q-coder')
      harness.service.setState(loopName, state)
      harness.messagesBySession.set('q-coder', [
        assistantMessage('msg-q1', `work done\n${coderDecisionsBlock('quiescent capture decisions')}`),
      ])
      await idleTick(harness.loop, 'q-coder')

      const rows = harness.service.getAttemptHistory(loopName, 'plan')
      expect(rows.length).toBe(1)
      expect(rows[0].completionKey).toBe('q-coder:msg-q1')
      expect(rows[0].coderDecisions).toContain('quiescent capture decisions')
      expect(harness.service.getActiveState(loopName)!.phase).toBe('auditing')
      expect(auditorPrompts(harness.calls).length).toBe(1)
    })

    test('waits for a busy child session resolved through parent ancestry before capturing', async () => {
      vi.useFakeTimers()
      const loopName = 'handoff-quiesce-child'
      queueSnapshotCommits([COMMIT_A])
      const harness = createRuntimeHarness({
        statuses: { 'child-q': { type: 'busy' } },
        getParentSessionId: async (sessionId) => (sessionId === 'child-q' ? 'q-coder' : null),
      })

      const state = makeLoopState(loopName, 'q-coder')
      harness.service.setState(loopName, state)
      harness.messagesBySession.set('q-coder', [
        assistantMessage('msg-q1', `work done\n${coderDecisionsBlock('quiescent capture decisions')}`),
      ])
      await idleTick(harness.loop, 'q-coder')

      expect(harness.service.getAttemptHistory(loopName)).toHaveLength(0)
      expect(auditorPrompts(harness.calls)).toHaveLength(0)
      const deferredState = harness.service.getActiveState(loopName)!
      expect(deferredState.phase).toBe('coding')
      expect(deferredState.active).toBe(true)

      for (const key of Object.keys(harness.statuses)) delete harness.statuses[key]
      await vi.advanceTimersByTimeAsync(1700)

      const rows = harness.service.getAttemptHistory(loopName, 'plan')
      expect(rows.length).toBe(1)
      expect(rows[0].completionKey).toBe('q-coder:msg-q1')
      expect(rows[0].coderDecisions).toContain('quiescent capture decisions')
      expect(harness.service.getActiveState(loopName)!.phase).toBe('auditing')
      expect(auditorPrompts(harness.calls).length).toBe(1)
    })

    test('defers capture when the session status query fails and keeps deferring while it keeps failing', async () => {
      vi.useFakeTimers()
      const loopName = 'handoff-quiesce-status-failure'
      const harness = createRuntimeHarness({
        statusImpl: async () => {
          throw new Error('status endpoint down')
        },
      })

      const state = makeLoopState(loopName, 'f-coder')
      harness.service.setState(loopName, state)
      harness.messagesBySession.set('f-coder', [
        assistantMessage('msg-f1', `work done\n${coderDecisionsBlock('status failure decisions')}`),
      ])
      await idleTick(harness.loop, 'f-coder')

      expect(harness.service.getAttemptHistory(loopName)).toHaveLength(0)
      expect(auditorPrompts(harness.calls)).toHaveLength(0)
      expect(harness.service.getActiveState(loopName)!.active).toBe(true)

      await vi.advanceTimersByTimeAsync(1700)

      expect(harness.service.getAttemptHistory(loopName)).toHaveLength(0)
      expect(auditorPrompts(harness.calls)).toHaveLength(0)
      const stillActive = harness.service.getActiveState(loopName)!
      expect(stillActive.phase).toBe('coding')
      expect(stillActive.active).toBe(true)
    })

    test('defers capture when a busy session has unresolvable ancestry, then captures once ancestry is moot', async () => {
      vi.useFakeTimers()
      const loopName = 'handoff-quiesce-unknown-ancestry'
      queueSnapshotCommits([COMMIT_A])
      const harness = createRuntimeHarness({
        statuses: { 'stranger-ses': { type: 'busy' } },
      })

      const state = makeLoopState(loopName, 'u-coder')
      harness.service.setState(loopName, state)
      harness.messagesBySession.set('u-coder', [
        assistantMessage('msg-u1', `work done\n${coderDecisionsBlock('unknown ancestry decisions')}`),
      ])
      await idleTick(harness.loop, 'u-coder')

      expect(harness.service.getAttemptHistory(loopName)).toHaveLength(0)
      expect(auditorPrompts(harness.calls)).toHaveLength(0)
      expect(harness.service.getActiveState(loopName)!.active).toBe(true)

      for (const key of Object.keys(harness.statuses)) delete harness.statuses[key]
      await vi.advanceTimersByTimeAsync(1700)

      const rows = harness.service.getAttemptHistory(loopName, 'plan')
      expect(rows.length).toBe(1)
      expect(rows[0].completionKey).toBe('u-coder:msg-u1')
      expect(harness.service.getActiveState(loopName)!.phase).toBe('auditing')
    })

    test('loops without the attempts repo keep the legacy flow and never consult session status', async () => {
      const loopName = 'handoff-legacy-runtime'
      const harness = createRuntimeHarness({
        statuses: { 'stranger-ses': { type: 'busy' } },
        withAttemptsRepo: false,
      })

      const state = makeLoopState(loopName, 'legacy-coder')
      harness.service.setState(loopName, state)
      harness.messagesBySession.set('legacy-coder', [
        assistantMessage('msg-l1', `done\n${coderDecisionsBlock('legacy path decisions')}`),
      ])
      await idleTick(harness.loop, 'legacy-coder')

      expect(harness.calls.filter(c => c.method === 'session.status')).toHaveLength(0)
      const afterState = harness.service.getActiveState(loopName)!
      expect(afterState.phase).toBe('auditing')
      const auditPrompt = auditorPrompts(harness.calls).at(-1)!
      expect(auditPrompt).toContain('legacy path decisions')
    })
  })

  describe('durable attempt service', () => {
    test('duplicate completion key is idempotent and never recaptures the snapshot', async () => {
      const loopName = 'handoff-dup-key'
      queueSnapshotCommits([COMMIT_A])
      const service = createDurableService()
      const state = makeLoopState(loopName, 'dup-coder')
      service.setState(loopName, state)

      expect(await service.captureAttempt(state, 'dup-coder:key-1', 'first decisions')).toBe(true)
      expect(await service.captureAttempt(state, 'dup-coder:key-1', 'second decisions')).toBe(true)

      const rows = service.getAttemptHistory(loopName)
      expect(rows.length).toBe(1)
      expect(rows[0].coderDecisions).toBe('first decisions')
      expect(vi.mocked(captureAuditSnapshot).mock.calls.length).toBe(1)
    })

    test('snapshot capture failure records a full-scope fallback attempt without a delta', async () => {
      const loopName = 'handoff-capture-failure'
      vi.mocked(captureAuditSnapshot).mockRejectedValue(new Error('git exploded'))
      const service = createDurableService()
      const state = makeLoopState(loopName, 'cf-coder')
      service.setState(loopName, state)

      expect(await service.captureAttempt(state, 'cf:key-1', null)).toBe(true)

      const rows = service.getAttemptHistory(loopName)
      expect(rows.length).toBe(1)
      expect(rows[0].snapshotCommit).toBeNull()
      expect(rows[0].snapshotRef).toBeNull()
      expect(rows[0].previousCommit).toBeNull()
      expect(rows[0].diffSummary).toBeNull()
      expect(rows[0].fallbackReason).toBe('Checkpoint unavailable: git exploded. Review the full scope.')
      expect(vi.mocked(compareAuditSnapshots).mock.calls.length).toBe(0)
      expect(vi.mocked(deleteAuditSnapshot).mock.calls.length).toBe(0)
    })

    test('snapshot compare failure drops the delta and falls back to the full scope while keeping the new snapshot', async () => {
      const loopName = 'handoff-compare-failure'
      queueSnapshotCommits([COMMIT_A, COMMIT_B])
      const service = createDurableService()
      const state = makeLoopState(loopName, 'cmp-coder')
      service.setState(loopName, state)

      expect(await service.captureAttempt(state, 'cmp:key-1', null)).toBe(true)
      service.replaceSession(loopName, { newSessionId: 'cmp-auditor', phase: 'auditing' })
      service.finishAttempt(service.getActiveState(loopName)!, 'dirty')
      service.replaceSession(loopName, { newSessionId: state.sessionId, phase: 'coding', iteration: 2 })

      vi.mocked(compareAuditSnapshots).mockRejectedValue(new Error('diff exploded'))
      expect(await service.captureAttempt({ ...state, iteration: 2 }, 'cmp:key-2', null)).toBe(true)

      const rows = service.getAttemptHistory(loopName, 'plan')
      expect(rows.length).toBe(2)
      const row2 = rows[1]
      expect(row2.snapshotCommit).toBe(COMMIT_B)
      expect(row2.snapshotRef).not.toBeNull()
      expect(row2.previousCommit).toBeNull()
      expect(row2.diffSummary).toBeNull()
      expect(row2.fallbackReason).toBe('Checkpoint unavailable: diff exploded. Review the full scope.')
      expect(vi.mocked(deleteAuditSnapshot).mock.calls.length).toBe(0)
    })

    test('a plan change makes the previous checkpoint ineligible and forces the full-scope fallback', async () => {
      const loopName = 'handoff-plan-change'
      queueSnapshotCommits([COMMIT_A, COMMIT_B])
      const service = createDurableService()
      const state = makeLoopState(loopName, 'pc-coder')
      service.setState(loopName, state)

      expect(await service.captureAttempt(state, 'pc:key-1', null)).toBe(true)
      service.replaceSession(loopName, { newSessionId: 'pc-auditor', phase: 'auditing' })
      service.finishAttempt(service.getActiveState(loopName)!, 'dirty')
      service.replaceSession(loopName, { newSessionId: state.sessionId, phase: 'coding', iteration: 2 })

      plansRepo.writeForLoop(PROJECT_ID, loopName, 'Test plan v2 — amended')
      expect(await service.captureAttempt({ ...state, iteration: 2 }, 'pc:key-2', null)).toBe(true)

      const rows = service.getAttemptHistory(loopName, 'plan')
      expect(rows.length).toBe(2)
      const row2 = rows[1]
      expect(row2.planHash).not.toBe(rows[0].planHash)
      expect(row2.previousCommit).toBeNull()
      expect(row2.diffSummary).toBeNull()
      expect(row2.snapshotCommit).toBe(COMMIT_B)
      expect(row2.fallbackReason).toBe('The previous attempt was not audited, its checkpoint is unavailable, or the plan/workspace changed; review the full scope.')
      expect(vi.mocked(compareAuditSnapshots).mock.calls.length).toBe(0)
    })

    test('cancelling the loop during capture records nothing and deletes the orphan checkpoint', async () => {
      const loopName = 'handoff-cancel-capture'
      const service = createDurableService()
      const state = makeLoopState(loopName, 'cc-coder')
      service.setState(loopName, state)

      let releaseCapture!: (value: { commit: string; ref: string }) => void
      vi.mocked(captureAuditSnapshot).mockImplementationOnce(() => new Promise(resolve => {
        releaseCapture = resolve
      }))
      const pending = service.captureAttempt(state, 'cc:key-1', 'in-flight decisions')
      service.terminate(loopName, { status: 'cancelled', reason: 'user aborted', completedAt: Date.now() })
      const capturedRef = (vi.mocked(captureAuditSnapshot).mock.calls[0] as unknown as [string, string])[1]
      releaseCapture({ commit: COMMIT_A, ref: capturedRef })

      expect(await pending).toBe(false)
      expect(service.getAttemptHistory(loopName)).toHaveLength(0)
      expect(vi.mocked(deleteAuditSnapshot)).toHaveBeenCalledWith(state.worktreeDir, capturedRef, silentLogger)
    })

    test('section-scoped capture stores the section scope and only that section findings as findingsBefore', async () => {
      const loopName = 'handoff-section-scope'
      queueSnapshotCommits([COMMIT_A])
      const service = createDurableService()
      const state = makeLoopState(loopName, 'ss-coder', { totalSections: 1, currentSectionIndex: 0 })
      service.setState(loopName, state)
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/a.ts',
        line: 1,
        severity: 'bug',
        description: 'Section bug',
        sectionIndex: 0,
      })
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/b.ts',
        line: 2,
        severity: 'warning',
        description: 'Other section warning',
        sectionIndex: 1,
      })

      expect(await service.captureAttempt(state, 'ss:key-1', null)).toBe(true)

      const rows = service.getAttemptHistory(loopName, 'section:0')
      expect(rows.length).toBe(1)
      expect(rows[0].scope).toBe('section:0')
      expect(rows[0].findingsBefore.map(f => f.file)).toEqual(['src/a.ts'])
      expect(rows[0].fallbackReason).toBe(FIRST_AUDIT_FALLBACK)
      expect(service.getAttemptHistory(loopName, 'section:1')).toHaveLength(0)
    })

    test('attempt history and finding recurrence survive recreating the service over the same storage', async () => {
      const loopName = 'handoff-durable'
      queueSnapshotCommits([COMMIT_A, COMMIT_B, COMMIT_C])
      const serviceA = createDurableService()
      const state = makeLoopState(loopName, 'dur-coder')
      serviceA.setState(loopName, state)
      reviewFindingsRepo.write({
        projectId: PROJECT_ID,
        loopName,
        file: 'src/race.ts',
        line: 9,
        severity: 'bug',
        description: 'Replay races on shutdown',
      })

      expect(await serviceA.captureAttempt(state, 'dur:key-1', 'first fix notes')).toBe(true)
      serviceA.replaceSession(loopName, { newSessionId: 'dur-auditor', phase: 'auditing' })
      serviceA.finishAttempt(serviceA.getActiveState(loopName)!, 'dirty')
      serviceA.replaceSession(loopName, { newSessionId: state.sessionId, phase: 'coding', iteration: 2 })
      expect(await serviceA.captureAttempt({ ...state, iteration: 2 }, 'dur:key-2', 'second fix notes')).toBe(true)
      serviceA.replaceSession(loopName, { newSessionId: 'dur-auditor-2', phase: 'auditing' })
      serviceA.finishAttempt(serviceA.getActiveState(loopName)!, 'dirty')
      serviceA.replaceSession(loopName, { newSessionId: state.sessionId, phase: 'coding', iteration: 3 })
      expect(await serviceA.captureAttempt({ ...state, iteration: 3 }, 'dur:key-3', 'third fix notes')).toBe(true)
      serviceA.replaceSession(loopName, { newSessionId: 'dur-auditor-3', phase: 'auditing' })
      serviceA.finishAttempt(serviceA.getActiveState(loopName)!, 'dirty')

      const serviceB = createDurableService()
      const rows = serviceB.getAttemptHistory(loopName)
      expect(rows.map(r => r.coderDecisions)).toEqual(['first fix notes', 'second fix notes', 'third fix notes'])
      expect(rows.map(r => r.outcome)).toEqual(['dirty', 'dirty', 'dirty'])
      const prompt = serviceB.buildContinuationPrompt(serviceB.getActiveState(loopName)!)
      expect(prompt).toContain('recurred 3×')
      expect(prompt).toContain('third fix notes')
    })

    test('a service without the attempts repo keeps the legacy in-memory decisions flow', async () => {
      const loopName = 'handoff-legacy-service'
      const legacy = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, silentLogger)
      const state = makeLoopState(loopName, 'legacy-coder')
      legacy.setState(loopName, state)

      expect(await legacy.captureAttempt(state, 'legacy:key-1', 'legacy decisions')).toBe(true)
      expect(legacy.buildAuditPrompt(state)).toContain('legacy decisions')
      expect(legacy.getAttemptHistory(loopName)).toHaveLength(0)
    })
  })
})
