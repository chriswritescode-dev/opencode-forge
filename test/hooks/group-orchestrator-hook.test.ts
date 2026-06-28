import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFeatureGroupsRepo } from '../../src/storage/repos/feature-groups-repo'
import { createGroupOrchestratorEventHook } from '../../src/hooks/group-orchestrator'
import type { GroupOrchestrator } from '../../src/services/group-orchestrator'
import type { Logger } from '../../src/types'

const PROJECT_ID = 'test-project'

const mockLogger: Logger = {
  log: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

function createDb() {
  const tempDir = mkdtempSync(join(tmpdir(), 'group-orch-hook-test-'))
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

  return { db, tempDir }
}

function createFakeOrchestrator() {
  return {
    startGroup: vi.fn(),
    onSplitterIdle: vi.fn().mockResolvedValue(undefined),
    onArchitectIdle: vi.fn().mockResolvedValue(undefined),
    onLoopTerminated: vi.fn().mockResolvedValue(undefined),
    restartGroup: vi.fn(),
    cancelGroup: vi.fn(),
    getStatus: vi.fn().mockReturnValue([]),
  } satisfies GroupOrchestrator
}

function makeStatusEvent(type: 'busy' | 'idle', sessionId: string) {
  return {
    event: {
      type: 'session.status',
      properties: {
        sessionID: sessionId,
        status: { type },
      },
    },
  }
}

function makeOtherEvent() {
  return {
    event: {
      type: 'session.created',
      properties: { sessionID: 's1' },
    },
  }
}

describe('group-orchestrator-hook', () => {
  let db: Database
  let tempDir: string
  let repo: ReturnType<typeof createFeatureGroupsRepo>
  let orchestrator: ReturnType<typeof createFakeOrchestrator>

  beforeEach(() => {
    const created = createDb()
    db = created.db
    tempDir = created.tempDir
    repo = createFeatureGroupsRepo(db)
    orchestrator = createFakeOrchestrator()
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('idle without preceding busy is ignored', async () => {
    const hook = createGroupOrchestratorEventHook({
      orchestrator,
      repo,
      projectId: PROJECT_ID,
      logger: mockLogger,
    })

    await hook(makeStatusEvent('idle', 'session-1'))

    expect(orchestrator.onSplitterIdle).not.toHaveBeenCalled()
    expect(orchestrator.onArchitectIdle).not.toHaveBeenCalled()
  })

  test('busy then idle routes to splitter idle when session is a splitter', async () => {
    const hook = createGroupOrchestratorEventHook({
      orchestrator,
      repo,
      projectId: PROJECT_ID,
      logger: mockLogger,
    })

    // Seed a group with splitter session.
    repo.createGroup({
      projectId: PROJECT_ID,
      groupId: 'g1',
      title: 'Test group',
      status: 'extracting',
      prdText: 'PRD text',
      splitterSessionId: 'splitter-s1',
    })

    await hook(makeStatusEvent('busy', 'splitter-s1'))
    await hook(makeStatusEvent('idle', 'splitter-s1'))

    expect(orchestrator.onSplitterIdle).toHaveBeenCalledWith('splitter-s1')
    expect(orchestrator.onArchitectIdle).not.toHaveBeenCalled()
  })

  test('busy then idle routes to architect idle when session is an architect', async () => {
    const hook = createGroupOrchestratorEventHook({
      orchestrator,
      repo,
      projectId: PROJECT_ID,
      logger: mockLogger,
    })

    // Seed a group + feature with architect session.
    repo.createGroup({
      projectId: PROJECT_ID,
      groupId: 'g2',
      title: 'Arch group',
      status: 'planning',
    })
    repo.insertFeatures(PROJECT_ID, 'g2', [{ title: 'Feature A', description: 'Desc A' }])
    repo.setFeatureArchitectSession(PROJECT_ID, 'g2', 0, 'arch-s1')

    await hook(makeStatusEvent('busy', 'arch-s1'))
    await hook(makeStatusEvent('idle', 'arch-s1'))

    expect(orchestrator.onArchitectIdle).toHaveBeenCalledWith('arch-s1')
    expect(orchestrator.onSplitterIdle).not.toHaveBeenCalled()
  })

  test('unknown session does not trigger any orchestrator call', async () => {
    const hook = createGroupOrchestratorEventHook({
      orchestrator,
      repo,
      projectId: PROJECT_ID,
      logger: mockLogger,
    })

    await hook(makeStatusEvent('busy', 'unknown-s1'))
    await hook(makeStatusEvent('idle', 'unknown-s1'))

    expect(orchestrator.onSplitterIdle).not.toHaveBeenCalled()
    expect(orchestrator.onArchitectIdle).not.toHaveBeenCalled()
  })

  test('non-status events are ignored', async () => {
    const hook = createGroupOrchestratorEventHook({
      orchestrator,
      repo,
      projectId: PROJECT_ID,
      logger: mockLogger,
    })

    await hook(makeOtherEvent())

    expect(orchestrator.onSplitterIdle).not.toHaveBeenCalled()
    expect(orchestrator.onArchitectIdle).not.toHaveBeenCalled()
  })

  test('splitter idle requires preceding busy - second idle without busy is ignored', async () => {
    const hook = createGroupOrchestratorEventHook({
      orchestrator,
      repo,
      projectId: PROJECT_ID,
      logger: mockLogger,
    })

    repo.createGroup({
      projectId: PROJECT_ID,
      groupId: 'g3',
      title: 'Test group',
      status: 'extracting',
      prdText: 'PRD text',
      splitterSessionId: 'splitter-s2',
    })

    // First idle (no busy seen) → ignored.
    await hook(makeStatusEvent('idle', 'splitter-s2'))
    expect(orchestrator.onSplitterIdle).not.toHaveBeenCalled()

    // Busy seen.
    await hook(makeStatusEvent('busy', 'splitter-s2'))

    // Second idle → now routed.
    await hook(makeStatusEvent('idle', 'splitter-s2'))
    expect(orchestrator.onSplitterIdle).toHaveBeenCalledWith('splitter-s2')
    expect(orchestrator.onArchitectIdle).not.toHaveBeenCalled()
  })

  test('busy is recorded but does not trigger orchestrator calls', async () => {
    const hook = createGroupOrchestratorEventHook({
      orchestrator,
      repo,
      projectId: PROJECT_ID,
      logger: mockLogger,
    })

    repo.createGroup({
      projectId: PROJECT_ID,
      groupId: 'g4',
      title: 'Test group',
      status: 'extracting',
      prdText: 'PRD text',
      splitterSessionId: 'splitter-s3',
    })

    await hook(makeStatusEvent('busy', 'splitter-s3'))

    expect(orchestrator.onSplitterIdle).not.toHaveBeenCalled()
    expect(orchestrator.onArchitectIdle).not.toHaveBeenCalled()
  })

  test('error during orchestrator call is caught and logged', async () => {
    const errorLogger = { ...mockLogger, error: vi.fn() }
    const failingOrchestrator = createFakeOrchestrator()
    failingOrchestrator.onSplitterIdle = vi.fn().mockRejectedValue(new Error('boom'))

    const hook = createGroupOrchestratorEventHook({
      orchestrator: failingOrchestrator,
      repo,
      projectId: PROJECT_ID,
      logger: errorLogger,
    })

    repo.createGroup({
      projectId: PROJECT_ID,
      groupId: 'g5',
      title: 'Test group',
      status: 'extracting',
      prdText: 'PRD text',
      splitterSessionId: 'splitter-err',
    })

    await hook(makeStatusEvent('busy', 'splitter-err'))
    await hook(makeStatusEvent('idle', 'splitter-err'))

    expect(failingOrchestrator.onSplitterIdle).toHaveBeenCalledWith('splitter-err')
    expect(errorLogger.error).toHaveBeenCalled()
  })
})
