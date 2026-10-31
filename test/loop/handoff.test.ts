import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  auditorHandoffSchema,
  coderHandoffSchema,
  formatAuditHandoffResult,
  formatCoderHandoff,
  formatPostActionReport,
  formatPostActionSummary,
  formatSectionSummary,
  handoffCompletionKey,
  handoffRoleForPhase,
  postActionCompleteSchema,
  type CoderHandoffPayload,
  type PostActionCompletePayload,
} from '../../src/loop/handoff'
import { createLoopService } from '../../src/loop/service'
import { createLoopsRepo, type LoopRow } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import type { Logger } from '../../src/types'

const silentLogger: Logger = { log: () => {}, error: () => {}, debug: () => {} }

function coderPayload(overrides: Partial<CoderHandoffPayload> = {}): CoderHandoffPayload {
  return {
    changes: [{ summary: 'Serialized the handoff write', reason: 'prevents duplicate pending rows' }],
    deviations: [],
    verification: [{ command: 'pnpm test --project node', cwd: 'worktree root', outcome: 'pass', changedAfter: false }],
    ...overrides,
  }
}

function postActionPayload(overrides: Partial<PostActionCompletePayload> = {}): PostActionCompletePayload {
  return {
    outcome: 'completed_with_issues',
    steps: [
      { name: 'open-pr', status: 'done', detail: 'PR #12' },
      { name: 'merge', status: 'skipped' },
      { name: 'notify', status: 'failed', detail: 'webhook missing' },
    ],
    followUps: [],
    ...overrides,
  }
}

describe('handoff schemas', () => {
  test('coder schema requires at least one change and one verification check', () => {
    expect(coderHandoffSchema.safeParse(coderPayload()).success).toBe(true)
    expect(coderHandoffSchema.safeParse(coderPayload({ changes: [] })).success).toBe(false)
    expect(coderHandoffSchema.safeParse(coderPayload({ verification: [] })).success).toBe(false)
    expect(coderHandoffSchema.safeParse(coderPayload({
      changes: [{ summary: '   ', reason: 'because' }],
    })).success).toBe(false)
  })

  test('coder schema defaults deviations to an empty list', () => {
    const parsed = coderHandoffSchema.parse({
      changes: [{ summary: 'did a thing', reason: 'needed' }],
      verification: [{ command: 'true', cwd: '.', outcome: 'not-run', changedAfter: true }],
    })
    expect(parsed.deviations).toEqual([])
  })

  test('auditor schema rejects a summary with an empty done list and allows no summary', () => {
    expect(auditorHandoffSchema.safeParse({}).success).toBe(true)
    expect(auditorHandoffSchema.safeParse({ summary: { done: ['shipped it'] } }).success).toBe(true)
    expect(auditorHandoffSchema.safeParse({ summary: { done: [] } }).success).toBe(false)
  })

  test('post-action schema rejects a payload without steps', () => {
    expect(postActionCompleteSchema.safeParse(postActionPayload()).success).toBe(true)
    expect(postActionCompleteSchema.safeParse({
      outcome: 'completed',
      followUps: [],
    }).success).toBe(false)
    expect(postActionCompleteSchema.safeParse({ ...postActionPayload(), steps: [] }).success).toBe(false)
  })

  test('handoffRoleForPhase maps every loop phase and rejects unknown phases', () => {
    expect(handoffRoleForPhase('coding')).toBe('coder')
    expect(handoffRoleForPhase('auditing')).toBe('auditor')
    expect(handoffRoleForPhase('post_action')).toBe('post_action')
    expect(handoffRoleForPhase('decomposing')).toBeNull()
  })
})

describe('handoff renderers', () => {
  test('formatCoderHandoff renders decisions, deviations, verification, and notes', () => {
    const text = formatCoderHandoff(coderPayload({
      deviations: [{ planItem: 'use a queue', actual: 'used a lock', reason: 'one process only' }],
      verification: [
        { command: 'pnpm typecheck', cwd: 'repo', outcome: 'pass', changedAfter: true },
        { command: 'pnpm test', cwd: 'repo', outcome: 'not-run', changedAfter: false },
      ],
      notes: 'Auditor should re-read the repo layer.',
    }))

    expect(text).toContain('### Decisions')
    expect(text).toContain('- Serialized the handoff write — prevents duplicate pending rows')
    expect(text).toContain('### Deviations')
    expect(text).toContain('- use a queue — used a lock (one process only)')
    expect(text).toContain('### Verification')
    expect(text).toContain('- `pnpm typecheck` in `repo` — pass (code changed afterwards)')
    expect(text).toContain('- `pnpm test` in `repo` — not-run')
    expect(text).toContain('### Notes for auditor')
    expect(text).toContain('Auditor should re-read the repo layer.')
  })

  test('formatCoderHandoff renders none for empty deviations and absent notes', () => {
    const text = formatCoderHandoff(coderPayload())
    const deviationSection = text.split('### Deviations\n')[1].split('\n### Verification')[0]
    expect(deviationSection).toBe('none')
    expect(text.endsWith('### Notes for auditor\nnone')).toBe(true)
  })

  test('formatSectionSummary turns arrays into bullets and empty arrays into none', () => {
    expect(formatSectionSummary({
      done: ['built it', 'tested it'],
      deviations: [],
      followUps: ['document later'],
    })).toEqual({
      done: '- built it\n- tested it',
      deviations: 'none',
      followUps: '- document later',
    })
  })

  test('formatAuditHandoffResult renders the verdict, counts, and summary sections', () => {
    const text = formatAuditHandoffResult(
      {
        summary: { done: ['fixed the race'], deviations: [], followUps: ['add a stress test'] },
        notes: 'Second audit of this section.',
      },
      { clean: false, blockingBugs: 2, sectionIndex: 1 },
    )

    expect(text).toContain('Verdict: dirty')
    expect(text).toContain('Blocking bugs: 2')
    expect(text).toContain('Section: 1')
    expect(text).toContain('### Done\n- fixed the race')
    expect(text).toContain('### Deviations\nnone')
    expect(text).toContain('### Follow-ups\n- add a stress test')
    expect(text).toContain('### Notes\nSecond audit of this section.')
  })

  test('formatPostActionReport renders the outcome, steps table, and follow-ups', () => {
    const text = formatPostActionReport(postActionPayload({ followUps: ['rerun the release job'] }))

    expect(text).toContain('Outcome: completed_with_issues')
    expect(text).toContain('| Step | Status | Detail |')
    expect(text).toContain('| open-pr | done | PR #12 |')
    expect(text).toContain('| merge | skipped |  |')
    expect(text).toContain('### Follow-ups\n- rerun the release job')
    expect(text).toContain('### Notes\nnone')
  })

  test('formatPostActionSummary reports outcome and step counts on one line', () => {
    expect(formatPostActionSummary(postActionPayload())).toBe(
      'completed_with_issues — 1/3 steps done, 1 skipped, 1 failed',
    )
  })

  test('handoffCompletionKey is derived from the persisted id', () => {
    expect(handoffCompletionKey({ id: 7 })).toBe('handoff:7')
  })
})

describe('LoopService handoff store', () => {
  let db: Database
  let tempDir: string
  let loopsRepo: ReturnType<typeof createLoopsRepo>
  let service: ReturnType<typeof createLoopService>

  const loopRow: LoopRow = {
    projectId: 'handoff-project',
    loopName: 'handoff-loop',
    status: 'running',
    currentSessionId: 'coder-session',
    worktree: false,
    worktreeDir: '/tmp/handoff-wt',
    worktreeBranch: null,
    projectDir: '/tmp/handoff-proj',
    maxIterations: 5,
    iteration: 1,
    auditCount: 0,
    errorCount: 0,
    phase: 'coding',
    executionModel: null,
    auditorModel: null,
    modelFailed: false,
    sandbox: false,
    sandboxContainer: null,
    startedAt: 1,
    completedAt: null,
    terminationReason: null,
    completionSummary: null,
    workspaceId: null,
    hostSessionId: null,
    currentSectionIndex: 0,
    totalSections: 1,
    executionVariant: null,
    auditorVariant: null,
    baseCommit: null,
    standbySessionId: null,
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'handoff-service-test-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
    loopsRepo = createLoopsRepo(db)
    loopsRepo.insert(loopRow, { lastAuditResult: null })
    service = createLoopService(
      loopsRepo,
      createPlansRepo(db),
      createReviewFindingsRepo(db),
      loopRow.projectId,
      silentLogger,
    )
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('injects the loop project and stores, applies, discards, and lists handoffs', () => {
    const first = service.recordPendingHandoff({
      loopName: loopRow.loopName,
      sessionId: 'coder-session',
      role: 'coder',
      phase: 'coding',
      sectionIndex: 0,
      iteration: 1,
      payload: coderPayload(),
    })
    expect(first.replaced).toBe(false)
    expect(first.record.projectId).toBe(loopRow.projectId)

    expect(service.getPendingHandoff(loopRow.loopName)?.id).toBe(first.record.id)
    expect(service.applyPendingHandoff(loopRow.loopName, 'other-session')).toBeNull()
    expect(service.applyPendingHandoff(loopRow.loopName, 'coder-session')?.status).toBe('applied')

    const second = service.recordPendingHandoff({
      loopName: loopRow.loopName,
      sessionId: 'auditor-session',
      role: 'auditor',
      phase: 'auditing',
      sectionIndex: 0,
      iteration: 1,
      payload: { notes: 'looks clear' },
    })
    expect(second.replaced).toBe(false)
    service.discardPendingHandoff(loopRow.loopName)

    expect(service.getPendingHandoff(loopRow.loopName)).toBeNull()
    expect(service.listHandoffs(loopRow.loopName).map((record) => record.status)).toEqual(['applied', 'discarded'])
  })
})
