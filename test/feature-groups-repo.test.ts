import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
import { createFeatureGroupsRepo, type FeatureGroupRow } from '../src/storage/repos/feature-groups-repo'
import type { ParsedFeature } from '../src/utils/feature-list-parser'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('FeatureGroupsRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createFeatureGroupsRepo>
  let dbPath: string
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'feature-groups-repo-test-'))
    dbPath = join(tempDir, 'feature-groups-repo-test.db')
    db = new Database(dbPath)

    // Create the tables from the migration SQL
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
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_feature_groups_status ON feature_groups(project_id, status)
    `)
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_feature_groups_splitter ON feature_groups(project_id, splitter_session_id)
    `)
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
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_group_features_arch ON group_features(project_id, architect_session_id)
    `)
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_group_features_loop ON group_features(project_id, loop_name)
    `)
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_group_features_stage ON group_features(project_id, group_id, stage)
    `)

    repo = createFeatureGroupsRepo(db)
  })

  afterEach(() => {
    db.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  const defaultGroup: Parameters<typeof repo.createGroup>[0] = {
    projectId: 'test-project',
    groupId: 'group-1',
    title: 'Test Group',
    status: 'extracting',
  }

  describe('createGroup + getGroup roundtrip', () => {
    test('should insert and retrieve a feature group', () => {
      repo.createGroup(defaultGroup)

      const retrieved = repo.getGroup(defaultGroup.projectId, defaultGroup.groupId)
      expect(retrieved).toBeTruthy()
      expect(retrieved!.groupId).toBe('group-1')
      expect(retrieved!.title).toBe('Test Group')
      expect(retrieved!.status).toBe('extracting')
      expect(retrieved!.maxConcurrent).toBe(3)
      expect(retrieved!.createdAt).toBeGreaterThan(0)
      expect(retrieved!.updatedAt).toBeGreaterThan(0)
    })

    test('should return null for non-existent group', () => {
      const retrieved = repo.getGroup('nonexistent', 'nope')
      expect(retrieved).toBeNull()
    })

    test('should insert with all optional fields', () => {
      repo.createGroup({
        ...defaultGroup,
        groupId: 'group-full',
        prdText: 'PRD content',
        maxConcurrent: 5,
        executionModel: 'gpt-4',
        auditorModel: 'claude-3',
        splitterSessionId: 'splitter-session',
        hostSessionId: 'host-session',
        error: 'initial error',
        completedAt: 999,
      })

      const retrieved = repo.getGroup(defaultGroup.projectId, 'group-full')
      expect(retrieved).toBeTruthy()
      expect(retrieved!.prdText).toBe('PRD content')
      expect(retrieved!.maxConcurrent).toBe(5)
      expect(retrieved!.executionModel).toBe('gpt-4')
      expect(retrieved!.auditorModel).toBe('claude-3')
      expect(retrieved!.splitterSessionId).toBe('splitter-session')
      expect(retrieved!.hostSessionId).toBe('host-session')
      expect(retrieved!.error).toBe('initial error')
      expect(retrieved!.completedAt).toBe(999)
    })

    test('should error on duplicate group (conflict)', () => {
      repo.createGroup(defaultGroup)
      expect(() => {
        repo.createGroup(defaultGroup)
      }).toThrow()
    })
  })

  describe('listGroups', () => {
    test('should list all groups', () => {
      repo.createGroup({ ...defaultGroup, groupId: 'g1', status: 'extracting' })
      repo.createGroup({ ...defaultGroup, groupId: 'g2', status: 'running' })
      repo.createGroup({ ...defaultGroup, groupId: 'g3', status: 'completed' })

      const all = repo.listGroups(defaultGroup.projectId)
      expect(all).toHaveLength(3)
    })

    test('should filter by status', () => {
      repo.createGroup({ ...defaultGroup, groupId: 'g1', status: 'extracting' })
      repo.createGroup({ ...defaultGroup, groupId: 'g2', status: 'running' })
      repo.createGroup({ ...defaultGroup, groupId: 'g3', status: 'completed' })

      const running = repo.listGroups(defaultGroup.projectId, { status: 'running' })
      expect(running).toHaveLength(1)
      expect(running[0].groupId).toBe('g2')

      const completed = repo.listGroups(defaultGroup.projectId, { status: 'completed' })
      expect(completed).toHaveLength(1)
      expect(completed[0].groupId).toBe('g3')
    })

    test('should return empty list for no matches', () => {
      const groups = repo.listGroups('other-project')
      expect(groups).toHaveLength(0)
    })
  })

  describe('setGroupStatus', () => {
    test('should update status', () => {
      repo.createGroup(defaultGroup)

      repo.setGroupStatus(defaultGroup.projectId, defaultGroup.groupId, 'running')
      const retrieved = repo.getGroup(defaultGroup.projectId, defaultGroup.groupId)
      expect(retrieved!.status).toBe('running')
    })

    test('should set error and completedAt when provided', () => {
      repo.createGroup(defaultGroup)

      const completedAt = Date.now()
      repo.setGroupStatus(defaultGroup.projectId, defaultGroup.groupId, 'completed', {
        error: null,
        completedAt,
      })
      const retrieved = repo.getGroup(defaultGroup.projectId, defaultGroup.groupId)
      expect(retrieved!.status).toBe('completed')
      expect(retrieved!.completedAt).toBe(completedAt)
    })
  })

  describe('setSplitterSession + getGroupBySplitterSession', () => {
    test('should set and retrieve by splitter session', () => {
      repo.createGroup(defaultGroup)

      repo.setSplitterSession(defaultGroup.projectId, defaultGroup.groupId, 'splitter-123')
      const retrieved = repo.getGroup(defaultGroup.projectId, defaultGroup.groupId)
      expect(retrieved!.splitterSessionId).toBe('splitter-123')

      const bySplitter = repo.getGroupBySplitterSession(defaultGroup.projectId, 'splitter-123')
      expect(bySplitter).toBeTruthy()
      expect(bySplitter!.groupId).toBe(defaultGroup.groupId)
    })

    test('should return null for unknown splitter session', () => {
      const retrieved = repo.getGroupBySplitterSession(defaultGroup.projectId, 'unknown')
      expect(retrieved).toBeNull()
    })
  })

  describe('insertFeatures + listFeatures', () => {
    const features: ParsedFeature[] = [
      { title: 'Feature A', description: 'Description A' },
      { title: 'Feature B', description: 'Description B' },
      { title: 'Feature C', description: 'Description C' },
    ]

    test('should bulk insert and list features', () => {
      repo.createGroup(defaultGroup)
      repo.insertFeatures(defaultGroup.projectId, defaultGroup.groupId, features)

      const list = repo.listFeatures(defaultGroup.projectId, defaultGroup.groupId)
      expect(list).toHaveLength(3)
      expect(list[0].title).toBe('Feature A')
      expect(list[0].featureIndex).toBe(0)
      expect(list[0].stage).toBe('pending')
      expect(list[0].attempts).toBe(0)
      expect(list[1].title).toBe('Feature B')
      expect(list[1].featureIndex).toBe(1)
      expect(list[2].title).toBe('Feature C')
      expect(list[2].featureIndex).toBe(2)
    })

    test('should insert empty features list', () => {
      repo.createGroup(defaultGroup)
      repo.insertFeatures(defaultGroup.projectId, defaultGroup.groupId, [])

      const list = repo.listFeatures(defaultGroup.projectId, defaultGroup.groupId)
      expect(list).toHaveLength(0)
    })

    test('should cascade delete features when group is deleted', () => {
      repo.createGroup(defaultGroup)
      repo.insertFeatures(defaultGroup.projectId, defaultGroup.groupId, features)

      // Delete the group directly
      db.run('DELETE FROM feature_groups WHERE project_id = ? AND group_id = ?', defaultGroup.projectId, defaultGroup.groupId)

      const list = repo.listFeatures(defaultGroup.projectId, defaultGroup.groupId)
      expect(list).toHaveLength(0)
    })
  })

  describe('claimFeatureStage', () => {
    test('should claim a feature stage atomically once', () => {
      repo.createGroup(defaultGroup)
      repo.insertFeatures(defaultGroup.projectId, defaultGroup.groupId, [
        { title: 'Feature A', description: 'Desc' },
      ])

      // First claim should succeed
      const claimed = repo.claimFeatureStage(defaultGroup.projectId, defaultGroup.groupId, 0, 'pending', 'planning')
      expect(claimed).toBe(true)

      // Verify stage changed
      const features = repo.listFeatures(defaultGroup.projectId, defaultGroup.groupId)
      expect(features[0].stage).toBe('planning')

      // Second claim with same from->to should fail (stage already changed)
      const claimedAgain = repo.claimFeatureStage(defaultGroup.projectId, defaultGroup.groupId, 0, 'pending', 'planning')
      expect(claimedAgain).toBe(false)
    })

    test('should allow valid transition through multiple stages', () => {
      repo.createGroup(defaultGroup)
      repo.insertFeatures(defaultGroup.projectId, defaultGroup.groupId, [
        { title: 'Feature A', description: 'Desc' },
      ])

      expect(repo.claimFeatureStage(defaultGroup.projectId, defaultGroup.groupId, 0, 'pending', 'planning')).toBe(true)
      expect(repo.claimFeatureStage(defaultGroup.projectId, defaultGroup.groupId, 0, 'planning', 'planned')).toBe(true)
      expect(repo.claimFeatureStage(defaultGroup.projectId, defaultGroup.groupId, 0, 'planned', 'launching')).toBe(true)
      expect(repo.claimFeatureStage(defaultGroup.projectId, defaultGroup.groupId, 0, 'launching', 'running')).toBe(true)
      expect(repo.claimFeatureStage(defaultGroup.projectId, defaultGroup.groupId, 0, 'running', 'completed')).toBe(true)

      // Verify final state
      const features = repo.listFeatures(defaultGroup.projectId, defaultGroup.groupId)
      expect(features[0].stage).toBe('completed')
    })

    test('should return false for non-existent feature', () => {
      repo.createGroup(defaultGroup)

      const claimed = repo.claimFeatureStage(defaultGroup.projectId, defaultGroup.groupId, 99, 'pending', 'planning')
      expect(claimed).toBe(false)
    })
  })

  describe('resolver lookups by session/loop', () => {
    test('getFeatureByArchitectSession', () => {
      repo.createGroup(defaultGroup)
      repo.insertFeatures(defaultGroup.projectId, defaultGroup.groupId, [
        { title: 'Feature A', description: 'Desc' },
      ])

      repo.setFeatureArchitectSession(defaultGroup.projectId, defaultGroup.groupId, 0, 'arch-session-1')
      const found = repo.getFeatureByArchitectSession(defaultGroup.projectId, 'arch-session-1')
      expect(found).toBeTruthy()
      expect(found!.featureIndex).toBe(0)
      expect(found!.architectSessionId).toBe('arch-session-1')

      const notFound = repo.getFeatureByArchitectSession(defaultGroup.projectId, 'unknown')
      expect(notFound).toBeNull()
    })

    test('getFeatureByLoopName', () => {
      repo.createGroup(defaultGroup)
      repo.insertFeatures(defaultGroup.projectId, defaultGroup.groupId, [
        { title: 'Feature A', description: 'Desc' },
      ])

      repo.setFeatureLoopName(defaultGroup.projectId, defaultGroup.groupId, 0, 'loop-name-1')
      const found = repo.getFeatureByLoopName(defaultGroup.projectId, 'loop-name-1')
      expect(found).toBeTruthy()
      expect(found!.featureIndex).toBe(0)
      expect(found!.loopName).toBe('loop-name-1')

      const notFound = repo.getFeatureByLoopName(defaultGroup.projectId, 'unknown')
      expect(notFound).toBeNull()
    })
  })

  describe('setFeatureError', () => {
    test('should set error and stage on feature', () => {
      repo.createGroup(defaultGroup)
      repo.insertFeatures(defaultGroup.projectId, defaultGroup.groupId, [
        { title: 'Feature A', description: 'Desc' },
      ])

      repo.setFeatureError(defaultGroup.projectId, defaultGroup.groupId, 0, 'Something went wrong', 'failed')
      const features = repo.listFeatures(defaultGroup.projectId, defaultGroup.groupId)
      expect(features[0].error).toBe('Something went wrong')
      expect(features[0].stage).toBe('failed')
    })
  })

  describe('markInterrupted', () => {
    test('should mark only non-terminal groups as interrupted', () => {
      repo.createGroup({ ...defaultGroup, groupId: 'g1', status: 'extracting' })
      repo.createGroup({ ...defaultGroup, groupId: 'g2', status: 'planning' })
      repo.createGroup({ ...defaultGroup, groupId: 'g3', status: 'running' })
      repo.createGroup({ ...defaultGroup, groupId: 'g4', status: 'completed' })
      repo.createGroup({ ...defaultGroup, groupId: 'g5', status: 'cancelled' })
      repo.createGroup({ ...defaultGroup, groupId: 'g6', status: 'errored' })
      repo.createGroup({ ...defaultGroup, groupId: 'g7', status: 'interrupted' })

      const count = repo.markInterrupted(defaultGroup.projectId)
      expect(count).toBe(3) // extracting, planning, running

      // Verify the three active groups are now interrupted
      const all = repo.listGroups(defaultGroup.projectId)
      const interrupted = all.filter(g => g.status === 'interrupted')
      expect(interrupted).toHaveLength(4) // 3 newly + 1 already
      expect(interrupted.map(g => g.groupId).sort()).toEqual(['g1', 'g2', 'g3', 'g7'].sort())

      // Terminal groups unchanged
      expect(all.find(g => g.groupId === 'g4')!.status).toBe('completed')
      expect(all.find(g => g.groupId === 'g5')!.status).toBe('cancelled')
      expect(all.find(g => g.groupId === 'g6')!.status).toBe('errored')
    })

    test('should return 0 when no active groups', () => {
      repo.createGroup({ ...defaultGroup, status: 'completed' })
      repo.createGroup({ ...defaultGroup, groupId: 'g2', status: 'cancelled' })

      const count = repo.markInterrupted(defaultGroup.projectId)
      expect(count).toBe(0)
    })

    test('should not modify group_features stages', () => {
      repo.createGroup({ ...defaultGroup, status: 'running' })
      repo.insertFeatures(defaultGroup.projectId, defaultGroup.groupId, [
        { title: 'Feature A', description: 'Desc A' },
        { title: 'Feature B', description: 'Desc B' },
      ])
      // Manually advance features to various stages
      repo.claimFeatureStage(defaultGroup.projectId, defaultGroup.groupId, 0, 'pending', 'running')
      repo.claimFeatureStage(defaultGroup.projectId, defaultGroup.groupId, 1, 'pending', 'planned')

      const before = repo.listFeatures(defaultGroup.projectId, defaultGroup.groupId)
      expect(before[0].stage).toBe('running')
      expect(before[1].stage).toBe('planned')

      const count = repo.markInterrupted(defaultGroup.projectId)
      expect(count).toBe(1)

      // Group status changed
      const group = repo.getGroup(defaultGroup.projectId, defaultGroup.groupId)
      expect(group!.status).toBe('interrupted')

      // Feature stages untouched
      const after = repo.listFeatures(defaultGroup.projectId, defaultGroup.groupId)
      expect(after[0].stage).toBe('running')
      expect(after[1].stage).toBe('planned')
    })
  })

  describe('incrementFeatureAttempts', () => {
    test('should atomically increment attempts', () => {
      repo.createGroup(defaultGroup)
      repo.insertFeatures(defaultGroup.projectId, defaultGroup.groupId, [
        { title: 'Feature A', description: 'Desc' },
      ])

      repo.incrementFeatureAttempts(defaultGroup.projectId, defaultGroup.groupId, 0)
      repo.incrementFeatureAttempts(defaultGroup.projectId, defaultGroup.groupId, 0)
      repo.incrementFeatureAttempts(defaultGroup.projectId, defaultGroup.groupId, 0)

      const features = repo.listFeatures(defaultGroup.projectId, defaultGroup.groupId)
      expect(features[0].attempts).toBe(3)
    })
  })

  describe('setFeatureArchitectSession + setFeatureLoopName', () => {
    test('should set architect session and loop name', () => {
      repo.createGroup(defaultGroup)
      repo.insertFeatures(defaultGroup.projectId, defaultGroup.groupId, [
        { title: 'Feature A', description: 'Desc' },
      ])

      repo.setFeatureArchitectSession(defaultGroup.projectId, defaultGroup.groupId, 0, 'arch-123')
      repo.setFeatureLoopName(defaultGroup.projectId, defaultGroup.groupId, 0, 'loop-123')

      const features = repo.listFeatures(defaultGroup.projectId, defaultGroup.groupId)
      expect(features[0].architectSessionId).toBe('arch-123')
      expect(features[0].loopName).toBe('loop-123')
    })
  })
})
