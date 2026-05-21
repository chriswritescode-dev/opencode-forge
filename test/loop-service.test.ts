import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { createLoop } from '../src/loop/runtime'
import type { Logger } from '../src/types'
import { setupLoopsTestDb } from './helpers/loops-test-db'

describe('Loop', () => {
  let db: Database
  let loop: ReturnType<typeof createLoop>
  let tempDir: string
  const projectId = 'test-project'

  const mockLogger: Logger = {
    log: () => {},
    error: () => {},
    debug: () => {},
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-service-test-'))
    const dbPath = join(tempDir, 'loop-service-test.db')
    db = new Database(dbPath)

    setupLoopsTestDb(db)

    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    const reviewFindingsRepo = createReviewFindingsRepo(db)

    loop = createLoop({
      loopsRepo,
      plansRepo,
      reviewFindingsRepo,
      projectId,
      logger: mockLogger,
      client: {} as any,
      v2Client: {} as any,
      getConfig: () => ({} as any),
    })
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  describe('hasOutstandingFindings', () => {
    test('returns true when only warning findings exist (no severity filter)', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 1,
        severity: 'warning',
        description: 'Test warning',
        scenario: 'test',
        loopName: 'b1',
      })

      expect(loop.hasOutstandingFindings('b1')).toBe(true)
    })

    test('returns false when only warning findings exist and severity=bug filter is applied', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 1,
        severity: 'warning',
        description: 'Test warning',
        scenario: 'test',
        loopName: 'b1',
      })

      expect(loop.hasOutstandingFindings('b1', 'bug')).toBe(false)
      expect(loop.hasOutstandingFindings('b1', 'warning')).toBe(true)
    })

    test('returns true when bug findings exist with severity=bug filter', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test bug',
        scenario: 'test',
        loopName: 'b2',
      })
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 2,
        severity: 'warning',
        description: 'Test warning',
        scenario: 'test',
        loopName: 'b2',
      })

      expect(loop.hasOutstandingFindings('b2', 'bug')).toBe(true)
      const bugFindings = loop.getOutstandingFindings('b2', 'bug')
      expect(bugFindings.length).toBe(1)
      expect(bugFindings[0].severity).toBe('bug')
    })
  })

  describe('getOutstandingFindings', () => {
    test('returns all findings when no severity filter is provided', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test bug',
        scenario: 'test',
        loopName: 'b2',
      })
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 2,
        severity: 'warning',
        description: 'Test warning',
        scenario: 'test',
        loopName: 'b2',
      })

      const allFindings = loop.getOutstandingFindings('b2')
      expect(allFindings.length).toBe(2)

      const warningFindings = loop.getOutstandingFindings('b2', 'warning')
      expect(warningFindings.length).toBe(1)
      expect(warningFindings[0].severity).toBe('warning')
    })
  })

  describe('buildAuditPrompt', () => {
    test('contains plan completeness check instructions', () => {
      const state = {
        active: true,
        sessionId: 'test-session',
        loopName: 'test-loop',
        worktreeDir: '/tmp/test',
        worktreeBranch: 'test-branch',
        iteration: 1,
        maxIterations: 10,
        startedAt: new Date().toISOString(),
        phase: 'coding' as const,

        errorCount: 0,
        auditCount: 0,
      }

      const prompt = loop.buildAuditPrompt(state as any)

      expect(prompt).toContain('Plan completeness check:')
      expect(prompt).toContain('severity: "bug"')
      expect(prompt).toContain('For every plan phase, verify it is fully implemented')
      expect(prompt).toContain('Outstanding `bug` findings block loop termination')
    })
  })

  describe('getMinAudits removal', () => {
    test('getMinAudits is not exposed on the service', () => {
      expect((loop as any).getMinAudits).toBeUndefined()
    })
  })

  describe('buildContinuationPrompt regression', () => {
    test('includes outstanding findings in continuation prompt', () => {
      const reviewFindingsRepo = createReviewFindingsRepo(db)
      reviewFindingsRepo.write({
        projectId,
        file: 'test.ts',
        line: 1,
        severity: 'bug',
        description: 'Test bug',
        scenario: 'test',
        loopName: 'test-loop',
      })

      const state = {
        active: true,
        sessionId: 'test-session',
        loopName: 'test-loop',
        worktreeDir: '/tmp/test',
        worktreeBranch: 'test-branch',
        iteration: 1,
        maxIterations: 10,
        startedAt: new Date().toISOString(),
        prompt: 'Initial prompt',
        phase: 'coding' as const,

        errorCount: 0,
        auditCount: 0,
      }

      const prompt = loop.buildContinuationPrompt(state as any)

      expect(prompt).toContain('Outstanding Review Findings')
      expect(prompt).toContain('test.ts:1')
    })

    test('does not echo the original plan/prompt back into continuation', () => {
      const state = {
        active: true,
        sessionId: 'test-session',
        loopName: 'test-loop',
        worktreeDir: '/tmp/test',
        worktreeBranch: 'no-findings-branch',
        iteration: 2,
        maxIterations: 10,
        startedAt: new Date().toISOString(),
        prompt: 'ORIGINAL_PLAN_BODY_SHOULD_NOT_APPEAR',
        phase: 'coding' as const,
        errorCount: 0,
        auditCount: 1,
      }

      const prompt = loop.buildContinuationPrompt(state as any, 'audit findings text')

      expect(prompt).not.toContain('ORIGINAL_PLAN_BODY_SHOULD_NOT_APPEAR')
      expect(prompt).toContain('audit findings text')
      expect(prompt).toContain('Loop iteration 2')
    })
  })
})
