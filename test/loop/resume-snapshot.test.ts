import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../../src/storage/repos/loops-repo'
import { createPlansRepo } from '../../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import { createSectionPlansRepo } from '../../src/storage/repos/section-plans-repo'
import type { SectionPlanRow } from '../../src/storage/repos/section-plans-repo'
import type { ReviewFindingRow } from '../../src/storage/repos/review-findings-repo'
import { createLoopService } from '../../src/loop/service'
import type { Logger } from '../../src/types'
import type { LoopState } from '../../src/loop/state'
import { setupLoopsTestDb } from '../helpers/loops-test-db'
import {
  captureLoopResumeSnapshot,
  restoreLoopResumeRows,
  isLoopResumeSnapshot,
} from '../../src/loop/resume-snapshot'

const PROJECT_ID = 'test-project'
const noopLogger: Logger = { log: () => {}, error: () => {}, debug: () => {} }

describe('captureLoopResumeSnapshot', () => {
  let db: Database
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'resume-snapshot-test-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
  })

  afterEach(() => {
    try { db.close() } catch {}
  })

  function buildRepos() {
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)
    const loopService = createLoopService(
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      PROJECT_ID,
      noopLogger,
      undefined,
      undefined,
      sectionPlansRepo,
    )
    return { loopsRepo, plansRepo, reviewFindingsRepo, sectionPlansRepo, loopService }
  }

  function seedStoppedLoop(sectionPlansRepo: ReturnType<typeof createSectionPlansRepo>): LoopState {
    const state: LoopState = {
      active: false,
      sessionId: 'sess_old',
      loopName: 'my-loop',
      worktreeDir: '/tmp/wt',
      projectDir: '/tmp',
      iteration: 4,
      maxIterations: 10,
      startedAt: new Date().toISOString(),
      prompt: '# My Plan',
      phase: 'auditing',
      errorCount: 1,
      auditCount: 2,
      status: 'cancelled',
      worktree: false,
      currentSectionIndex: 1,
      totalSections: 3,
      finalAuditDone: false,
    }
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const service = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, PROJECT_ID, noopLogger, undefined, undefined, sectionPlansRepo)
    service.setState('my-loop', state)
    service.setStatus('my-loop', 'cancelled')

    sectionPlansRepo.bulkInsert({
      projectId: PROJECT_ID,
      loopName: 'my-loop',
      sections: [
        { index: 0, title: 'Setup', content: 'Do setup' },
        { index: 1, title: 'Build', content: 'Do build' },
        { index: 2, title: 'Ship', content: 'Do ship' },
      ],
    })
    sectionPlansRepo.setStatus(PROJECT_ID, 'my-loop', 0, 'completed')
    sectionPlansRepo.setSummary(PROJECT_ID, 'my-loop', 0, { done: 'setup done' })
    sectionPlansRepo.setStatus(PROJECT_ID, 'my-loop', 1, 'in_progress')
    sectionPlansRepo.incrementAttempts(PROJECT_ID, 'my-loop', 1)
    sectionPlansRepo.incrementAttempts(PROJECT_ID, 'my-loop', 1)

    reviewFindingsRepo.write({
      projectId: PROJECT_ID,
      loopName: 'my-loop',
      file: 'a.ts',
      line: 10,
      severity: 'bug',
      description: 'section finding',
      sectionIndex: 1,
    })
    reviewFindingsRepo.write({
      projectId: PROJECT_ID,
      loopName: 'my-loop',
      file: 'b.ts',
      line: 20,
      severity: 'warning',
      description: 'cross-section finding',
    })

    return state
  }

  test('captures phase pointers, section rows, and findings without host scoping', () => {
    const { sectionPlansRepo, reviewFindingsRepo } = buildRepos()
    const state = seedStoppedLoop(sectionPlansRepo)

    const snapshot = captureLoopResumeSnapshot({
      projectId: PROJECT_ID,
      state,
      sectionPlansRepo,
      reviewFindingsRepo,
    })

    expect(snapshot.version).toBe(1)
    expect(snapshot.kind).toBe('plan')
    expect(snapshot.phase).toBe('coding')
    expect(snapshot.currentSectionIndex).toBe(1)
    expect(snapshot.totalSections).toBe(3)
    expect(snapshot.finalAuditDone).toBe(false)
    expect(snapshot.goal).toBeUndefined()

    expect(snapshot.sections).toHaveLength(3)
    const byIndex = new Map(snapshot.sections.map((s) => [s.sectionIndex, s]))
    expect(byIndex.get(0)!.status).toBe('completed')
    expect(byIndex.get(0)!.summaryDone).toBe('setup done')
    expect(byIndex.get(1)!.status).toBe('in_progress')
    expect(byIndex.get(1)!.attempts).toBe(2)
    expect(byIndex.get(2)!.status).toBe('pending')
    for (const section of snapshot.sections) {
      expect(section).not.toHaveProperty('projectId')
      expect(section).not.toHaveProperty('loopName')
      expect(section).not.toHaveProperty('createdAt')
    }

    expect(snapshot.findings).toHaveLength(2)
    const finding = snapshot.findings.find((f) => f.file === 'a.ts')!
    expect(finding.sectionIndex).toBe(1)
    expect(finding.severity).toBe('bug')
    const cross = snapshot.findings.find((f) => f.file === 'b.ts')!
    expect(cross.sectionIndex).toBeNull()
    for (const f of snapshot.findings) {
      expect(f).not.toHaveProperty('projectId')
      expect(f).not.toHaveProperty('loopName')
      expect(f).not.toHaveProperty('createdAt')
    }
  })

  test('final_auditing phase persists as final_auditing and goal loops carry goal text', () => {
    const { sectionPlansRepo, reviewFindingsRepo, loopsRepo } = buildRepos()
    const baseState: LoopState = {
      active: false,
      sessionId: 'sess_old',
      loopName: 'final-loop',
      worktreeDir: '/tmp/wt',
      projectDir: '/tmp',
      iteration: 2,
      maxIterations: 10,
      startedAt: new Date().toISOString(),
      phase: 'final_auditing',
      errorCount: 0,
      auditCount: 0,
      status: 'cancelled',
      worktree: false,
      currentSectionIndex: 2,
      totalSections: 3,
      finalAuditDone: false,
      kind: 'goal',
      goal: 'Ship it.',
    }
    loopsRepo.insert(
      {
        projectId: PROJECT_ID,
        loopName: 'final-loop',
        status: 'cancelled',
        currentSessionId: 'sess_old',
        worktree: false,
        worktreeDir: '/tmp/wt',
        worktreeBranch: null,
        projectDir: '/tmp',
        maxIterations: 10,
        iteration: 2,
        auditCount: 0,
        errorCount: 0,
        phase: 'final_auditing',
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
        currentSectionIndex: 2,
        totalSections: 3,
        finalAuditDone: 0,
        executionVariant: null,
        auditorVariant: null,
        kind: 'goal',
      },
      { lastAuditResult: null, goal: 'Ship it.' },
    )

    const snapshot = captureLoopResumeSnapshot({
      projectId: PROJECT_ID,
      state: baseState,
      sectionPlansRepo,
      reviewFindingsRepo,
    })

    expect(snapshot.phase).toBe('final_auditing')
    expect(snapshot.kind).toBe('goal')
    expect(snapshot.goal).toBe('Ship it.')
  })
})

describe('restoreLoopResumeRows', () => {
  let db: Database
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'resume-snapshot-restore-test-'))
    db = new Database(join(tempDir, 'test.db'))
    setupLoopsTestDb(db)
  })

  afterEach(() => {
    try { db.close() } catch {}
  })

  function makeSnapshot(): ReturnType<typeof captureLoopResumeSnapshot> {
    const sectionRow = (i: number): Omit<SectionPlanRow, 'projectId' | 'loopName' | 'createdAt'> => ({
      sectionIndex: i,
      title: `S${i}`,
      content: `Section ${i} content`,
      status: i === 0 ? 'completed' : i === 1 ? 'in_progress' : 'pending',
      attempts: i === 1 ? 2 : 0,
      summaryDone: i === 0 ? 'done zero' : null,
      summaryDeviations: null,
      summaryFollowUps: null,
      startedAt: i === 1 ? 1234 : null,
      completedAt: i === 0 ? 999 : null,
    })
    return {
      version: 1,
      kind: 'plan',
      phase: 'coding',
      currentSectionIndex: 1,
      totalSections: 3,
      finalAuditDone: false,
      sections: [sectionRow(0), sectionRow(1), sectionRow(2)],
      findings: [
        { file: 'a.ts', line: 1, severity: 'bug', description: 'bug desc', scenario: 'how', sectionIndex: 1 },
        { file: 'b.ts', line: 2, severity: 'warning', description: 'warn desc', scenario: null, sectionIndex: null },
      ],
    }
  }

  test('restores section rows and findings under a new project/loop scope', () => {
    const loopsRepo = createLoopsRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)
    const sectionPlansRepo = createSectionPlansRepo(db)

    loopsRepo.insert({
      projectId: 'remote-proj',
      loopName: 'moved',
      status: 'running',
      currentSessionId: 'sess_new',
      worktree: false,
      worktreeDir: '/tmp/wt',
      worktreeBranch: null,
      projectDir: '/tmp',
      maxIterations: 10,
      iteration: 1,
      auditCount: 0,
      errorCount: 0,
      phase: 'coding',
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
      currentSectionIndex: 1,
      totalSections: 3,
      finalAuditDone: 0,
      executionVariant: null,
      auditorVariant: null,
      kind: 'plan',
    }, { lastAuditResult: null })

    restoreLoopResumeRows({
      projectId: 'remote-proj',
      loopName: 'moved',
      snapshot: makeSnapshot(),
      sectionPlansRepo,
      reviewFindingsRepo,
    })

    const restored = sectionPlansRepo.list('remote-proj', 'moved')
    expect(restored).toHaveLength(3)
    const byIndex = new Map(restored.map((s) => [s.sectionIndex, s]))
    expect(byIndex.get(0)!.status).toBe('completed')
    expect(byIndex.get(0)!.summaryDone).toBe('done zero')
    expect(byIndex.get(1)!.status).toBe('in_progress')
    expect(byIndex.get(1)!.attempts).toBe(2)
    expect(byIndex.get(1)!.startedAt).toBe(1234)
    expect(byIndex.get(2)!.status).toBe('pending')
    expect(restored.every((s) => s.projectId === 'remote-proj' && s.loopName === 'moved')).toBe(true)
    expect(restored.every((s) => typeof s.createdAt === 'number')).toBe(true)

    const findings = reviewFindingsRepo.listByLoopName('remote-proj', 'moved')
    expect(findings).toHaveLength(2)
    const bug = findings.find((f: ReviewFindingRow) => f.file === 'a.ts')!
    expect(bug.severity).toBe('bug')
    expect(bug.sectionIndex).toBe(1)
    expect(bug.scenario).toBe('how')
    const cross = findings.find((f: ReviewFindingRow) => f.file === 'b.ts')!
    expect(cross.sectionIndex).toBeNull()
  })

  test('isLoopResumeSnapshot accepts a valid snapshot and rejects malformed values', () => {
    expect(isLoopResumeSnapshot(makeSnapshot())).toBe(true)

    expect(isLoopResumeSnapshot(null)).toBe(false)
    expect(isLoopResumeSnapshot('nope')).toBe(false)
    expect(isLoopResumeSnapshot({})).toBe(false)
    expect(isLoopResumeSnapshot({ version: 2 })).toBe(false)
    expect(isLoopResumeSnapshot({
      ...makeSnapshot(),
      phase: 'auditing',
    })).toBe(false)
    expect(isLoopResumeSnapshot({
      ...makeSnapshot(),
      sections: 'nope',
    })).toBe(false)
    expect(isLoopResumeSnapshot({
      ...makeSnapshot(),
      findings: 42,
    })).toBe(false)
    expect(isLoopResumeSnapshot({
      ...makeSnapshot(),
      findings: [
        { file: 'a.ts', line: 1, severity: 'critical', description: 'bad severity', scenario: null, sectionIndex: 1 },
      ],
    })).toBe(false)
    expect(isLoopResumeSnapshot({
      ...makeSnapshot(),
      findings: [
        { file: 'a.ts', line: 1, severity: 'bug', description: 'bad sectionIndex', scenario: null, sectionIndex: 'one' },
      ],
    })).toBe(false)
    expect(isLoopResumeSnapshot({
      ...makeSnapshot(),
      sections: [
        { sectionIndex: 0, title: 'S0', content: 'Section 0 content', status: 'archived', attempts: 0, summaryDone: null, summaryDeviations: null, summaryFollowUps: null, startedAt: null, completedAt: null },
      ],
    })).toBe(false)
    expect(isLoopResumeSnapshot({
      version: 1,
      kind: 'goal',
      phase: 'coding',
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      sections: [],
      findings: [],
    })).toBe(true)
    expect(isLoopResumeSnapshot({
      version: 1,
      kind: 'goal',
      phase: 'coding',
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: false,
      goal: 'Ship it.',
      sections: [],
      findings: [],
    })).toBe(true)
  })
})
