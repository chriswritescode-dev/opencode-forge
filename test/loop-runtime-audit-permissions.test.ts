import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { Database } from 'bun:sqlite'
type DB = InstanceType<typeof Database>
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { LoopState } from '../src/loop/state'
import { buildAuditSessionPermissionRuleset, buildLoopPermissionRuleset, resolveLoopPermissionOptions } from '../src/constants/loop'
import type { PluginConfig } from '../src/types'
import { createTestDb } from './helpers/test-db'
import { createFakeForgeClient } from './helpers/fake-client'
import { buildLoopRuntime, makeLoopState } from './helpers/loop-fixtures'
import { recordCoderHandoff } from './helpers/loop-handoff'

const PROJECT_ID = 'test-project'
const AUDIT_PERMISSION_STATE_DEFAULTS = {
  sessionId: 'code-session-id',
  worktreeDir: '/tmp/test-worktree',
  projectDir: '/tmp/host-project',
  totalSections: 1,
} satisfies Partial<LoopState>

describe('Audit session permissions', () => {
  let db: DB
  let tempDir: string
  let testDb: ReturnType<typeof createTestDb>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-audit-perm-test-'))
    testDb = createTestDb()
    db = testDb.db
  })

  afterEach(() => {
    testDb.cleanup()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  test('audit session includes buildAuditSessionPermissionRuleset()', async () => {
    const createCalls: Array<Record<string, unknown>> = []

    const { client } = createFakeForgeClient({
      session: {
        create: async (input: any) => {
          createCalls.push(input)
          return { id: 'audit-session' }
        },
        get: async () => ({ id: 'ses_fake_1', permission: null }),
        status: async () => ({}),
        promptAsync: async () => {},
        messages: async () => [
          {
            info: { role: 'assistant', finish: 'stop' },
            parts: [{ type: 'text', text: 'All clear.' }],
          },
        ],
        abort: async () => {},
        delete: async () => {},
        update: async () => {},
      },
      workspace: {
        warp: async () => {},
        list: async () => [],
        remove: async () => {},
      },
      toast: async () => {},
    })

    const config: PluginConfig = {
      executionModel: 'test/model',
      auditorModel: 'test/auditor',
      loop: { enabled: true, defaultMaxIterations: 5 },
    }

    const { loop, loopService } = buildLoopRuntime(db, {
      projectId: PROJECT_ID,
      client,
      config,
      dataDir: tempDir,
    })

    const state = makeLoopState({
      ...AUDIT_PERMISSION_STATE_DEFAULTS,
      phase: 'coding',
      sessionId: 'code-session-id',
      totalSections: 1,
      auditCount: 0,
      iteration: 1,
      maxIterations: 3,
      workspaceId: 'ws-test',
      worktree: true,
    })
    loopService.setState(state.loopName, state)

    await recordCoderHandoff(loop, state.sessionId)

    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: state.sessionId,
      },
    })

    expect(createCalls.length).toBeGreaterThan(0)

    // With the ForgeClient port, create params are passed directly (not wrapped in { body })
    const callParams = createCalls[0] as any
    expect(callParams.permission).toEqual(buildAuditSessionPermissionRuleset(resolveLoopPermissionOptions(config)))
    expect(callParams.permission.some((r: { permission: string }) => r.permission === 'external_directory')).toBe(false)
  })

  test('audit session includes configured loop.permissions deny rules', async () => {
    const createCalls: Array<Record<string, unknown>> = []

    const { client } = createFakeForgeClient({
      session: {
        create: async (input: any) => {
          createCalls.push(input)
          return { id: 'audit-session' }
        },
        get: async () => ({ id: 'ses_fake_1', permission: null }),
        status: async () => ({}),
        promptAsync: async () => {},
        messages: async () => [
          {
            info: { role: 'assistant', finish: 'stop' },
            parts: [{ type: 'text', text: 'All clear.' }],
          },
        ],
        abort: async () => {},
        delete: async () => {},
        update: async () => {},
      },
      workspace: {
        warp: async () => {},
        list: async () => [],
        remove: async () => {},
      },
      toast: async () => {},
    })

    const config: PluginConfig = {
      executionModel: 'test/model',
      auditorModel: 'test/auditor',
      loop: { enabled: true, defaultMaxIterations: 5, permissions: { deny: ['webfetch'] } },
    }

    const { loop, loopService } = buildLoopRuntime(db, {
      projectId: PROJECT_ID,
      client,
      config,
      dataDir: tempDir,
    })

    const state = makeLoopState({
      ...AUDIT_PERMISSION_STATE_DEFAULTS,
      phase: 'coding',
      sessionId: 'code-session-id',
      totalSections: 1,
      auditCount: 0,
      iteration: 1,
      maxIterations: 3,
      workspaceId: 'ws-test',
      worktree: true,
    })
    loopService.setState(state.loopName, state)

    await recordCoderHandoff(loop, state.sessionId)

    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: state.sessionId,
      },
    })

    expect(createCalls.length).toBeGreaterThan(0)

    const callParams = createCalls[0] as any
    expect(callParams.permission).toEqual(buildAuditSessionPermissionRuleset(resolveLoopPermissionOptions(config)))
    expect(callParams.permission).toContainEqual({ permission: 'webfetch', pattern: '*', action: 'deny' })
  })

  test('audit session keeps portable rules persisted in remote workspace metadata', async () => {
    const createCalls: Array<Record<string, unknown>> = []

    // Simulates a remote loop: the server's own config carries no loop.permissions,
    // but the workspace metadata holds the launching machine's portable deny rule.
    const { client } = createFakeForgeClient({
      session: {
        create: async (input: any) => {
          createCalls.push(input)
          return { id: 'audit-session' }
        },
        get: async () => ({ id: 'ses_fake_1', permission: null }),
        status: async () => ({}),
        promptAsync: async () => {},
        messages: async () => [
          {
            info: { role: 'assistant', finish: 'stop' },
            parts: [{ type: 'text', text: 'All clear.' }],
          },
        ],
        abort: async () => {},
        delete: async () => {},
        update: async () => {},
      },
      workspace: {
        warp: async () => {},
        list: async () => [
          {
            id: 'ws-test',
            type: 'forge',
            name: 'test-loop',
            branch: null,
            directory: '/tmp/test-worktree',
            projectID: PROJECT_ID,
            extra: {
              permissionRules: [{ permission: 'webfetch', pattern: '*', action: 'deny' }],
            },
          },
        ],
        remove: async () => {},
      },
      toast: async () => {},
    })

    const config: PluginConfig = {
      executionModel: 'test/model',
      auditorModel: 'test/auditor',
      loop: { enabled: true, defaultMaxIterations: 5 },
    }

    const { loop, loopService } = buildLoopRuntime(db, {
      projectId: PROJECT_ID,
      client,
      config,
      dataDir: tempDir,
    })

    const state = makeLoopState({
      ...AUDIT_PERMISSION_STATE_DEFAULTS,
      phase: 'coding',
      sessionId: 'code-session-id',
      totalSections: 1,
      auditCount: 0,
      iteration: 1,
      maxIterations: 3,
      workspaceId: 'ws-test',
      worktree: true,
    })
    loopService.setState(state.loopName, state)

    await recordCoderHandoff(loop, state.sessionId)

    await loop.tick({
      type: 'session.status',
      properties: {
        status: { type: 'idle' },
        sessionID: state.sessionId,
      },
    })

    expect(createCalls.length).toBeGreaterThan(0)

    const callParams = createCalls[0] as any
    // Config alone yields no deny; the persisted workspace rule is merged in.
    expect(resolveLoopPermissionOptions(config).extraRules).toEqual([])
    expect(callParams.permission).toEqual(
      buildAuditSessionPermissionRuleset({
        ...resolveLoopPermissionOptions(config),
        extraRules: [{ permission: 'webfetch', pattern: '*', action: 'deny' }],
      }),
    )
    expect(callParams.permission).toContainEqual({ permission: 'webfetch', pattern: '*', action: 'deny' })
  })

  test('audit ruleset denies question tool (autonomy preservation)', () => {
    const ruleset = buildAuditSessionPermissionRuleset()
    expect(ruleset).toContainEqual({ permission: 'question', pattern: '*', action: 'deny' })
  })

  test('loop ruleset (used by post-action sessions) does not deny skill or task', () => {
    const ruleset = buildLoopPermissionRuleset()
    const denyRules = ruleset.filter((r: { permission: string; action: string }) => r.action === 'deny')
    const deniedPermissions = denyRules.map((r: { permission: string }) => r.permission)
    expect(deniedPermissions).not.toContain('skill')
    expect(deniedPermissions).not.toContain('task')
  })
})
