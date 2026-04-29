import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createApiRegistryRepo, migrations } from '../../src/storage'

describe('ApiRegistryRepo', () => {
  let db: Database
  let repo: ReturnType<typeof createApiRegistryRepo>

  beforeEach(() => {
    db = new Database(':memory:')
    for (const migration of migrations) {
      migration.apply(db)
    }
    repo = createApiRegistryRepo(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('coordinator lease', () => {
    test('upserts and reads coordinator lease', () => {
      const now = 1000
      const ttlMs = 30000
      const input = {
        host: '127.0.0.1',
        port: 5552,
        url: 'http://127.0.0.1:5552',
        instanceId: 'a',
        pid: 1,
        now,
        ttlMs,
      }

      repo.upsertCoordinator(input)

      const coordinator = repo.getCoordinator('127.0.0.1', 5552)
      expect(coordinator).toBeTruthy()
      expect(coordinator!.host).toBe('127.0.0.1')
      expect(coordinator!.port).toBe(5552)
      expect(coordinator!.url).toBe('http://127.0.0.1:5552')
      expect(coordinator!.instanceId).toBe('a')
      expect(coordinator!.pid).toBe(1)
      expect(coordinator!.startedAt).toBe(1000)
      expect(coordinator!.heartbeatAt).toBe(1000)
      expect(coordinator!.expiresAt).toBe(31000)
    })

    test('touches coordinator lease', () => {
      const now = 1000
      const ttlMs = 30000
      repo.upsertCoordinator({
        host: '127.0.0.1',
        port: 5552,
        url: 'http://127.0.0.1:5552',
        instanceId: 'a',
        pid: 1,
        now,
        ttlMs,
      })

      repo.touchCoordinator('a', 5000, ttlMs)

      const coordinator = repo.getCoordinator('127.0.0.1', 5552)
      expect(coordinator).toBeTruthy()
      expect(coordinator!.heartbeatAt).toBe(5000)
      expect(coordinator!.expiresAt).toBe(35000)
    })

    test('deletes coordinator lease by instance id', () => {
      repo.upsertCoordinator({
        host: '127.0.0.1',
        port: 5552,
        url: 'http://127.0.0.1:5552',
        instanceId: 'a',
        pid: 1,
        now: 1000,
        ttlMs: 30000,
      })

      repo.deleteCoordinator('a')

      const coordinator = repo.getCoordinator('127.0.0.1', 5552)
      expect(coordinator).toBeNull()
    })
  })

  describe('project instance', () => {
    test('upserts and resolves project instance by project and directory', () => {
      const now = 1000
      const ttlMs = 30000
      const input = {
        instanceId: 'inst-a',
        projectId: 'project-a',
        directory: '/tmp/project-a',
        ownerUrl: 'http://127.0.0.1:60001',
        pid: 123,
        now,
        ttlMs,
      }

      repo.upsertProjectInstance(input)

      const byProject = repo.getProjectInstanceByProject('project-a')
      expect(byProject).toBeTruthy()
      expect(byProject!.instanceId).toBe('inst-a')
      expect(byProject!.projectId).toBe('project-a')
      expect(byProject!.directory).toBe('/tmp/project-a')
      expect(byProject!.ownerUrl).toBe('http://127.0.0.1:60001')
      expect(byProject!.pid).toBe(123)
      expect(byProject!.expiresAt).toBe(31000)

      const byDirectory = repo.getProjectInstanceByDirectory('/tmp/project-a')
      expect(byDirectory).toBeTruthy()
      expect(byDirectory!.instanceId).toBe('inst-a')
      expect(byDirectory!.directory).toBe('/tmp/project-a')
    })

    test('prefers latest heartbeat for duplicate project ownership', () => {
      const now = 1000
      const ttlMs = 30000

      repo.upsertProjectInstance({
        instanceId: 'inst-1',
        projectId: 'project-a',
        directory: '/tmp/project-a',
        ownerUrl: 'http://127.0.0.1:60001',
        pid: 123,
        now,
        ttlMs,
      })

      repo.upsertProjectInstance({
        instanceId: 'inst-2',
        projectId: 'project-a',
        directory: '/tmp/project-a',
        ownerUrl: 'http://127.0.0.1:60002',
        pid: 124,
        now: now + 1000,
        ttlMs,
      })

      const result = repo.getProjectInstanceByProject('project-a')
      expect(result).toBeTruthy()
      expect(result!.instanceId).toBe('inst-2')
      expect(result!.ownerUrl).toBe('http://127.0.0.1:60002')
    })

    test('deletes project instance by instance id', () => {
      repo.upsertProjectInstance({
        instanceId: 'inst-a',
        projectId: 'project-a',
        directory: '/tmp/project-a',
        ownerUrl: 'http://127.0.0.1:60001',
        pid: 123,
        now: 1000,
        ttlMs: 30000,
      })

      repo.deleteProjectInstance('inst-a')

      const result = repo.getProjectInstanceByProject('project-a')
      expect(result).toBeNull()
    })

    test('lists all project instances', () => {
      repo.upsertProjectInstance({
        instanceId: 'inst-a',
        projectId: 'project-a',
        directory: '/tmp/project-a',
        ownerUrl: 'http://127.0.0.1:60001',
        pid: 123,
        now: 1000,
        ttlMs: 30000,
      })
      repo.upsertProjectInstance({
        instanceId: 'inst-b',
        projectId: 'project-b',
        directory: '/tmp/project-b',
        ownerUrl: 'http://127.0.0.1:60002',
        pid: 124,
        now: 1000,
        ttlMs: 30000,
      })

      const all = repo.listProjectInstances()
      expect(all).toHaveLength(2)
    })
  })

  describe('prune expired', () => {
    test('prunes expired coordinator and project instances', () => {
      const now = 1000
      const ttlMs = 30000

      repo.upsertCoordinator({
        host: '127.0.0.1',
        port: 5552,
        url: 'http://127.0.0.1:5552',
        instanceId: 'coord-a',
        pid: 1,
        now,
        ttlMs,
      })

      repo.upsertProjectInstance({
        instanceId: 'inst-a',
        projectId: 'project-a',
        directory: '/tmp/project-a',
        ownerUrl: 'http://127.0.0.1:60001',
        pid: 123,
        now,
        ttlMs,
      })

      const pruned = repo.pruneExpired(31001)
      expect(pruned).toBe(2)

      const coordinator = repo.getCoordinator('127.0.0.1', 5552)
      expect(coordinator).toBeNull()

      const projectInstance = repo.getProjectInstanceByProject('project-a')
      expect(projectInstance).toBeNull()
    })

    test('does not prune non-expired instances', () => {
      const now = 1000
      const ttlMs = 30000

      repo.upsertCoordinator({
        host: '127.0.0.1',
        port: 5552,
        url: 'http://127.0.0.1:5552',
        instanceId: 'coord-a',
        pid: 1,
        now,
        ttlMs,
      })

      const pruned = repo.pruneExpired(31000)
      expect(pruned).toBe(0)

      const coordinator = repo.getCoordinator('127.0.0.1', 5552)
      expect(coordinator).toBeTruthy()
    })
  })
})
