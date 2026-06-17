import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import type { Database } from 'bun:sqlite'
import { createLoopService } from '../src/loop/service'
import { createLoopsRepo } from '../src/storage/repos/loops-repo'
import { createPlansRepo } from '../src/storage/repos/plans-repo'
import { createReviewFindingsRepo } from '../src/storage/repos/review-findings-repo'
import { openForgeDatabase } from '../src/storage/database'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Logger } from '../src/types'

function createTestDb(): Database {
  return openForgeDatabase(join(tmpdir(), `forge-test-${randomUUID()}.db`))
}

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

describe('Loop findings gate', () => {
  let db: Database
  let loopService: ReturnType<typeof createLoopService>
  let reviewFindingsRepo: ReturnType<typeof createReviewFindingsRepo>
  const projectId = 'test-project'

  beforeEach(() => {
    db = createTestDb()
    const loopsRepo = createLoopsRepo(db)
    const plansRepo = createPlansRepo(db)
    reviewFindingsRepo = createReviewFindingsRepo(db)
    loopService = createLoopService(loopsRepo, plansRepo, reviewFindingsRepo, projectId, mockLogger)
  })

  afterEach(() => {
    db.close()
  })

  test('getOutstandingFindings returns bug findings for specific loop', () => {
    // Seed a bug finding for loop "alpha"
    reviewFindingsRepo.write({
      projectId,
      file: 'src/alpha.ts',
      line: 1,
      severity: 'bug',
      description: 'Alpha loop bug',
      loopName: 'alpha',
    })

    const bugFindings = loopService.getOutstandingFindings('alpha', 'bug')
    expect(bugFindings).toHaveLength(1)
    expect(bugFindings[0].description).toBe('Alpha loop bug')
    expect(bugFindings[0].severity).toBe('bug')
  })

  test('getOutstandingFindings is isolated by loop', () => {
    // Seed findings for two different loops
    reviewFindingsRepo.write({
      projectId,
      file: 'src/alpha.ts',
      line: 1,
      severity: 'bug',
      description: 'Alpha loop bug',
      loopName: 'alpha',
    })
    reviewFindingsRepo.write({
      projectId,
      file: 'src/beta.ts',
      line: 2,
      severity: 'warning',
      description: 'Beta loop warning',
      loopName: 'beta',
    })

    // Alpha should only see alpha findings
    const alphaFindings = loopService.getOutstandingFindings('alpha')
    expect(alphaFindings).toHaveLength(1)
    expect(alphaFindings[0].loopName).toBe('alpha')

    // Beta should only see beta findings
    const betaFindings = loopService.getOutstandingFindings('beta')
    expect(betaFindings).toHaveLength(1)
    expect(betaFindings[0].loopName).toBe('beta')

    // Alpha bug findings should be empty for beta
    const alphaBugForBeta = loopService.getOutstandingFindings('beta', 'bug')
    expect(alphaBugForBeta).toHaveLength(0)
  })

  test('hasOutstandingFindings returns true for bug in loop', () => {
    reviewFindingsRepo.write({
      projectId,
      file: 'src/test.ts',
      line: 10,
      severity: 'bug',
      description: 'Test bug',
      loopName: 'test-loop',
    })

    const hasBugs = loopService.hasOutstandingFindings('test-loop', 'bug')
    expect(hasBugs).toBe(true)
  })

  test('hasOutstandingFindings returns false when no bugs in loop', () => {
    reviewFindingsRepo.write({
      projectId,
      file: 'src/test.ts',
      line: 10,
      severity: 'warning',
      description: 'Test warning',
      loopName: 'test-loop',
    })

    const hasBugs = loopService.hasOutstandingFindings('test-loop', 'bug')
    expect(hasBugs).toBe(false)
  })

  test('getOutstandingFindings returns empty for non-existent loop', () => {
    const findings = loopService.getOutstandingFindings('non-existent-loop')
    expect(findings).toHaveLength(0)
  })
})
