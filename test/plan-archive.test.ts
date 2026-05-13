import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readFileSync, utimesSync, statSync } from 'fs'
import { join } from 'path'
import { buildPlanArchiveFilename, savePlanToArchive, listArchivedPlans, readArchivedPlan, resolvePlanArchiveDir, prunePlanArchive, hashPlanContent, DEFAULT_PLAN_ARCHIVE_TTL_MS } from '../src/utils/plan-archive'

const TEST_DIR = '/tmp/opencode-forge-plan-archive-test-' + Date.now()

describe('buildPlanArchiveFilename', () => {
  test('returns <sha256>.md for any content', () => {
    const filename = buildPlanArchiveFilename('# My Plan\n')
    expect(filename).toMatch(/^[0-9a-f]{64}\.md$/)
  })

  test('same content produces same filename', () => {
    expect(buildPlanArchiveFilename('# X')).toBe(buildPlanArchiveFilename('# X'))
  })

  test('different content produces different filenames', () => {
    expect(buildPlanArchiveFilename('# X')).not.toBe(buildPlanArchiveFilename('# Y'))
  })

  test('ignores the now-deprecated timestamp argument', () => {
    const a = buildPlanArchiveFilename('# X', new Date('2020-01-01'))
    const b = buildPlanArchiveFilename('# X', new Date('2030-01-01'))
    expect(a).toBe(b)
  })
})

describe('hashPlanContent', () => {
  test('hashPlanContent is deterministic SHA-256 hex', () => {
    // sha256('hello') = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(hashPlanContent('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    expect(hashPlanContent('hello')).toHaveLength(64)
  })
})

describe('savePlanToArchive', () => {
  let testDataDir: string

  beforeEach(() => {
    testDataDir = TEST_DIR + '-data-' + Math.random().toString(36).slice(2)
    process.env['XDG_DATA_HOME'] = testDataDir
  })

  afterEach(() => {
    delete process.env['XDG_DATA_HOME']
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true })
    }
  })

  test('creates the dir under a tmp XDG_DATA_HOME and writes the file', () => {
    const projectId = 'test-project-123'
    const planText = '# Test Plan\n\nContent here'
    const now = new Date('2026-05-04T12:34:56.789Z')

    const result = savePlanToArchive(projectId, planText, now)

    expect(result.filename).toMatch(/^[0-9a-f]{64}\.md$/)
    expect(result.filepath).toBe(join(testDataDir, 'opencode', 'forge', 'plans', projectId, result.filename))
    expect(existsSync(result.filepath)).toBe(true)
    expect(readFileSync(result.filepath, 'utf-8')).toBe(planText)
  })

  test('saving identical content twice produces a single deduped file', () => {
    const projectId = 'dedup-project'
    const t1 = new Date('2026-05-04T12:00:00.000Z')
    const t2 = new Date('2026-05-04T12:05:00.000Z')
    const r1 = savePlanToArchive(projectId, '# Same', t1)
    const r2 = savePlanToArchive(projectId, '# Same', t2)
    expect(r1.filepath).toBe(r2.filepath)
    expect(r1.deduped).toBe(false)
    expect(r2.deduped).toBe(true)
    expect(listArchivedPlans(projectId)).toHaveLength(1)
  })

  test('saving different content produces two distinct files', () => {
    const projectId = 'distinct-project'
    const r1 = savePlanToArchive(projectId, '# Plan v1')
    const r2 = savePlanToArchive(projectId, '# Plan v2')
    expect(r1.filepath).not.toBe(r2.filepath)
    expect(r1.deduped).toBe(false)
    expect(r2.deduped).toBe(false)
  })

  test('dedup does not overwrite existing file or change mtime', () => {
    const projectId = 'mtime-project'
    const r1 = savePlanToArchive(projectId, '# Same')
    const mtime1 = statSync(r1.filepath).mtimeMs
    // small wait so any rewrite would produce a different mtime
    const before = Date.now()
    while (Date.now() - before < 20) { /* spin */ }
    const r2 = savePlanToArchive(projectId, '# Same')
    expect(r2.deduped).toBe(true)
    expect(statSync(r2.filepath).mtimeMs).toBe(mtime1)
  })
})

describe('listArchivedPlans', () => {
  let testDataDir: string

  beforeEach(() => {
    testDataDir = TEST_DIR + '-data-' + Math.random().toString(36).slice(2)
    process.env['XDG_DATA_HOME'] = testDataDir
  })

  afterEach(() => {
    delete process.env['XDG_DATA_HOME']
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true })
    }
  })

  test('returns files newest-first', () => {
    const projectId = 'test-project-456'
    
    // Create older file first
    const older = new Date('2026-05-04T10:00:00.000Z')
    savePlanToArchive(projectId, '# Older Plan', older)
    
    // Create newer file second
    const newer = new Date('2026-05-04T12:00:00.000Z')
    savePlanToArchive(projectId, '# Newer Plan', newer)

    const plans = listArchivedPlans(projectId)

    expect(plans.length).toBe(2)
    expect(plans[0].title).toBe('Newer Plan')
    expect(plans[1].title).toBe('Older Plan')
    expect(plans[0].modifiedAt).toBeGreaterThan(plans[1].modifiedAt)
  })

  test('returns [] for missing dir', () => {
    const projectId = 'non-existent-project'
    const plans = listArchivedPlans(projectId)
    expect(plans).toEqual([])
  })

  test('skips non-file entries with .md extension', () => {
    const projectId = 'test-project-skip'
    savePlanToArchive(projectId, '# Real Plan', new Date('2026-05-04T12:00:00.000Z'))

    // Create a directory that ends in .md to simulate an unreadable entry
    const dir = resolvePlanArchiveDir(projectId)
    mkdirSync(join(dir, 'fake.md'), { recursive: true })

    const plans = listArchivedPlans(projectId)
    expect(plans.length).toBe(1)
    expect(plans[0].title).toBe('Real Plan')
  })
})

describe('readArchivedPlan', () => {
  let testDataDir: string

  beforeEach(() => {
    testDataDir = TEST_DIR + '-data-' + Math.random().toString(36).slice(2)
    process.env['XDG_DATA_HOME'] = testDataDir
  })

  afterEach(() => {
    delete process.env['XDG_DATA_HOME']
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true })
    }
  })

  test('reads the file content', () => {
    const projectId = 'test-project-789'
    const planText = '# Read Test\n\nSome content'
    const now = new Date('2026-05-04T12:34:56.789Z')

    const { filepath } = savePlanToArchive(projectId, planText, now)
    const content = readArchivedPlan(filepath)

    expect(content).toBe(planText)
  })
})

describe('resolvePlanArchiveDir', () => {
  let testDataDir: string

  beforeEach(() => {
    testDataDir = TEST_DIR + '-data-' + Math.random().toString(36).slice(2)
    process.env['XDG_DATA_HOME'] = testDataDir
  })

  afterEach(() => {
    delete process.env['XDG_DATA_HOME']
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true })
    }
  })

  test('returns the correct path', () => {
    const projectId = 'my-project'
    const dir = resolvePlanArchiveDir(projectId)
    expect(dir).toBe(join(testDataDir, 'opencode', 'forge', 'plans', projectId))
  })
})

describe('prunePlanArchive', () => {
  let testDataDir: string

  beforeEach(() => {
    testDataDir = TEST_DIR + '-data-' + Math.random().toString(36).slice(2)
    process.env['XDG_DATA_HOME'] = testDataDir
  })

  afterEach(() => {
    delete process.env['XDG_DATA_HOME']
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true })
    }
  })

  test('exports a 7-day default ttl', () => {
    expect(DEFAULT_PLAN_ARCHIVE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })

  test('removes plans older than ttlMs and keeps recent ones', () => {
    const projectId = 'test-project-prune'
    const now = new Date('2026-05-04T12:00:00.000Z')

    // Save two plans with different timestamps in the filename
    const oldPlan = savePlanToArchive(projectId, '# Old Plan', new Date('2026-04-01T00:00:00.000Z'))
    const recentPlan = savePlanToArchive(projectId, '# Recent Plan', new Date('2026-05-03T00:00:00.000Z'))

    // Force mtimes: old = 30 days before now, recent = 1 day before now
    const oldMtime = (now.getTime() - 30 * 24 * 60 * 60 * 1000) / 1000
    const recentMtime = (now.getTime() - 1 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(oldPlan.filepath, oldMtime, oldMtime)
    utimesSync(recentPlan.filepath, recentMtime, recentMtime)

    const removed = prunePlanArchive(projectId, 7 * 24 * 60 * 60 * 1000, now)

    expect(removed).toBe(1)
    expect(existsSync(oldPlan.filepath)).toBe(false)
    expect(existsSync(recentPlan.filepath)).toBe(true)
  })

  test('returns 0 and prunes nothing when ttlMs <= 0', () => {
    const projectId = 'test-project-no-prune'
    const { filepath } = savePlanToArchive(projectId, '# Plan', new Date('2020-01-01T00:00:00.000Z'))

    const removed = prunePlanArchive(projectId, 0)
    expect(removed).toBe(0)
    expect(existsSync(filepath)).toBe(true)

    const removedNeg = prunePlanArchive(projectId, -1000)
    expect(removedNeg).toBe(0)
    expect(existsSync(filepath)).toBe(true)
  })

  test('returns 0 for missing dir', () => {
    expect(prunePlanArchive('non-existent', 1000)).toBe(0)
  })

  test('savePlanToArchive prunes old entries automatically', () => {
    const projectId = 'test-project-auto-prune'
    const now = new Date('2026-05-04T12:00:00.000Z')

    // Seed an old file
    const old = savePlanToArchive(projectId, '# Old', new Date('2026-01-01T00:00:00.000Z'))
    const oldMtime = (now.getTime() - 30 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(old.filepath, oldMtime, oldMtime)

    // Save a fresh plan with default 7-day ttl
    const fresh = savePlanToArchive(projectId, '# Fresh', now)

    expect(fresh.pruned).toBe(1)
    expect(existsSync(old.filepath)).toBe(false)
    expect(existsSync(fresh.filepath)).toBe(true)
  })
})
