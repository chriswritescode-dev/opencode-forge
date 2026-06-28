import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFeatureGroupsRepo } from '../../src/storage/repos/feature-groups-repo'
import {
  createGroupOrchestrator,
  type GroupOrchestrator,
  type GroupEffects,
} from '../../src/services/group-orchestrator'
import { createGroupTools } from '../../src/tools/group'
import type { Logger } from '../../src/types'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

const PROJECT_ID = 'test-project'

function createDb() {
  const tempDir = mkdtempSync(join(tmpdir(), 'group-tools-test-'))
  const dbPath = join(tempDir, 'test.db')
  const db = new Database(dbPath)

  db.run(`
    CREATE TABLE IF NOT EXISTS feature_groups (
      project_id          TEXT NOT NULL,
      group_id            TEXT NOT NULL,
      title               TEXT NOT NULL,
      status              TEXT NOT NULL CHECK(status IN ('extracting','planning','running','completed','cancelled','errored','interrupted')),
      prd_text            TEXT,
      max_concurrent      INTEGER NOT NULL DEFAULT 3,
      execution_model     TEXT,
      auditor_model       TEXT,
      splitter_session_id TEXT,
      host_session_id     TEXT,
      error               TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      completed_at        INTEGER,
      PRIMARY KEY (project_id, group_id)
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_feature_groups_status ON feature_groups(project_id, status)')
  db.run('CREATE INDEX IF NOT EXISTS idx_feature_groups_splitter ON feature_groups(project_id, splitter_session_id)')
  db.run(`
    CREATE TABLE IF NOT EXISTS group_features (
      project_id           TEXT NOT NULL,
      group_id             TEXT NOT NULL,
      feature_index        INTEGER NOT NULL,
      title                TEXT NOT NULL,
      description          TEXT NOT NULL,
      stage                TEXT NOT NULL CHECK(stage IN ('pending','planning','planned','launching','running','completed','failed','cancelled')),
      architect_session_id TEXT,
      loop_name            TEXT,
      error                TEXT,
      attempts             INTEGER NOT NULL DEFAULT 0,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      PRIMARY KEY (project_id, group_id, feature_index),
      FOREIGN KEY (project_id, group_id) REFERENCES feature_groups(project_id, group_id) ON DELETE CASCADE
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_group_features_arch ON group_features(project_id, architect_session_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_group_features_loop ON group_features(project_id, loop_name)')
  db.run('CREATE INDEX IF NOT EXISTS idx_group_features_stage ON group_features(project_id, group_id, stage)')

  return { db, tempDir }
}

function createFakeEffects() {
  let splitterCounter = 1
  let archCounter = 0
  let loopCounter = 0

  return {
    spawnSplitterSession: vi.fn<[string], Promise<{ sessionId: string }>>().mockImplementation(async () => ({ sessionId: `splitter-${splitterCounter++}` })),
    readSplitterFeatures: vi.fn().mockResolvedValue({ ok: true, features: [] }),
    spawnArchitectSession: vi
      .fn<[{ title: string; description: string }], Promise<{ sessionId: string }>>()
      .mockImplementation(async () => ({ sessionId: `arch-session-${archCounter++}` })),
    capturePlan: vi.fn<[string], Promise<{ captured: boolean }>>().mockResolvedValue({ captured: true }),
    classifyArchitectFailure: vi.fn<[string], Promise<{ reason: string }>>().mockResolvedValue({
      reason: 'Insufficient context to generate a plan.',
    }),
    launchLoop: vi
      .fn<[{ architectSessionId: string; loopName: string }], Promise<{ ok: true; loopName: string } | { ok: false; error: string }>>()
      .mockImplementation(async ({ loopName }) => ({ ok: true as const, loopName })),
    cancelLoop: vi.fn<[string], Promise<void>>().mockResolvedValue(undefined),
    loopFinalOutcome: vi.fn<[string], 'completed' | 'failed' | 'unknown'>().mockReturnValue('completed'),
    generateLoopName: vi.fn<[string], string>().mockImplementation((base: string) => `loop-${base}-${loopCounter++}`),
  } satisfies GroupEffects
}

interface TestContext {
  db: Database
  repo: ReturnType<typeof createFeatureGroupsRepo>
  effects: ReturnType<typeof createFakeEffects>
  orchestrator: GroupOrchestrator
  tempDir: string
  tools: ReturnType<typeof createGroupTools>
}

function toolOutput(result: string | { output: string }): string {
  return typeof result === 'string' ? result : result.output
}

describe('Group tools', () => {
  let ctx: TestContext

  beforeEach(() => {
    const { db, tempDir } = createDb()
    const repo = createFeatureGroupsRepo(db)
    const effects = createFakeEffects()
    const orchestrator = createGroupOrchestrator({
      projectId: PROJECT_ID,
      repo,
      effects,
      cap: () => 2,
      logger: mockLogger,
    })
    const tools = createGroupTools({
      groupOrchestrator: orchestrator,
      featureGroupsRepo: repo,
      projectId: PROJECT_ID,
    } as any)
    ctx = { db, repo, effects, orchestrator, tempDir, tools }
  })

  afterEach(() => {
    ctx.db.close()
    try {
      rmSync(ctx.tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  // ── launch-group ──────────────────────────────────────────────────────────

  describe('launch-group', () => {
    test('returns validation error when neither prd nor features provided', async () => {
      const result = toolOutput(await ctx.tools['launch-group'].execute(
        { title: 'Test' },
        { sessionID: 'session-1' } as any,
      ))
      expect(result).toContain('Provide either prd')
    })

    test('returns validation error when both prd and features provided', async () => {
      const result = toolOutput(await ctx.tools['launch-group'].execute(
        {
          title: 'Test',
          prd: 'Some PRD text',
          features: [{ title: 'Feat 1', description: 'Desc 1' }],
        },
        { sessionID: 'session-1' } as any,
      ))
      expect(result).toContain('not both')
    })

    test('returns validation error when prd + empty features (both provided)', async () => {
      const result = toolOutput(await ctx.tools['launch-group'].execute(
        {
          title: 'Test',
          prd: 'Some PRD text',
          features: [],
        },
        { sessionID: 'session-1' } as any,
      ))
      expect(result).toContain('not both')
    })

    test('returns validation error when empty prd + features (both provided)', async () => {
      const result = toolOutput(await ctx.tools['launch-group'].execute(
        {
          title: 'Test',
          prd: '',
          features: [{ title: 'F', description: 'D' }],
        },
        { sessionID: 'session-1' } as any,
      ))
      expect(result).toContain('not both')
    })

    test('creates a group with pre-split features and returns groupId', async () => {
      const result = toolOutput(await ctx.tools['launch-group'].execute(
        {
          title: 'My Group',
          features: [
            { title: 'Feature A', description: 'Description A' },
            { title: 'Feature B', description: 'Description B' },
          ],
        },
        { sessionID: 'session-1' } as any,
      ))
      expect(result).toContain('"My Group" launched!')
      expect(result).toContain('Group ID:')
      expect(result).toContain('Status:')
      expect(result).toContain('Features: 2')
      expect(result).toContain('Use group-status to monitor')

      // Verify the group and features exist in the repo
      const groupId = result.match(/Group ID: (\S+)/)?.[1]
      expect(groupId).toBeTruthy()

      const group = ctx.repo.getGroup(PROJECT_ID, groupId!)
      expect(group).toBeTruthy()
      expect(group!.title).toBe('My Group')
      expect(group!.status).toBe('planning')

      const features = ctx.repo.listFeatures(PROJECT_ID, groupId!)
      expect(features).toHaveLength(2)
      expect(features[0].title).toBe('Feature A')
      expect(features[1].title).toBe('Feature B')
    })

    test('creates a group with prd text', async () => {
      const result = toolOutput(await ctx.tools['launch-group'].execute(
        {
          title: 'PRD Group',
          prd: 'This is a PRD with feature descriptions.',
        },
        { sessionID: 'session-1' } as any,
      ))
      expect(result).toContain('"PRD Group" launched!')
      expect(result).toContain('Group ID:')
      expect(result).toContain('Status: extracting')

      const groupId = result.match(/Group ID: (\S+)/)?.[1]
      expect(groupId).toBeTruthy()

      const group = ctx.repo.getGroup(PROJECT_ID, groupId!)
      expect(group).toBeTruthy()
      expect(group!.status).toBe('extracting')
      expect(group!.prdText).toBe('This is a PRD with feature descriptions.')
    })

    test('accepts maxConcurrentLoops and passes to orchestrator', async () => {
      const result = toolOutput(await ctx.tools['launch-group'].execute(
        {
          title: 'Cap Test',
          features: [{ title: 'F1', description: 'D1' }],
          maxConcurrentLoops: 5,
        },
        { sessionID: 'session-1' } as any,
      ))

      const groupId = result.match(/Group ID: (\S+)/)?.[1]
      const group = ctx.repo.getGroup(PROJECT_ID, groupId!)
      expect(group!.maxConcurrent).toBe(5)
    })
  })

  // ── group-status ──────────────────────────────────────────────────────────

  describe('group-status', () => {
    test('returns "No groups found" when no groups exist', async () => {
      const result = toolOutput(await ctx.tools['group-status'].execute({}, {} as any))
      expect(result).toBe('No groups found.')
    })

    test('lists groups when called with no arguments', async () => {
      await ctx.tools['launch-group'].execute(
        {
          title: 'Group Alpha',
          features: [{ title: 'F1', description: 'D1' }],
        },
        { sessionID: 'session-1' } as any,
      )
      await ctx.tools['launch-group'].execute(
        {
          title: 'Group Beta',
          features: [{ title: 'F2', description: 'D2' }],
        },
        { sessionID: 'session-2' } as any,
      )

      const result = toolOutput(await ctx.tools['group-status'].execute({}, {} as any))
      expect(result).toContain('Groups')
      expect(result).toContain('Group Alpha')
      expect(result).toContain('Group Beta')
    })

    test('shows detailed status for a specific groupId', async () => {
      const launchResult = toolOutput(await ctx.tools['launch-group'].execute(
        {
          title: 'Detailed Group',
          features: [
            { title: 'Feat X', description: 'Desc X' },
            { title: 'Feat Y', description: 'Desc Y' },
          ],
        },
        { sessionID: 'session-1' } as any,
      ))
      const groupId = launchResult.match(/Group ID: (\S+)/)?.[1]!

      const result = toolOutput(await ctx.tools['group-status'].execute(
        { groupId },
        {} as any,
      ))
      expect(result).toContain('Group Status')
      expect(result).toContain(groupId)
      expect(result).toContain('Detailed Group')
      expect(result).toContain('Feat X')
      expect(result).toContain('Feat Y')
      expect(result).toContain('Stage:')
    })

    test('returns not found for non-existent groupId', async () => {
      const result = toolOutput(await ctx.tools['group-status'].execute(
        { groupId: 'non-existent' },
        {} as any,
      ))
      expect(result).toContain('not found')
    })

    test('restart on non-existent group returns guidance message', async () => {
      const result = toolOutput(await ctx.tools['group-status'].execute(
        { groupId: 'non-existent', restart: true },
        {} as any,
      ))
      expect(result).toContain('not found')
    })

    test('restart on completed group returns guidance message', async () => {
      const launchResult = toolOutput(await ctx.tools['launch-group'].execute(
        {
          title: 'Complete Me',
          features: [{ title: 'F1', description: 'D1' }],
        },
        { sessionID: 'session-1' } as any,
      ))
      const groupId = launchResult.match(/Group ID: (\S+)/)?.[1]!

      // Complete the group through orchestrator
      await ctx.orchestrator.onArchitectIdle('arch-session-0')
      const features = ctx.repo.listFeatures(PROJECT_ID, groupId)
      await ctx.orchestrator.onLoopTerminated(features[0].loopName!)

      const result = toolOutput(await ctx.tools['group-status'].execute(
        { groupId, restart: true },
        {} as any,
      ))
      expect(result).toContain('completed')
      expect(result).toContain('cannot be restarted')
    })

    test('restart requires groupId', async () => {
      const result = toolOutput(await ctx.tools['group-status'].execute(
        { restart: true },
        {} as any,
      ))
      expect(result).toContain('Specify a groupId to restart')
    })
  })

  // ── group-cancel ──────────────────────────────────────────────────────────

  describe('group-cancel', () => {
    test('returns not found for non-existent groupId', async () => {
      const result = toolOutput(await ctx.tools['group-cancel'].execute(
        { groupId: 'non-existent' },
        {} as any,
      ))
      expect(result).toContain('not found')
    })

    test('cancels a group and its non-terminal features', async () => {
      const launchResult = toolOutput(await ctx.tools['launch-group'].execute(
        {
          title: 'Cancel Me',
          features: [{ title: 'F1', description: 'D1' }],
        },
        { sessionID: 'session-1' } as any,
      ))
      const groupId = launchResult.match(/Group ID: (\S+)/)?.[1]!

      const cancelResult = toolOutput(await ctx.tools['group-cancel'].execute(
        { groupId },
        {} as any,
      ))
      expect(cancelResult).toContain('Cancelled')
      expect(cancelResult).toContain(groupId)

      const group = ctx.repo.getGroup(PROJECT_ID, groupId)
      expect(group!.status).toBe('cancelled')
    })
  })
})
