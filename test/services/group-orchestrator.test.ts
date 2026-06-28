import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFeatureGroupsRepo } from '../../src/storage/repos/feature-groups-repo'
import {
  createGroupOrchestrator,
  mapLoopStateToOutcome,
  type GroupOrchestrator,
  type GroupEffects,
} from '../../src/services/group-orchestrator'
import type { Logger } from '../../src/types'
import type { ParsedFeature } from '../../src/utils/feature-list-parser'

/** External-control promise — resolve/reject from test code. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const PROJECT_ID = 'test-project'

const mockLogger: Logger = {
  log: () => {},
  error: () => {},
  debug: () => {},
}

interface TestContext {
  db: Database
  repo: ReturnType<typeof createFeatureGroupsRepo>
  effects: ReturnType<typeof createFakeEffects>
  orchestrator: GroupOrchestrator
  tempDir: string
}

function createDb() {
  const tempDir = mkdtempSync(join(tmpdir(), 'group-orch-test-'))
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

function makeFeatures(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    title: `Feature ${i}`,
    description: `Description for feature ${i}`,
  }))
}

describe('GroupOrchestrator', () => {
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
    ctx = { db, repo, effects, orchestrator, tempDir }
  })

  afterEach(() => {
    ctx.db.close()
    try {
      rmSync(ctx.tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  // ── startGroup ──────────────────────────────────────────────────────────

  test('startGroup with pre-split features spawns at most cap architect sessions', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Test Group',
      features: makeFeatures(5),
    })

    expect(result.status).toBe('planning')
    expect(result.groupId).toBeTruthy()

    // Should have spawned exactly cap=2 architect sessions
    expect(ctx.effects.spawnArchitectSession).toHaveBeenCalledTimes(2)

    const features = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    expect(features).toHaveLength(5)

    // First 2 features should be planning (cap filled)
    expect(features[0].stage).toBe('planning')
    expect(features[1].stage).toBe('planning')

    // Remaining 3 should stay pending
    expect(features[2].stage).toBe('pending')
    expect(features[3].stage).toBe('pending')
    expect(features[4].stage).toBe('pending')

    // Group status should be planning
    const group = ctx.repo.getGroup(PROJECT_ID, result.groupId)
    expect(group!.status).toBe('planning')
  })

  test('startGroup with fewer features than cap spawns sessions for all', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Small Group',
      features: makeFeatures(1),
    })

    expect(ctx.effects.spawnArchitectSession).toHaveBeenCalledTimes(1)

    const features = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    expect(features[0].stage).toBe('planning')
    expect(features).toHaveLength(1)
  })

  test('startGroup with zero features and no prd creates empty planning group', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Empty Group',
      features: [],
    })

    expect(result.status).toBe('planning')
    // No features, so no architect sessions to spawn
    expect(ctx.effects.spawnArchitectSession).toHaveBeenCalledTimes(0)

    const group = ctx.repo.getGroup(PROJECT_ID, result.groupId)
    expect(group!.status).toBe('completed') // empty features -> all terminal -> completed
  })

  test('startGroup with prd text creates extracting group and spawns splitter', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'PRD Group',
      prd: 'This is a PRD with feature descriptions.',
    })

    expect(result.status).toBe('extracting')
    expect(ctx.effects.spawnSplitterSession).toHaveBeenCalledTimes(1)
    expect(ctx.effects.spawnSplitterSession).toHaveBeenCalledWith('This is a PRD with feature descriptions.')

    const group = ctx.repo.getGroup(PROJECT_ID, result.groupId)
    expect(group!.status).toBe('extracting')
    expect(group!.splitterSessionId).toBe('splitter-1')
  })

  // ── onSplitterIdle ─────────────────────────────────────────────────────

  // Phase 8: premature-idle guard test goes here (currently removed for Phase 7)

  test('stale onSplitterIdle after restartGroup with replacement splitter does not apply old features (regression)', async () => {
    // Scenario: Splitter session A is awaiting readSplitterFeatures. The group
    // is interrupted and restarted, which spawns a new splitter session B and
    // returns the group to extracting. When A's read resolves, the old result
    // must NOT be applied because B is the authoritative splitter.

    // Defer readSplitterFeatures so onSplitterIdle pauses inside the await
    const readDef = deferred<{ ok: true; features: ParsedFeature[] }>()
    ctx.effects.readSplitterFeatures.mockReturnValue(readDef.promise)

    const result = await ctx.orchestrator.startGroup({
      title: 'Stale Splitter Race',
      prd: 'PRD text for extraction',
    })
    const gid = result.groupId
    const oldSessionId = ctx.repo.getGroup(PROJECT_ID, gid)!.splitterSessionId!
    expect(oldSessionId).toBe('splitter-1')

    // Begin onSplitterIdle(A) — pauses inside readSplitterFeatures
    const idlePromise = ctx.orchestrator.onSplitterIdle(oldSessionId)

    // Manually set group to interrupted (simulating external interrupt)
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'interrupted')

    // Restart the group — since status is interrupted, features is empty,
    // and prdText exists, restart spawns a new splitter session B.
    const restartResult = await ctx.orchestrator.restartGroup(gid)
    expect(restartResult.ok).toBe(true)
    expect(restartResult.message).toContain('extracting')

    // Group should now be extracting with the NEW splitter session
    const groupAfterRestart = ctx.repo.getGroup(PROJECT_ID, gid)
    const newSessionId = groupAfterRestart!.splitterSessionId!
    expect(newSessionId).toBe('splitter-2')
    expect(newSessionId).not.toBe(oldSessionId)
    expect(groupAfterRestart!.status).toBe('extracting')

    // No features should exist yet (restart goes back to extracting)
    expect(ctx.repo.listFeatures(PROJECT_ID, gid)).toHaveLength(0)

    // Resolve the OLD splitter's read with some features
    readDef.resolve({ ok: true, features: makeFeatures(2) })
    await idlePromise

    // Group should still be extracting with the NEW splitter session —
    // the old result must not have been applied
    const groupFinal = ctx.repo.getGroup(PROJECT_ID, gid)
    expect(groupFinal!.status).toBe('extracting')
    expect(groupFinal!.splitterSessionId).toBe(newSessionId)

    // No features should be inserted from the stale read
    expect(ctx.repo.listFeatures(PROJECT_ID, gid)).toHaveLength(0)

    // No architect sessions should have been spawned
    expect(ctx.effects.spawnArchitectSession).toHaveBeenCalledTimes(0)

    // The new splitter session should still be able to proceed normally
    // by resolving its own read
    ctx.effects.readSplitterFeatures.mockResolvedValue({ ok: true, features: makeFeatures(1) })
    await ctx.orchestrator.onSplitterIdle(newSessionId)

    const featuresAfterNew = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(featuresAfterNew).toHaveLength(1)
    expect(ctx.repo.getGroup(PROJECT_ID, gid)!.status).toBe('planning')
  })

  test('stale onSplitterIdle after restartGroup ignores old error result (regression)', async () => {
    // Same scenario but old splitter read returns ok:false — must not errored
    // the group when a replacement splitter is now authoritative.
    const readDef = deferred<{ ok: false; reason: 'missing' }>()
    ctx.effects.readSplitterFeatures.mockReturnValue(readDef.promise)

    const result = await ctx.orchestrator.startGroup({
      title: 'Stale Splitter Error Race',
      prd: 'PRD text',
    })
    const gid = result.groupId
    const oldSessionId = ctx.repo.getGroup(PROJECT_ID, gid)!.splitterSessionId!

    const idlePromise = ctx.orchestrator.onSplitterIdle(oldSessionId)

    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'interrupted')

    const restartResult = await ctx.orchestrator.restartGroup(gid)
    expect(restartResult.ok).toBe(true)

    const newSessionId = ctx.repo.getGroup(PROJECT_ID, gid)!.splitterSessionId!

    // Resolve OLD read with an error
    readDef.resolve({ ok: false, reason: 'missing' })
    await idlePromise

    // Group must NOT be errored — should still be extracting with new session
    const groupFinal = ctx.repo.getGroup(PROJECT_ID, gid)
    expect(groupFinal!.status).toBe('extracting')
    expect(groupFinal!.splitterSessionId).toBe(newSessionId)
    expect(groupFinal!.error).toBeNull()
  })

  // ── onArchitectIdle capture flow ─────────────────────────────────────────

  test('onArchitectIdle with captured plan transitions feature to planned and launches up to cap', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Cap Test',
      features: makeFeatures(3),
    })

    // After startGroup: features 0,1 are planning (cap=2), feature 2 is pending
    // Two architect sessions were spawned: arch-session-0, arch-session-1
    const features0 = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    expect(features0[0].architectSessionId).toBe('arch-session-0')
    expect(features0[1].architectSessionId).toBe('arch-session-1')

    // onArchitectIdle for feature 0 — plan captured, should transition to planned
    // and trigger drive which will:
    //   - schedule feature 2 for planning (pending->planning)
    //   - launch feature 0 (planned->launching->running)
    await ctx.orchestrator.onArchitectIdle('arch-session-0')

    // Feature 0 should now be running (plan captured + launched)
    // Feature 2 should be planning (scheduled by drive)
    const features1 = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    expect(features1[0].stage).toBe('running')
    expect(features1[2].stage).toBe('planning')

    // Feature 2 should have gotten an architect session
    expect(features1[2].architectSessionId).toBe('arch-session-2')

    // A loop should have been launched for feature 0
    expect(ctx.effects.launchLoop).toHaveBeenCalledTimes(1)
    expect(features1[0].loopName).toBeTruthy()

    // Feature 1 should still be planning (its architect is still running)
    expect(features1[1].stage).toBe('planning')
  })

  test('onArchitectIdle for all features launches remaining within cap', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Full Cycle',
      features: makeFeatures(3),
    })

    // Feature 0 captured and launched
    await ctx.orchestrator.onArchitectIdle('arch-session-0')

    // Feature 1 captured — should launch (cap=2, only 1 running currently)
    await ctx.orchestrator.onArchitectIdle('arch-session-1')

    const featuresAfter1 = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    expect(featuresAfter1[0].stage).toBe('running')
    expect(featuresAfter1[1].stage).toBe('running')

    // Feature 2 should still be planning (both running slots full)
    expect(featuresAfter1[2].stage).toBe('planning')
    expect(ctx.effects.launchLoop).toHaveBeenCalledTimes(2)
  })

  // ── onArchitectIdle failure path ─────────────────────────────────────────

  test('onArchitectIdle with failed capture marks feature as failed and does not consume loop slot', async () => {
    // Override capturePlan to return false
    ctx.effects.capturePlan.mockResolvedValue({ captured: false })

    const result = await ctx.orchestrator.startGroup({
      title: 'Failure Test',
      features: makeFeatures(2),
    })

    // Feature 0 architect fails
    await ctx.orchestrator.onArchitectIdle('arch-session-0')

    // Feature 0 should be failed
    const features = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    expect(features[0].stage).toBe('failed')
    expect(features[0].error).toBe('Insufficient context to generate a plan.')

    // classifyArchitectFailure should have been called
    expect(ctx.effects.classifyArchitectFailure).toHaveBeenCalledWith('arch-session-0')

    // No loop should have been launched for failed feature
    expect(ctx.effects.launchLoop).toHaveBeenCalledTimes(0)
  })

  // Phase 8: premature-idle guard test goes here (currently removed for Phase 7)

  // ── onLoopTerminated + queue draining ────────────────────────────────────

  test('onLoopTerminated for completed feature launches next queued planned feature', async () => {
    // Use cap=1 so features queue as planned while one runs
    const repo = ctx.repo
    const effects = ctx.effects
    const queueOrch = createGroupOrchestrator({
      projectId: PROJECT_ID,
      repo,
      effects,
      cap: () => 1,
      logger: mockLogger,
    })

    const result = await queueOrch.startGroup({
      title: 'Queue Drain',
      features: makeFeatures(2),
    })

    // After startGroup: feature 0 is planning (cap=1), feature 1 is pending
    await queueOrch.onArchitectIdle('arch-session-0')
    // Feature 0: planning→planned→launching→running (drive launches it)
    // Feature 1: pending→planning (drive schedules it)

    let features = repo.listFeatures(PROJECT_ID, result.groupId)
    const loopName0 = features[0].loopName!

    await queueOrch.onArchitectIdle('arch-session-1')
    // Feature 1: planning→planned (captured)
    // drive: runningInFlight=1 (feature 0) → launchSlots=0 → feature 1 stays planned

    features = repo.listFeatures(PROJECT_ID, result.groupId)
    expect(features[1].stage).toBe('planned')

    // Terminate feature 0's loop — should drain queue and launch feature 1
    await queueOrch.onLoopTerminated(loopName0)

    features = repo.listFeatures(PROJECT_ID, result.groupId)
    expect(features[0].stage).toBe('completed')
    expect(features[1].stage).toBe('running')
    expect(features[1].loopName).toBeTruthy()
    expect(effects.launchLoop).toHaveBeenCalledTimes(2)
  })

  test('onLoopTerminated with failed outcome marks feature as failed', async () => {
    ctx.effects.loopFinalOutcome.mockReturnValue('failed')

    const result = await ctx.orchestrator.startGroup({
      title: 'Loop Fail',
      features: makeFeatures(1),
    })

    await ctx.orchestrator.onArchitectIdle('arch-session-0')

    const features = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    const loopName = features[0].loopName!

    await ctx.orchestrator.onLoopTerminated(loopName)

    const featuresAfter = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    expect(featuresAfter[0].stage).toBe('failed')
    expect(featuresAfter[0].error).toBe('Loop execution failed')
  })

  test('onLoopTerminated with unknown outcome leaves feature running', async () => {
    ctx.effects.loopFinalOutcome.mockReturnValue('unknown')

    const result = await ctx.orchestrator.startGroup({
      title: 'Loop Unknown',
      features: makeFeatures(1),
    })

    await ctx.orchestrator.onArchitectIdle('arch-session-0')

    const features = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    const loopName = features[0].loopName!

    await ctx.orchestrator.onLoopTerminated(loopName)

    const featuresAfter = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    // Should remain running since outcome is unknown
    expect(featuresAfter[0].stage).toBe('running')
  })

  test('onLoopTerminated for non-group loop is silently ignored', async () => {
    // No feature has this loop name
    await expect(ctx.orchestrator.onLoopTerminated('non-group-loop')).resolves.toBeUndefined()
  })

  // ── Completion detection ────────────────────────────────────────────────

  test('group becomes completed when all features are terminal', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Complete Test',
      features: makeFeatures(1),
    })

    await ctx.orchestrator.onArchitectIdle('arch-session-0')

    const features = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    const loopName = features[0].loopName!

    await ctx.orchestrator.onLoopTerminated(loopName)

    const group = ctx.repo.getGroup(PROJECT_ID, result.groupId)
    expect(group!.status).toBe('completed')
    expect(group!.completedAt).not.toBeNull()
  })

  test('group with no features starts and completes immediately', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Empty Completes',
      features: [],
    })

    expect(result.status).toBe('planning')

    const group = ctx.repo.getGroup(PROJECT_ID, result.groupId)
    expect(group!.status).toBe('completed')
    expect(group!.completedAt).not.toBeNull()
  })

  // ── cancelGroup ─────────────────────────────────────────────────────────

  test('cancelGroup sets group and non-terminal features to cancelled', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Cancel Test',
      features: makeFeatures(2),
    })

    await ctx.orchestrator.cancelGroup(result.groupId)

    const group = ctx.repo.getGroup(PROJECT_ID, result.groupId)
    expect(group!.status).toBe('cancelled')

    const features = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    expect(features[0].stage).toBe('cancelled')
    expect(features[1].stage).toBe('cancelled')
  })

  test('cancelGroup with cancelRunningLoops cancels running loops', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Cancel Running',
      features: makeFeatures(1),
    })

    await ctx.orchestrator.onArchitectIdle('arch-session-0')

    const features = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    const loopName = features[0].loopName!

    await ctx.orchestrator.cancelGroup(result.groupId, { cancelRunningLoops: true })

    expect(ctx.effects.cancelLoop).toHaveBeenCalledWith(loopName)
  })

  test('cancelGroup on non-existent group is a no-op', async () => {
    await expect(ctx.orchestrator.cancelGroup('non-existent')).resolves.toBeUndefined()
  })

  // ── Late callback guards (regression: cancelled work must not be resurrected) ─

  test('late onSplitterIdle after cancelGroup does not resurrect cancelled group', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Late Splitter',
      prd: 'PRD text',
    })

    const gid = result.groupId
    const splitterSessionId = ctx.repo.getGroup(PROJECT_ID, gid)!.splitterSessionId!

    // Cancel the group before the splitter idles
    await ctx.orchestrator.cancelGroup(gid)

    // Late idle callback arrives after cancellation
    await ctx.orchestrator.onSplitterIdle(splitterSessionId)

    // Group should remain cancelled, no features inserted, status not changed to planning
    const group = ctx.repo.getGroup(PROJECT_ID, gid)
    expect(group!.status).toBe('cancelled')

    const features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features).toHaveLength(0)

    // No architect sessions should have been spawned
    expect(ctx.effects.spawnArchitectSession).toHaveBeenCalledTimes(0)
  })

  test('late onSplitterIdle after group errored does not resurrect', async () => {
    // Simulate a PRD group where the splitter never idled but group was errored
    const result = await ctx.orchestrator.startGroup({
      title: 'Late Splitter Errored',
      prd: 'PRD text',
    })

    const gid = result.groupId
    const splitterSessionId = ctx.repo.getGroup(PROJECT_ID, gid)!.splitterSessionId!

    // Manually set group to errored (like an external interruption)
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'errored', { error: 'external error' })

    // Late idle callback arrives
    await ctx.orchestrator.onSplitterIdle(splitterSessionId)

    // Group should remain errored
    const group = ctx.repo.getGroup(PROJECT_ID, gid)
    expect(group!.status).toBe('errored')

    const features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features).toHaveLength(0)
  })

  test('late onArchitectIdle after cancelGroup does not resurrect cancelled feature', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Late Architect',
      features: makeFeatures(2),
    })

    const gid = result.groupId
    const archSessionId = ctx.repo.listFeatures(PROJECT_ID, gid)[0].architectSessionId!

    // Cancel the group (features get set to cancelled)
    await ctx.orchestrator.cancelGroup(gid)

    // Late architect idle callback arrives after cancellation
    await ctx.orchestrator.onArchitectIdle(archSessionId)

    // Feature should remain cancelled
    const features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].stage).toBe('cancelled')

    // capturePlan should not have been called (the guard bails before async work)
    // Actually the guard checks stage and bails before capturePlan, but our mock captures anyway
    // The key assertion is that the feature stage didn't change from cancelled
    expect(features[0].stage).toBe('cancelled')
  })

  test('late onArchitectIdle after group is interrupted does not change feature', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Interrupted Architect',
      features: makeFeatures(1),
    })

    const gid = result.groupId
    const archSessionId = ctx.repo.listFeatures(PROJECT_ID, gid)[0].architectSessionId!

    // Manually set group to interrupted — feature stays in planning stage
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'interrupted')

    // Late architect idle callback
    await ctx.orchestrator.onArchitectIdle(archSessionId)

    // Feature should still be planning (guard bails because group is not active)
    const features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].stage).toBe('planning')
  })

  test('late onLoopTerminated after cancelGroup does not resurrect cancelled feature', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Late Loop Terminated',
      features: makeFeatures(1),
    })

    // Let architect capture and launch loop
    await ctx.orchestrator.onArchitectIdle('arch-session-0')

    const features = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    const loopName = features[0].loopName!
    expect(features[0].stage).toBe('running')

    // Cancel the group without cancelRunningLoops — feature still gets set to cancelled
    await ctx.orchestrator.cancelGroup(result.groupId)

    // Late loop terminated callback
    await ctx.orchestrator.onLoopTerminated(loopName)

    // Feature should remain cancelled
    const featuresAfter = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    expect(featuresAfter[0].stage).toBe('cancelled')
  })

  test('late onLoopTerminated for a feature that was already completed is idempotent', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Idempotent Loop',
      features: makeFeatures(1),
    })

    // Complete the feature normally
    await ctx.orchestrator.onArchitectIdle('arch-session-0')
    const features = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    const loopName = features[0].loopName!
    await ctx.orchestrator.onLoopTerminated(loopName)

    // Call onLoopTerminated again with the same loop name
    await ctx.orchestrator.onLoopTerminated(loopName)

    // Feature should still be completed
    const featuresAfter = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    expect(featuresAfter[0].stage).toBe('completed')
  })

  test('onLoopTerminated for an interrupted group does not mutate features or launch new loops', async () => {
    // Use cap=1: feature 0 runs, feature 1 goes planning→planned
    const repo = ctx.repo
    const effects = ctx.effects
    const queueOrch = createGroupOrchestrator({
      projectId: PROJECT_ID,
      repo,
      effects,
      cap: () => 1,
      logger: mockLogger,
    })

    const result = await queueOrch.startGroup({
      title: 'Interrupted Loop Term',
      features: makeFeatures(2),
    })
    const gid = result.groupId

    // Feature 0: planning→planned→launching→running (drive launches it)
    // Feature 1: pending→planning (drive schedules architect)
    await queueOrch.onArchitectIdle('arch-session-0')

    // Feature 1: planning→planned (captured)
    // drive: runningInFlight=1 → launchSlots=0 → feature 1 stays planned
    await queueOrch.onArchitectIdle('arch-session-1')

    let features = repo.listFeatures(PROJECT_ID, gid)
    const loopName0 = features[0].loopName!
    expect(features[0].stage).toBe('running')
    expect(features[1].stage).toBe('planned')

    // Interrupt the group (feature stages remain unchanged)
    repo.setGroupStatus(PROJECT_ID, gid, 'interrupted')

    // Capture launch loop count before the callback
    const launchCountBefore = effects.launchLoop.mock.calls.length

    // Call onLoopTerminated for the running loop
    await queueOrch.onLoopTerminated(loopName0)

    features = repo.listFeatures(PROJECT_ID, gid)

    // Feature 0 should still be running (group was interrupted, so we bailed)
    expect(features[0].stage).toBe('running')

    // Feature 1 should still be planned (no new loop launched)
    expect(features[1].stage).toBe('planned')

    // No new launchLoop calls
    expect(effects.launchLoop).toHaveBeenCalledTimes(launchCountBefore)

    // Group should remain interrupted
    const group = repo.getGroup(PROJECT_ID, gid)
    expect(group!.status).toBe('interrupted')
  })

  // ── Stale-state race guards (cancelGroup during async effect) ────────────

  test('cancelGroup during readSplitterFeatures await prevents resurrecting cancelled group', async () => {
    const splitterDeferred = deferred<{ ok: true; features: ParsedFeature[] }>()
    ctx.effects.readSplitterFeatures.mockReturnValue(splitterDeferred.promise)

    const result = await ctx.orchestrator.startGroup({
      title: 'Race Splitter',
      prd: 'PRD text',
    })
    const gid = result.groupId
    const splitterSessionId = ctx.repo.getGroup(PROJECT_ID, gid)!.splitterSessionId!

    // Start onSplitterIdle — pauses inside readSplitterFeatures
    const idlePromise = ctx.orchestrator.onSplitterIdle(splitterSessionId)

    // Cancel while the effect is pending
    await ctx.orchestrator.cancelGroup(gid)

    // Resolve the deferred splitter features
    splitterDeferred.resolve({ ok: true, features: makeFeatures(2) })
    await idlePromise

    // Group should remain cancelled, no features extracted
    const group = ctx.repo.getGroup(PROJECT_ID, gid)
    expect(group!.status).toBe('cancelled')

    const features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features).toHaveLength(0)

    // No architect sessions should have been spawned
    expect(ctx.effects.spawnArchitectSession).toHaveBeenCalledTimes(0)
  })

  test('cancelGroup during capturePlan await does not resurrect cancelled feature (safe path)', async () => {
    const captureDeferred = deferred<{ captured: boolean }>()
    ctx.effects.capturePlan.mockReturnValue(captureDeferred.promise)

    const result = await ctx.orchestrator.startGroup({
      title: 'Race Capture',
      features: makeFeatures(2),
    })
    const gid = result.groupId

    const features0 = ctx.repo.listFeatures(PROJECT_ID, gid)
    const archSessionId0 = features0[0].architectSessionId!

    // onArchitectIdle pauses inside capturePlan
    const idlePromise = ctx.orchestrator.onArchitectIdle(archSessionId0)

    // Cancel while capturePlan is pending
    await ctx.orchestrator.cancelGroup(gid)

    // Resolve the deferred capture — feature should be cancelled now
    captureDeferred.resolve({ captured: true })
    await idlePromise

    // Feature should remain cancelled (the claimFeatureStage after await
    // atomically checks stage and fails because stage is cancelled)
    const features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].stage).toBe('cancelled')

    // No loops should have been launched
    expect(ctx.effects.launchLoop).toHaveBeenCalledTimes(0)
  })

  test('cancelGroup during classifyArchitectFailure await prevents stale failed mutation', async () => {
    // Make capturePlan return captured=false so we go to the failure path
    ctx.effects.capturePlan.mockResolvedValue({ captured: false })

    const classifyDeferred = deferred<{ reason: string }>()
    ctx.effects.classifyArchitectFailure.mockReturnValue(classifyDeferred.promise)

    const result = await ctx.orchestrator.startGroup({
      title: 'Race Classify',
      features: makeFeatures(2),
    })
    const gid = result.groupId

    const features0 = ctx.repo.listFeatures(PROJECT_ID, gid)
    const archSessionId0 = features0[0].architectSessionId!

    // onArchitectIdle pauses inside classifyArchitectFailure
    const idlePromise = ctx.orchestrator.onArchitectIdle(archSessionId0)

    // Cancel while classifyArchitectFailure is pending
    await ctx.orchestrator.cancelGroup(gid)

    // Resolve the deferred classification
    classifyDeferred.resolve({ reason: 'Insufficient context.' })
    await idlePromise

    // Feature should remain cancelled, not failed
    const features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].stage).toBe('cancelled')

    // No loops should have been launched
    expect(ctx.effects.launchLoop).toHaveBeenCalledTimes(0)
  })

  test('cancelGroup during spawnArchitectSession await in drive prevents orphaned session on cancelled feature', async () => {
    const archDeferred = deferred<{ sessionId: string }>()
    ctx.effects.spawnArchitectSession.mockReturnValue(archDeferred.promise)

    // startGroup calls drive() internally; drive pauses at the first
    // await spawnArchitectSession
    const startPromise = ctx.orchestrator.startGroup({
      title: 'Race Arch Spawn',
      features: makeFeatures(2),
    })

    // Wait for drive to hit the await — the startGroup promise is still pending
    // Cancel the group while spawnArchitectSession is pending
    // We can't get groupId yet because startGroup hasn't returned. Instead,
    // use the mock to intercept: spawnSplitterSession resolves immediately
    // so startGroup reaches drive() and drive hits spawnArchitectSession await.
    // We need the groupId — let's capture it from the effects call.
    // Actually, we can use a different approach: startGroup calls drive which
    // calls spawnArchitectSession. Let's wait for the mock to be called.
    await vi.waitFor(() => {
      expect(ctx.effects.spawnArchitectSession).toHaveBeenCalledTimes(1)
    })

    // Now we need the group id. We can get it from the repo directly.
    const groups = ctx.repo.listGroups(PROJECT_ID)
    expect(groups).toHaveLength(1)
    const gid = groups[0].groupId

    // Cancel while spawnArchitectSession is pending
    await ctx.orchestrator.cancelGroup(gid)

    // Resolve the deferred architect spawn
    archDeferred.resolve({ sessionId: 'late-arch-session' })

    // Wait for startGroup to complete
    const result = await startPromise
    expect(result.status).toBe('planning')

    // Group should be cancelled
    const group = ctx.repo.getGroup(PROJECT_ID, gid)
    expect(group!.status).toBe('cancelled')

    // Feature0 should be cancelled, no architect session set
    const features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].stage).toBe('cancelled')
    // The revalidation should prevent setFeatureArchitectSession
    expect(features[0].architectSessionId).toBeNull()
  })

  test('cancelGroup during launchLoop await in drive prevents orphaned loop on cancelled feature', async () => {
    // First architect captures plan normally
    const result = await ctx.orchestrator.startGroup({
      title: 'Race Launch',
      features: makeFeatures(1),
    })
    const gid = result.groupId

    // Feature0 architect captures plan -> goes to planned
    await ctx.orchestrator.onArchitectIdle('arch-session-0')

    // Now launchLoop is about to be called by drive.
    // Make launchLoop return a deferred promise
    const launchDeferred = deferred<{ ok: true; loopName: string } | { ok: false; error: string }>()
    ctx.effects.launchLoop.mockReturnValue(launchDeferred.promise)

    // onArchitectIdle calls drive(), which hits the toLaunch loop and awaits launchLoop
    // But we already called onArchitectIdle above and it completed. Let's use a
    // different approach: create an orchestrator with cap=1, have feature0 go
    // through architect and start launching, then pause at launchLoop.
    //
    // Actually, the simpler approach: make capturePlan return deferred,
    // resolve it, then make launchLoop also deferred.

    // Hmm, this is tricky because onArchitectIdle calls capturePlan first,
    // then drive() which calls launchLoop. Let me restructure:
    // 1. Make both capturePlan and launchLoop deferred
    // 2. Start the architect idle sequence
    // 3. Resolve capturePlan (drive will then hit launchLoop await)
    // 4. Cancel while launchLoop is pending
    // 5. Resolve launchLoop
    // 6. Assert feature is cancelled

    // Reset for a clean path
    const arch2Result = await ctx.orchestrator.startGroup({
      title: 'Race Launch V2',
      features: makeFeatures(1),
    })
    const gid2 = arch2Result.groupId

    const captureDef = deferred<{ captured: boolean }>()
    const launchDef = deferred<{ ok: true; loopName: string } | { ok: false; error: string }>()
    ctx.effects.capturePlan.mockReturnValue(captureDef.promise)
    ctx.effects.launchLoop.mockReturnValue(launchDef.promise)

    const features0 = ctx.repo.listFeatures(PROJECT_ID, gid2)
    const archSessionId0 = features0[0].architectSessionId!

    // Start onArchitectIdle — pauses inside capturePlan
    const idlePromise2 = ctx.orchestrator.onArchitectIdle(archSessionId0)

    // Resolve capturePlan — onArchitectIdle continues, calls drive, which hits launchLoop await
    captureDef.resolve({ captured: true })

    // Wait for launchLoop to be called
    await vi.waitFor(() => {
      expect(ctx.effects.launchLoop).toHaveBeenCalledTimes(1)
    })

    // Cancel while launchLoop is pending
    await ctx.orchestrator.cancelGroup(gid2)

    // Resolve launchLoop
    launchDef.resolve({ ok: true, loopName: 'some-loop' })
    await idlePromise2

    // Feature should remain cancelled
    const features2 = ctx.repo.listFeatures(PROJECT_ID, gid2)
    expect(features2[0].stage).toBe('cancelled')
    expect(features2[0].loopName).toBeNull()

    // Group should be cancelled
    const group2 = ctx.repo.getGroup(PROJECT_ID, gid2)
    expect(group2!.status).toBe('cancelled')
  })

  // ── Interruption races (markInterrupted during async effects) ────────────

  test('markInterrupted during capturePlan await prevents feature stage transition', async () => {
    const captureDeferred = deferred<{ captured: boolean }>()
    ctx.effects.capturePlan.mockReturnValue(captureDeferred.promise)

    const result = await ctx.orchestrator.startGroup({
      title: 'Interrupt Capture',
      features: makeFeatures(1),
    })
    const gid = result.groupId

    const features0 = ctx.repo.listFeatures(PROJECT_ID, gid)
    const archSessionId0 = features0[0].architectSessionId!

    // onArchitectIdle pauses inside capturePlan
    const idlePromise = ctx.orchestrator.onArchitectIdle(archSessionId0)

    // Mark group as interrupted while capturePlan is pending
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'interrupted')

    // Resolve capturePlan — the group is now interrupted
    captureDeferred.resolve({ captured: true })
    await idlePromise

    // Feature should remain in planning stage (interruption doesn't change stages)
    const features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].stage).toBe('planning')

    // No loop should have been launched
    expect(ctx.effects.launchLoop).toHaveBeenCalledTimes(0)
  })

  test('markInterrupted during classifyArchitectFailure await prevents stale failed mutation', async () => {
    // Make capturePlan return captured=false so classifyArchitectFailure is called
    ctx.effects.capturePlan.mockResolvedValue({ captured: false })

    const classifyDeferred = deferred<{ reason: string }>()
    ctx.effects.classifyArchitectFailure.mockReturnValue(classifyDeferred.promise)

    const result = await ctx.orchestrator.startGroup({
      title: 'Interrupt Classify',
      features: makeFeatures(1),
    })
    const gid = result.groupId

    const features0 = ctx.repo.listFeatures(PROJECT_ID, gid)
    const archSessionId0 = features0[0].architectSessionId!

    // onArchitectIdle pauses inside classifyArchitectFailure
    const idlePromise = ctx.orchestrator.onArchitectIdle(archSessionId0)

    // Mark group as interrupted while classifyArchitectFailure is pending
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'interrupted')

    // Resolve classification
    classifyDeferred.resolve({ reason: 'Insufficient context.' })
    await idlePromise

    // Feature should remain planning (not failed)
    const features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].stage).toBe('planning')
    expect(features[0].error).toBeNull()

    // No loops should have been launched
    expect(ctx.effects.launchLoop).toHaveBeenCalledTimes(0)
  })

  test('markInterrupted during spawnArchitectSession await prevents orphaned session on interrupted group', async () => {
    const archDeferred = deferred<{ sessionId: string }>()
    ctx.effects.spawnArchitectSession.mockReturnValue(archDeferred.promise)

    // startGroup calls drive() internally; drive pauses at spawnArchitectSession await
    const startPromise = ctx.orchestrator.startGroup({
      title: 'Interrupt Arch Spawn',
      features: makeFeatures(2),
    })

    // Wait for spawnArchitectSession to be called
    await vi.waitFor(() => {
      expect(ctx.effects.spawnArchitectSession).toHaveBeenCalledTimes(1)
    })

    const groups = ctx.repo.listGroups(PROJECT_ID)
    expect(groups).toHaveLength(1)
    const gid = groups[0].groupId

    // Mark group as interrupted while spawnArchitectSession is pending
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'interrupted')

    // Resolve the deferred architect spawn
    archDeferred.resolve({ sessionId: 'late-arch-session' })

    // Wait for startGroup to complete
    const result = await startPromise
    expect(result.status).toBe('planning')

    // Feature should not have an architect session set (guard bailed after await).
    // Stage stays 'planning' because claimFeatureStage(...,'pending','planning')
    // succeeded synchronously before the await.
    const features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].architectSessionId).toBeNull()
    expect(features[0].stage).toBe('planning')

    // No additional spawnArchitectSession calls beyond the first (drive aborted after return)
    expect(ctx.effects.spawnArchitectSession).toHaveBeenCalledTimes(1)
  })

  test('markInterrupted during spawnArchitectSession aborts drive — no sessions spawned for remaining features', async () => {
    // 3 features with cap=3 means all 3 would be planned. We defer the first
    // spawnArchitectSession, interrupt the group, and verify no sessions for 1+.
    const archDeferred = deferred<{ sessionId: string }>()
    ctx.effects.spawnArchitectSession.mockReturnValue(archDeferred.promise)

    const startPromise = ctx.orchestrator.startGroup({
      title: 'Interrupt Multi Arch',
      features: makeFeatures(3),
    })

    await vi.waitFor(() => {
      expect(ctx.effects.spawnArchitectSession).toHaveBeenCalledTimes(1)
    })

    const groups = ctx.repo.listGroups(PROJECT_ID)
    const gid = groups[0].groupId

    // Interrupt while feature 0's spawnArchitectSession is pending
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'interrupted')

    archDeferred.resolve({ sessionId: 'late-arch-session' })
    await startPromise

    // Only 1 spawn call — features 1 and 2 were never spawned
    expect(ctx.effects.spawnArchitectSession).toHaveBeenCalledTimes(1)

    const features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].architectSessionId).toBeNull()
    // features 1 and 2 should still be pending (never claimed)
    expect(features[1].stage).toBe('pending')
    expect(features[2].stage).toBe('pending')
  })

  test('markInterrupted during launchLoop aborts drive — no loops launched for remaining planned features', async () => {
    // Use cap=2: 2 features. Feature 0 goes through architect (plan captured),
    // drive tries to launch both. Defer the launchLoop for feature 0,
    // interrupt, verify no launchLoop for feature 1.
    const result = await ctx.orchestrator.startGroup({
      title: 'Interrupt Multi Launch',
      features: makeFeatures(2),
    })
    const gid = result.groupId

    const launchDef = deferred<{ ok: true; loopName: string } | { ok: false; error: string }>()
    ctx.effects.launchLoop.mockReturnValue(launchDef.promise)

    const captureDef = deferred<{ captured: boolean }>()
    ctx.effects.capturePlan.mockReturnValue(captureDef.promise)

    const features0 = ctx.repo.listFeatures(PROJECT_ID, gid)
    const archSessionId0 = features0[0].architectSessionId!

    // Start onArchitectIdle — pauses inside capturePlan
    const idlePromise = ctx.orchestrator.onArchitectIdle(archSessionId0)

    // Resolve capturePlan — onArchitectIdle continues, calls drive, hits launchLoop await
    captureDef.resolve({ captured: true })

    await vi.waitFor(() => {
      expect(ctx.effects.launchLoop).toHaveBeenCalledTimes(1)
    })

    // Mark group as interrupted while launchLoop is pending for feature 0
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'interrupted')

    // Resolve launchLoop — drive should return before processing feature 1
    launchDef.resolve({ ok: true, loopName: 'some-loop' })
    await idlePromise

    // Only 1 launchLoop call — feature 1 was never launched
    expect(ctx.effects.launchLoop).toHaveBeenCalledTimes(1)

    const features = ctx.repo.listFeatures(PROJECT_ID, gid)
    // Feature 0: loop name nulled, stage stays launching
    expect(features[0].loopName).toBeNull()
    expect(features[0].stage).toBe('launching')
    // Feature 1 should remain planning (its architect session was never resolved)
    expect(features[1].stage).toBe('planning')
  })

  test('markInterrupted during launchLoop await prevents loop being recorded on interrupted group', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Interrupt Launch',
      features: makeFeatures(1),
    })
    const gid = result.groupId

    // Set up deferred launchLoop
    const launchDef = deferred<{ ok: true; loopName: string } | { ok: false; error: string }>()
    ctx.effects.launchLoop.mockReturnValue(launchDef.promise)

    // Let architect go through capture (synchronous resolve)
    const captureDef = deferred<{ captured: boolean }>()
    ctx.effects.capturePlan.mockReturnValue(captureDef.promise)

    const features0 = ctx.repo.listFeatures(PROJECT_ID, gid)
    const archSessionId0 = features0[0].architectSessionId!

    // Start onArchitectIdle — pauses inside capturePlan
    const idlePromise = ctx.orchestrator.onArchitectIdle(archSessionId0)

    // Resolve capturePlan — onArchitectIdle continues, calls drive, which hits launchLoop await
    captureDef.resolve({ captured: true })

    // Wait for launchLoop to be called
    await vi.waitFor(() => {
      expect(ctx.effects.launchLoop).toHaveBeenCalledTimes(1)
    })

    // Mark group as interrupted while launchLoop is pending
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'interrupted')

    // Resolve launchLoop
    launchDef.resolve({ ok: true, loopName: 'some-loop' })
    await idlePromise

    // Feature should not have a loop name (group was interrupted)
    const features2 = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features2[0].loopName).toBeNull()
    // Feature stage should still be launching (the claimFeatureStage to 'launching' happened
    // synchronously before the await, but the group is interrupted so no 'running' claim)
    expect(features2[0].stage).toBe('launching')

    // Group should remain interrupted
    const group2 = ctx.repo.getGroup(PROJECT_ID, gid)
    expect(group2!.status).toBe('interrupted')
  })

  // ── restartGroup ────────────────────────────────────────────────────────

  test('restartGroup on completed group returns ok:false', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Restart Completed',
      features: makeFeatures(1),
    })

    await ctx.orchestrator.onArchitectIdle('arch-session-0')
    const features = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    await ctx.orchestrator.onLoopTerminated(features[0].loopName!)

    const restartResult = await ctx.orchestrator.restartGroup(result.groupId)
    expect(restartResult.ok).toBe(false)
    expect(restartResult.message).toContain('completed')
  })

  test('restartGroup on cancelled group returns ok:false', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Restart Cancelled',
      features: makeFeatures(1),
    })

    await ctx.orchestrator.cancelGroup(result.groupId)

    const restartResult = await ctx.orchestrator.restartGroup(result.groupId)
    expect(restartResult.ok).toBe(false)
    expect(restartResult.message).toContain('cancelled')
  })

  test('restartGroup on non-existent group returns ok:false', async () => {
    const restartResult = await ctx.orchestrator.restartGroup('non-existent')
    expect(restartResult.ok).toBe(false)
    expect(restartResult.message).toContain('not found')
  })

  test('restartGroup on running group returns ok:false (only interrupted/errored)', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Running Group',
      features: makeFeatures(1),
    })

    // Group is in planning state right after startGroup
    const restartResult = await ctx.orchestrator.restartGroup(result.groupId)
    expect(restartResult.ok).toBe(false)
    expect(restartResult.message).toContain('cannot be restarted')
  })

  test('restartGroup on interrupted group resets stuck stages and resumes', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Interrupted Restart',
      features: makeFeatures(3),
    })

    const gid = result.groupId
    // Manually set group to interrupted with stuck feature stages
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'interrupted')
    ctx.repo.setFeatureError(PROJECT_ID, gid, 0, '', 'planning')
    ctx.repo.setFeatureError(PROJECT_ID, gid, 1, '', 'launching')
    ctx.repo.setFeatureError(PROJECT_ID, gid, 2, '', 'pending')

    const restartResult = await ctx.orchestrator.restartGroup(gid)
    expect(restartResult.ok).toBe(true)

    const features = ctx.repo.listFeatures(PROJECT_ID, gid)

    // Feature 0: planning→pending (reset) → planning (drive, cap has slot)
    expect(features[0].stage).toBe('planning')
    // Feature 1: launching→planned (reset) → running (drive launches it, cap=2)
    expect(features[1].stage).toBe('running')
    // Feature 2: pending (reset unchanged) → planning (drive, cap has slot)
    expect(features[2].stage).toBe('planning')

    // Group status should be running (features are planning/running)
    const group = ctx.repo.getGroup(PROJECT_ID, gid)
    expect(group!.status).toBe('running')
  })

  test('restartGroup on errored group with prdText and no features spawns new splitter', async () => {
    // Create a group via PRD path so it has prdText
    const result = await ctx.orchestrator.startGroup({
      title: 'Errored PRD',
      prd: 'Some PRD text for extraction',
    })

    const gid = result.groupId

    // Manually set to errored with no features
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'errored', { error: 'feature extraction failed: invalid_json' })

    const restartResult = await ctx.orchestrator.restartGroup(gid)
    expect(restartResult.ok).toBe(true)
    expect(restartResult.message).toContain('extracting')

    const group = ctx.repo.getGroup(PROJECT_ID, gid)
    expect(group!.status).toBe('extracting')
    expect(ctx.effects.spawnSplitterSession).toHaveBeenCalledTimes(2) // original + restart
    expect(ctx.effects.spawnSplitterSession).toHaveBeenLastCalledWith('Some PRD text for extraction')
  })

  test('restartGroup on interrupted PRD group with no features spawns new splitter', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Interrupted PRD',
      prd: 'Some PRD text for extraction',
    })

    const gid = result.groupId

    // Manually set to interrupted with no features (extraction was in progress)
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'interrupted')

    const restartResult = await ctx.orchestrator.restartGroup(gid)
    expect(restartResult.ok).toBe(true)
    expect(restartResult.message).toContain('extracting')

    const group = ctx.repo.getGroup(PROJECT_ID, gid)
    expect(group!.status).toBe('extracting')
    // Should have spawned a new splitter session
    expect(ctx.effects.spawnSplitterSession).toHaveBeenCalledTimes(2) // original + restart
    expect(ctx.effects.spawnSplitterSession).toHaveBeenLastCalledWith('Some PRD text for extraction')
  })

  test('restartGroup on errored group without prdText resets to planning', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Errored No PRD',
      features: makeFeatures(2),
    })

    const gid = result.groupId

    // Manually set to errored
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'errored', { error: 'some error' })
    // Set feature stages to stuck
    ctx.repo.setFeatureError(PROJECT_ID, gid, 0, '', 'planning')
    ctx.repo.setFeatureError(PROJECT_ID, gid, 1, '', 'launching')

    const restartResult = await ctx.orchestrator.restartGroup(gid)
    expect(restartResult.ok).toBe(true)

    // Feature 0: planning→pending (reset) → planning (drive, cap has slot)
    // Feature 1: launching→planned (reset) → running (drive launches it, cap=2)
    const features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].stage).toBe('planning')
    expect(features[1].stage).toBe('running')

    const group = ctx.repo.getGroup(PROJECT_ID, gid)
    expect(group!.status).toBe('running')
  })

  test('restartGroup clears stale architectSessionId preventing abandoned idle events from interfering', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Stale Arch Session',
      features: makeFeatures(1),
    })
    const gid = result.groupId

    // Feature 0 is planning with architectSessionId 'arch-session-0'
    let features = ctx.repo.listFeatures(PROJECT_ID, gid)
    const oldSessionId = features[0].architectSessionId!
    expect(oldSessionId).toBe('arch-session-0')
    expect(features[0].stage).toBe('planning')

    // Manually interrupt the group (simulating external interruption)
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'interrupted')

    // Restart the group — should reset planning→pending (atomically clearing
    // architect_session_id), then drive() claims pending→planning and spawns a
    // new architect session.
    const restartResult = await ctx.orchestrator.restartGroup(gid)
    expect(restartResult.ok).toBe(true)

    // Old session ID should no longer be associated with any feature
    const staleFeature = ctx.repo.getFeatureByArchitectSession(PROJECT_ID, oldSessionId)
    expect(staleFeature).toBeNull()

    // Calling onArchitectIdle with the old session should be silently ignored
    // (getFeatureByArchitectSession returns null → "unknown session" bail)
    await ctx.orchestrator.onArchitectIdle(oldSessionId)

    // The feature should be in planning stage with the NEW architect session
    features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].stage).toBe('planning')
    expect(features[0].architectSessionId).not.toBe(oldSessionId)
    expect(features[0].architectSessionId).toBeTruthy()

    // capturePlan should NOT have been called for the old session
    expect(ctx.effects.capturePlan).not.toHaveBeenCalledWith(oldSessionId)
  })

  test('stale onArchitectIdle after restartGroup does not interfere during spawnArchitectSession await', async () => {
    // Regression: restartGroup clears architect_session_id atomically, so even
    // if the abandoned architect session idles while the replacement spawn is
    // in flight, onArchitectIdle finds no feature and bails safely.
    const result = await ctx.orchestrator.startGroup({
      title: 'Stale Interleaved',
      features: makeFeatures(1),
    })
    const gid = result.groupId

    // Feature 0 is planning with architectSessionId 'arch-session-0'
    let features = ctx.repo.listFeatures(PROJECT_ID, gid)
    const oldSessionId = features[0].architectSessionId!
    expect(oldSessionId).toBe('arch-session-0')

    // Interrupt the group
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'interrupted')

    // Set up deferred spawn AFTER startGroup so startGroup resolves normally
    const archDeferred = deferred<{ sessionId: string }>()
    ctx.effects.spawnArchitectSession.mockReturnValue(archDeferred.promise)

    // Start restartGroup — it resets planning→pending, sets group to 'planning',
    // calls drive(), which claims pending→planning and awaits spawnArchitectSession.
    // The deferred mock means drive pauses at that await.
    const restartPromise = ctx.orchestrator.restartGroup(gid)

    // Wait for spawnArchitectSession to be called (drive is paused)
    await vi.waitFor(() => {
      expect(ctx.effects.spawnArchitectSession).toHaveBeenCalledTimes(2) // original + restart
    })

    // While drive is awaiting the new spawn, the OLD architect session idles.
    // getFeatureByArchitectSession(oldSessionId) should return null because
    // resetFeatureStage already cleared it atomically.
    const staleFeature = ctx.repo.getFeatureByArchitectSession(PROJECT_ID, oldSessionId)
    expect(staleFeature).toBeNull()

    // Fire the stale idle event — it should bail with no effect
    await ctx.orchestrator.onArchitectIdle(oldSessionId)

    // capturePlan should NOT have been called for the old session
    expect(ctx.effects.capturePlan).not.toHaveBeenCalledWith(oldSessionId)

    // Now resolve the deferred spawn — restartGroup completes
    archDeferred.resolve({ sessionId: 'new-arch-session' })
    await restartPromise

    // Feature should have the new session ID, not the old one
    features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].architectSessionId).toBe('new-arch-session')
    expect(features[0].stage).toBe('planning')
  })

  test('stale onArchitectIdle after restartGroup does not apply captured plan from old session', async () => {
    // Regression: onArchitectIdle for a stale architect session must not
    // transition the feature to 'planned' after restartGroup replaced the
    // session. The fix re-reads the feature by architectSessionId after the
    // capturePlan await and bails if the session was cleared (resetFeatureStage)
    // and replaced by restartGroup.
    const result = await ctx.orchestrator.startGroup({
      title: 'Stale Capture After Restart',
      features: makeFeatures(1),
    })
    const gid = result.groupId

    // Feature 0 is planning with arch-session-0
    let features = ctx.repo.listFeatures(PROJECT_ID, gid)
    const oldSessionId = features[0].architectSessionId!
    expect(oldSessionId).toBe('arch-session-0')
    expect(features[0].stage).toBe('planning')

    // Defer capturePlan so onArchitectIdle pauses inside the await.
    // The mock is set up before calling onArchitectIdle.
    const captureDeferred = deferred<{ captured: boolean }>()
    ctx.effects.capturePlan.mockReturnValue(captureDeferred.promise)

    // Start onArchitectIdle — pauses inside capturePlan await
    const idlePromise = ctx.orchestrator.onArchitectIdle(oldSessionId)

    // Ensure capturePlan was called for the old session before restart
    expect(ctx.effects.capturePlan).toHaveBeenCalledWith(oldSessionId)

    // While paused, interrupt the group and restart it.
    // restartGroup calls resetFeatureStage which atomically clears
    // architect_session_id, then drive claims the feature to planning
    // and spawns a new architect session.
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'interrupted')

    const restartResult = await ctx.orchestrator.restartGroup(gid)
    expect(restartResult.ok).toBe(true)

    // Feature should now have a new architect session
    features = ctx.repo.listFeatures(PROJECT_ID, gid)
    const newSessionId = features[0].architectSessionId!
    expect(newSessionId).not.toBe(oldSessionId)
    expect(newSessionId).toBeTruthy()
    expect(features[0].stage).toBe('planning')

    // Now resolve the deferred capturePlan for the old session.
    // onArchitectIdle resumes, checks getFeatureByArchitectSession(oldSessionId)
    // which returns null (session was cleared), and bails.
    captureDeferred.resolve({ captured: true })
    await idlePromise

    // Feature should still be planning with the NEW session
    features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].stage).toBe('planning')
    expect(features[0].architectSessionId).toBe(newSessionId)

    // No loop should have been launched (plan was never applied)
    expect(ctx.effects.launchLoop).toHaveBeenCalledTimes(0)

    // The new session should still be able to proceed normally
    await ctx.orchestrator.onArchitectIdle(newSessionId)
    features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].stage).toBe('running')
    expect(features[0].loopName).toBeTruthy()
  })

  // ── Stale generation guard (restart + reclaim during async effect) ────────

  test('old spawnArchitectSession after restart does not overwrite replacement session (generation guard)', async () => {
    const archDeferred = deferred<{ sessionId: string }>()
    ctx.effects.spawnArchitectSession.mockReturnValue(archDeferred.promise)

    // startGroup calls drive which pauses at the first await spawnArchitectSession
    const startPromise = ctx.orchestrator.startGroup({
      title: 'Stale Spawn Gen Guard',
      features: makeFeatures(1),
    })

    // Wait for spawnArchitectSession to be called (drive is paused)
    await vi.waitFor(() => {
      expect(ctx.effects.spawnArchitectSession).toHaveBeenCalledTimes(1)
    })

    const groups = ctx.repo.listGroups(PROJECT_ID)
    const gid = groups[0].groupId

    // Feature 0 should be in planning stage with attempts=1 (incremented by drive)
    let features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].stage).toBe('planning')
    expect(features[0].attempts).toBe(1)

    // Interrupt the group while drive is awaiting spawnArchitectSession
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'interrupted')

    // Make spawnArchitectSession resolve immediately for the restart
    ctx.effects.spawnArchitectSession.mockResolvedValue({ sessionId: 'new-arch-session' })

    // Restart the group — resets feature, claims it, spawns (immediate), sets session
    const restartResult = await ctx.orchestrator.restartGroup(gid)
    expect(restartResult.ok).toBe(true)

    // Feature should now have the NEW session
    features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].architectSessionId).toBe('new-arch-session')
    expect(features[0].attempts).toBe(2) // incremented again by restart's drive

    // Now resolve the ORIGINAL deferred spawn (stale effect)
    archDeferred.resolve({ sessionId: 'stale-arch-session' })

    // Wait for the original drive to finish
    await startPromise

    // Feature should still have the NEW session, not the stale one
    features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].architectSessionId).toBe('new-arch-session')
    expect(features[0].attempts).toBe(2) // unchanged after stale resolution

    // No more spawnArchitectSession calls beyond original + restart
    expect(ctx.effects.spawnArchitectSession).toHaveBeenCalledTimes(2)
  })

  test('old launchLoop after restart does not overwrite replacement loop and cancels stale loop (generation guard)', async () => {
    // Phase 1: create group with 1 feature, complete architect, get to planned stage.
    const result = await ctx.orchestrator.startGroup({
      title: 'Stale Launch Gen Guard',
      features: makeFeatures(1),
    })
    const gid = result.groupId

    // Feature 0 has arch-session-0 and is in planning stage.
    let features = ctx.repo.listFeatures(PROJECT_ID, gid)
    const archSessionId0 = features[0].architectSessionId!

    // Set up deferred for capturePlan so we can control when onArchitectIdle
    // enters the drive() → toLaunch loop.
    const captureDef = deferred<{ captured: boolean }>()
    ctx.effects.capturePlan.mockReturnValue(captureDef.promise)

    // Set up deferred for launchLoop so we can pause drive inside the await.
    const launchDef = deferred<{ ok: true; loopName: string } | { ok: false; error: string }>()
    ctx.effects.launchLoop.mockReturnValue(launchDef.promise)

    // Start onArchitectIdle — pauses inside capturePlan await
    const idlePromise = ctx.orchestrator.onArchitectIdle(archSessionId0)

    // Resolve capturePlan — onArchitectIdle continues, calls drive, which enters
    // the toLaunch loop and awaits launchLoop
    captureDef.resolve({ captured: true })

    // Wait for launchLoop to be called (drive is paused inside the await)
    await vi.waitFor(() => {
      expect(ctx.effects.launchLoop).toHaveBeenCalledTimes(1)
    })

    // Feature should be in launching stage with attempts=1 (from startGroup's
    // toPlan claim) + 1 (from the toLaunch claim) = 2
    features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].stage).toBe('launching')
    expect(features[0].attempts).toBe(2)

    // Interrupt the group while drive is awaiting launchLoop
    ctx.repo.setGroupStatus(PROJECT_ID, gid, 'interrupted')

    // Make launchLoop resolve immediately for the restart
    ctx.effects.launchLoop.mockResolvedValue({ ok: true, loopName: 'restart-loop-name' })

    // Restart the group — resets launching→planned, claims planned→launching,
    // calls launchLoop (immediate), sets loop name, claims launching→running
    const restartResult = await ctx.orchestrator.restartGroup(gid)
    expect(restartResult.ok).toBe(true)

    // Feature should now have the RESTART's loop name and be running
    features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].loopName).toBe('restart-loop-name')
    expect(features[0].stage).toBe('running')
    expect(features[0].attempts).toBe(3) // incremented again by restart's drive

    // Now resolve the ORIGINAL deferred launchLoop (stale effect).
    // The generation check should detect the mismatch and cancel the stale loop.
    launchDef.resolve({ ok: true, loopName: 'stale-loop-name' })
    await idlePromise

    // Feature should still have the RESTART's loop name, not the stale one
    features = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].loopName).toBe('restart-loop-name')
    expect(features[0].stage).toBe('running')
    expect(features[0].attempts).toBe(3)

    // cancelLoop should have been called with the stale loop name (from the
    // orphaned-loop cleanup in drive's generation guard)
    expect(ctx.effects.cancelLoop).toHaveBeenCalledWith('stale-loop-name')
  })

  // ── getStatus ───────────────────────────────────────────────────────────

  test('getStatus returns status view for a specific group', async () => {
    const result = await ctx.orchestrator.startGroup({
      title: 'Status Test',
      features: makeFeatures(2),
    })

    const views = ctx.orchestrator.getStatus({ groupId: result.groupId })
    expect(views).toHaveLength(1)
    expect(views[0].group.groupId).toBe(result.groupId)
    expect(views[0].features).toHaveLength(2)
  })

  test('getStatus with no selector returns all groups', async () => {
    await ctx.orchestrator.startGroup({ title: 'G1', features: makeFeatures(1) })
    await ctx.orchestrator.startGroup({ title: 'G2', features: makeFeatures(2) })

    const views = ctx.orchestrator.getStatus()
    expect(views).toHaveLength(2)
  })

  test('getStatus for non-existent group returns empty array', async () => {
    const views = ctx.orchestrator.getStatus({ groupId: 'non-existent' })
    expect(views).toHaveLength(0)
  })

  // ── Error handling ─────────────────────────────────────────────────────

  test('onArchitectIdle for unknown session is silently ignored', async () => {
    await expect(ctx.orchestrator.onArchitectIdle('unknown-session')).resolves.toBeUndefined()
  })

  test('onSplitterIdle for unknown session is silently ignored', async () => {
    await expect(ctx.orchestrator.onSplitterIdle('unknown-session')).resolves.toBeUndefined()
  })

  test('launchLoop failure sets feature to failed and group becomes completed', async () => {
    ctx.effects.launchLoop.mockResolvedValue({
      ok: false,
      error: 'Loop name already exists',
    })

    const result = await ctx.orchestrator.startGroup({
      title: 'Launch Fail',
      features: makeFeatures(1),
    })

    await ctx.orchestrator.onArchitectIdle('arch-session-0')

    const features = ctx.repo.listFeatures(PROJECT_ID, result.groupId)
    expect(features[0].stage).toBe('failed')
    expect(features[0].error).toBe('Loop name already exists')

    // All features are terminal → group should be completed, not running
    const group = ctx.repo.getGroup(PROJECT_ID, result.groupId)
    expect(group!.status).toBe('completed')
    expect(group!.completedAt).not.toBeNull()
  })

  test('startGroup respects maxConcurrent override', async () => {
    const repo = ctx.repo
    const effects = ctx.effects
    const orchestratorHighCap = createGroupOrchestrator({
      projectId: PROJECT_ID,
      repo,
      effects,
      cap: () => 5,
      logger: mockLogger,
    })

    const result = await orchestratorHighCap.startGroup({
      title: 'High Cap',
      features: makeFeatures(7),
    })

    // With cap=5, 5 features should be planned
    expect(effects.spawnArchitectSession).toHaveBeenCalledTimes(5)

    // All 5 should be planning
    const features = repo.listFeatures(PROJECT_ID, result.groupId)
    const planningCount = features.filter(f => f.stage === 'planning').length
    expect(planningCount).toBe(5)

    // 2 should remain pending
    const pendingCount = features.filter(f => f.stage === 'pending').length
    expect(pendingCount).toBe(2)
  })

  // ── Cancellation race regression tests ────────────────────────────────────

  test('cancelGroup state-first prevents onLoopTerminated from launching new work during cancelLoop await (bug 1)', async () => {
    // Regression: cancelGroup must mark state inactive before awaiting external
    // cancellation, so late onLoopTerminated cannot resurrect or launch new work.
    // Use cap=1: feature 0 runs, feature 1 queues as planned.
    const repo = ctx.repo
    const effects = ctx.effects
    const queueOrch = createGroupOrchestrator({
      projectId: PROJECT_ID,
      repo,
      effects,
      cap: () => 1,
      logger: mockLogger,
    })

    const result = await queueOrch.startGroup({
      title: 'Cancel Race Loop Term',
      features: makeFeatures(2),
    })
    const gid = result.groupId

    // Feature 0: planning→planned→launching→running
    await queueOrch.onArchitectIdle('arch-session-0')
    // Feature 1: pending→planning→planned (captured, stays planned because cap=1)
    await queueOrch.onArchitectIdle('arch-session-1')

    let features = repo.listFeatures(PROJECT_ID, gid)
    const loopName0 = features[0].loopName!
    expect(features[0].stage).toBe('running')
    expect(features[1].stage).toBe('planned')

    // Defer cancelLoop so we can interleave onLoopTerminated
    const cancelDeferred = deferred<void>()
    effects.cancelLoop.mockReturnValue(cancelDeferred.promise)

    // Start cancelGroup — pauses inside effects.cancelLoop(loopName0)
    const cancelPromise = queueOrch.cancelGroup(gid, { cancelRunningLoops: true })

    // cancelGroup should have marked group/features cancelled state-first,
    // before awaiting the external cancellation.
    features = repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].stage).toBe('cancelled')
    expect(features[1].stage).toBe('cancelled')

    // Fire onLoopTerminated while cancelLoop is still pending.
    // Because cancelGroup already marked features cancelled, the callback bails.
    await queueOrch.onLoopTerminated(loopName0)

    // Feature 0 should remain cancelled (not resurrected to completed)
    features = repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].stage).toBe('cancelled')

    // Feature 1 should remain cancelled, no new loops launched
    expect(effects.launchLoop).toHaveBeenCalledTimes(1) // only the initial launch for feature 0
    expect(features[1].stage).toBe('cancelled')
    expect(features[1].loopName).toBeNull()

    // Resolve cancelLoop — cancelGroup completes
    cancelDeferred.resolve()
    await cancelPromise

    // Final state: group cancelled, features cancelled
    const group = repo.getGroup(PROJECT_ID, gid)
    expect(group!.status).toBe('cancelled')
    features = repo.listFeatures(PROJECT_ID, gid)
    expect(features[0].stage).toBe('cancelled')
    expect(features[1].stage).toBe('cancelled')
  })

  test('cancelLoop failure does not prevent cancelGroup from marking state (bug 1)', async () => {
    // Regression: even if effects.cancelLoop rejects, the group/features must
    // remain cancelled.
    const result = await ctx.orchestrator.startGroup({
      title: 'Cancel Loop Reject',
      features: makeFeatures(1),
    })
    const gid = result.groupId

    await ctx.orchestrator.onArchitectIdle('arch-session-0')

    const features = ctx.repo.listFeatures(PROJECT_ID, gid)
    const loopName = features[0].loopName!

    // Make cancelLoop reject
    ctx.effects.cancelLoop.mockRejectedValue(new Error('network error'))

    // cancelGroup should still mark group/features cancelled despite the rejection
    await ctx.orchestrator.cancelGroup(gid, { cancelRunningLoops: true })

    const group = ctx.repo.getGroup(PROJECT_ID, gid)
    expect(group!.status).toBe('cancelled')

    const featuresAfter = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(featuresAfter[0].stage).toBe('cancelled')

    // cancelLoop should have been called
    expect(ctx.effects.cancelLoop).toHaveBeenCalledWith(loopName)
  })

  test('launchLoop resolves after cancellation — cancelLoop called for untracked loop (bug 2)', async () => {
    // Regression: when launchLoop succeeds but the group was cancelled during
    // the await, the launched loop must be best-effort cancelled so it is not
    // left untracked/running.
    const result = await ctx.orchestrator.startGroup({
      title: 'Launch After Cancel',
      features: makeFeatures(1),
    })
    const gid = result.groupId

    // Make capturePlan resolve synchronously, defer launchLoop
    const captureDef = deferred<{ captured: boolean }>()
    const launchDef = deferred<{ ok: true; loopName: string } | { ok: false; error: string }>()
    ctx.effects.capturePlan.mockReturnValue(captureDef.promise)
    ctx.effects.launchLoop.mockReturnValue(launchDef.promise)

    const features0 = ctx.repo.listFeatures(PROJECT_ID, gid)
    const archSessionId0 = features0[0].architectSessionId!

    // Start onArchitectIdle — pauses inside capturePlan
    const idlePromise = ctx.orchestrator.onArchitectIdle(archSessionId0)

    // Resolve capturePlan — onArchitectIdle continues, calls drive, hits launchLoop await
    captureDef.resolve({ captured: true })

    // Wait for launchLoop to be called
    await vi.waitFor(() => {
      expect(ctx.effects.launchLoop).toHaveBeenCalledTimes(1)
    })

    // Cancel the group while launchLoop is pending
    await ctx.orchestrator.cancelGroup(gid)

    // Resolve launchLoop — group is now inactive, drive should clean up.
    // Use a different returned loop name than the requested one to verify
    // the authoritative name is used for cancellation.
    launchDef.resolve({ ok: true, loopName: 'some-loop' })
    await idlePromise

    // Feature should remain cancelled, no loop name recorded
    const featuresAfter = ctx.repo.listFeatures(PROJECT_ID, gid)
    expect(featuresAfter[0].stage).toBe('cancelled')
    expect(featuresAfter[0].loopName).toBeNull()

    // Group should be cancelled
    const group = ctx.repo.getGroup(PROJECT_ID, gid)
    expect(group!.status).toBe('cancelled')

    // cancelLoop should have been called with the returned loop name (not the requested one)
    // Note: cancelGroup without cancelRunningLoops does not call cancelLoop,
    // so this call must come from the drive cleanup.
    expect(ctx.effects.cancelLoop).toHaveBeenCalledWith('some-loop')
  })

  // ── LaunchLoop authoritative loop name ──────────────────────────────────

  test('launchLoop returning different loopName records and cancels the returned name, not the requested one', async () => {
    // Acceptance criteria: if the loop start service auto-renames the loop
    // (e.g. on concurrent collision), the orchestrator must use the returned
    // loop name for storage and cancellation rather than the requested one.
    const result = await ctx.orchestrator.startGroup({
      title: 'Loop Name Mismatch',
      features: makeFeatures(1),
    })
    const gid = result.groupId

    // First complete the architect phase so drive enters the launch loop.
    await ctx.orchestrator.onArchitectIdle('arch-session-0')

    // Now drive will call launchLoop — make it return a deferred so we can
    // control the returned name.
    const launchDef = deferred<{ ok: true; loopName: string } | { ok: false; error: string }>()
    const captureDef = deferred<{ captured: boolean }>()
    ctx.effects.capturePlan.mockReturnValue(captureDef.promise)
    ctx.effects.launchLoop.mockReturnValue(launchDef.promise)

    // Need a fresh feature in pending state. Create a new group.
    const result2 = await ctx.orchestrator.startGroup({
      title: 'Loop Name Mismatch 2',
      features: makeFeatures(1),
    })
    const gid2 = result2.groupId

    const features0 = ctx.repo.listFeatures(PROJECT_ID, gid2)
    const archSessionId0 = features0[0].architectSessionId!

    // Start onArchitectIdle — pauses in capturePlan
    const idlePromise = ctx.orchestrator.onArchitectIdle(archSessionId0)

    // Resolve capture with a captured plan
    captureDef.resolve({ captured: true })

    // Wait for launchLoop to be called
    await vi.waitFor(() => {
      expect(ctx.effects.launchLoop).toHaveBeenCalledTimes(2) // one from earlier, one from this
    })

    // The requested loop name from the call args
    const requestedName = ctx.effects.launchLoop.mock.calls[1][0].loopName

    // Resolve launchLoop with a DIFFERENT returned name than requested
    launchDef.resolve({ ok: true, loopName: 'auto-renamed-loop-name' })
    await idlePromise

    const featuresAfter = ctx.repo.listFeatures(PROJECT_ID, gid2)

    // The stored loop name must be the returned name, not the requested one
    expect(featuresAfter[0].loopName).toBe('auto-renamed-loop-name')
    expect(featuresAfter[0].loopName).not.toBe(requestedName)

    // The feature should be running
    expect(featuresAfter[0].stage).toBe('running')

    // Cancel with cancelRunningLoops — should cancel using the returned name
    await ctx.orchestrator.cancelGroup(gid2, { cancelRunningLoops: true })

    expect(ctx.effects.cancelLoop).toHaveBeenCalledWith('auto-renamed-loop-name')

    // Also verify resolution: onLoopTerminated should find the feature by the returned name
    // Reset by creating another group
    const result3 = await ctx.orchestrator.startGroup({
      title: 'Loop Name Mismatch 3',
      features: makeFeatures(1),
    })
    const gid3 = result3.groupId

    // Complete architect for this new group
    const features3 = ctx.repo.listFeatures(PROJECT_ID, gid3)
    const archSessionId3 = features3[0].architectSessionId!

    const captureDef3 = deferred<{ captured: boolean }>()
    const launchDef3 = deferred<{ ok: true; loopName: string } | { ok: false; error: string }>()
    ctx.effects.capturePlan.mockReturnValue(captureDef3.promise)
    ctx.effects.launchLoop.mockReturnValue(launchDef3.promise)

    const idlePromise3 = ctx.orchestrator.onArchitectIdle(archSessionId3)
    captureDef3.resolve({ captured: true })

    await vi.waitFor(() => {
      expect(ctx.effects.launchLoop).toHaveBeenCalledTimes(3)
    })

    launchDef3.resolve({ ok: true, loopName: 'another-renamed-loop' })
    await idlePromise3

    const featuresAfter3 = ctx.repo.listFeatures(PROJECT_ID, gid3)
    expect(featuresAfter3[0].loopName).toBe('another-renamed-loop')
    expect(featuresAfter3[0].stage).toBe('running')

    // onLoopTerminated with the returned name should find and complete the feature
    await ctx.orchestrator.onLoopTerminated('another-renamed-loop')

    const featuresAfterTerm = ctx.repo.listFeatures(PROJECT_ID, gid3)
    expect(featuresAfterTerm[0].stage).toBe('completed')
  })
})

describe('mapLoopStateToOutcome', () => {
  test('completed status returns completed', () => {
    expect(mapLoopStateToOutcome({ active: false, status: 'completed' })).toBe('completed')
  })

  test('cancelled status returns failed', () => {
    expect(mapLoopStateToOutcome({ active: false, status: 'cancelled' })).toBe('failed')
  })

  test('errored status returns failed', () => {
    expect(mapLoopStateToOutcome({ active: false, status: 'errored' })).toBe('failed')
  })

  test('stalled status returns failed', () => {
    expect(mapLoopStateToOutcome({ active: false, status: 'stalled' })).toBe('failed')
  })

  test('running / active returns unknown', () => {
    expect(mapLoopStateToOutcome({ active: true, status: 'running' })).toBe('unknown')
  })

  test('null state returns unknown', () => {
    expect(mapLoopStateToOutcome(null)).toBe('unknown')
  })

  test('unknown status returns unknown', () => {
    expect(mapLoopStateToOutcome({ active: false, status: 'some_unknown_status' })).toBe('unknown')
  })
})
