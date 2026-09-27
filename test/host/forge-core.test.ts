import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { createForgeCore, type ForgeCore } from '../../src/host/forge-core'
import type { ForgeTuiEvent } from '../../src/host/forge-rpc'
import {
  closeDatabase,
  createLoopsRepo,
  createSessionAutoApproveRepo,
  initializeDatabase,
  SESSION_AUTO_APPROVE_KEY_PREFIX,
  SESSION_AUTO_APPROVE_TTL_MS,
} from '../../src/storage'
import type { LoopRow } from '../../src/storage/repos/loops-repo'
import type { AutoApproveDenyRule, PluginConfig } from '../../src/types'
import { resolveSessionAutoApproveFlag } from '../../src/utils/session-auto-approve-flag'
import { createFakeForgeClient, type RecordedCall } from '../helpers/fake-client'

const TEST_ROOT = join('/tmp', `forge-core-test-${Date.now()}`)

describe('createForgeCore', () => {
  let testDir: string
  let core: ForgeCore | null

  beforeEach(() => {
    testDir = join(TEST_ROOT, Math.random().toString(36).slice(2))
    mkdirSync(testDir, { recursive: true })
    core = null
  })

  afterEach(async () => {
    await core?.cleanup()
    core = null
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  async function buildCore(
    config: PluginConfig = {},
    clientOverrides?: Parameters<typeof createFakeForgeClient>[0],
    hostOverrides?: { publishTuiEvent?: (event: ForgeTuiEvent) => void },
  ): Promise<{ core: ForgeCore; calls: RecordedCall[]; adapters: unknown[]; projectId: string }> {
    const projectId = `proj-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const { client, calls } = createFakeForgeClient({
      session: {
        get: async () => ({ id: 'ses_host_1', projectID: projectId, directory: testDir, parentID: null }),
      },
      ...clientOverrides,
    })
    const adapters: unknown[] = []
    core = await createForgeCore(
      { dataDir: join(testDir, 'memory'), ...config },
      {
        directory: testDir,
        projectId,
        projectRoot: testDir,
        client,
        registerWorkspaceAdapter: (adapter) => adapters.push(adapter),
        ...(hostOverrides?.publishTuiEvent ? { publishTuiEvent: hostOverrides.publishTuiEvent } : {}),
      },
    )
    return { core, calls, adapters, projectId }
  }

  function autoApproveExpiresAt(db: ReturnType<typeof initializeDatabase>, projectId: string, sessionId: string): number | null {
    const row = db
      .prepare('SELECT expires_at FROM tui_preferences WHERE project_id = ? AND key = ?')
      .get(projectId, `${SESSION_AUTO_APPROVE_KEY_PREFIX}${sessionId}`) as { expires_at: number } | null
    return row?.expires_at ?? null
  }

  function runningLoopRow(projectId: string, sessionId: string): LoopRow {
    return {
      projectId,
      loopName: 'core-loop',
      status: 'running',
      currentSessionId: sessionId,
      worktree: false,
      worktreeDir: testDir,
      worktreeBranch: null,
      projectDir: testDir,
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
      currentSectionIndex: 0,
      totalSections: 0,
      finalAuditDone: 0,
      executionVariant: null,
      auditorVariant: null,
      kind: 'plan',
    }
  }

  test('registers the forge workspace adapter and writes the sandbox shim', async () => {
    const built = await buildCore()

    expect(built.adapters).toHaveLength(1)
    const shimPath = built.core.shellShimPath
    expect(shimPath).not.toBeNull()
    expect(shimPath !== null && existsSync(shimPath)).toBe(true)
  })

  test('resolveShellSandbox skips session lookups while no loop or host sandbox is active', async () => {
    const built = await buildCore()

    await expect(built.core.resolveShellSandbox('ses_host_1')).resolves.toBeNull()
    expect(built.calls.some((call) => call.method === 'session.get')).toBe(false)
  })

  test('autoApprovesPermissions honors the per-session auto-approve flag', async () => {
    const built = await buildCore()

    const db = initializeDatabase(join(testDir, 'memory'))
    try {
      createSessionAutoApproveRepo(db).enable(built.projectId, 'ses_host_1', Date.now())
    } finally {
      closeDatabase(db)
    }

    await expect(built.core.autoApprovesPermissions('ses_host_1')).resolves.toBe(true)
    await expect(built.core.autoApprovesPermissions('ses_other')).resolves.toBe(false)
  })

  test('getSessionAutoApproveState reports own, inherited, and disabled states', async () => {
    const built = await buildCore({}, {
      session: {
        get: async (input: { sessionID: string }) => ({
          id: input.sessionID,
          projectID: 'proj-parented',
          directory: testDir,
          parentID: input.sessionID === 'ses_child' ? 'ses_parent' : null,
        }),
      },
    })

    await expect(built.core.getSessionAutoApproveState('ses_host_1')).resolves.toEqual({ enabled: false, inherited: false })

    const db = initializeDatabase(join(testDir, 'memory'))
    try {
      createSessionAutoApproveRepo(db).enable(built.projectId, 'ses_parent', Date.now())
    } finally {
      closeDatabase(db)
    }

    await expect(built.core.getSessionAutoApproveState('ses_parent')).resolves.toEqual({
      enabled: true,
      ownerSessionId: 'ses_parent',
      inherited: false,
    })
    await expect(built.core.getSessionAutoApproveState('ses_child')).resolves.toEqual({
      enabled: true,
      ownerSessionId: 'ses_parent',
      inherited: true,
    })
  })

  test('setSessionAutoApprove enables and disables a session flag', async () => {
    const built = await buildCore()

    await expect(built.core.setSessionAutoApprove('ses_host_1', true)).resolves.toEqual({
      enabled: true,
      ownerSessionId: 'ses_host_1',
      inherited: false,
    })
    await expect(built.core.autoApprovesPermissions('ses_host_1')).resolves.toBe(true)

    await expect(built.core.setSessionAutoApprove('ses_host_1', false)).resolves.toEqual({ enabled: false, inherited: false })
    await expect(built.core.autoApprovesPermissions('ses_host_1')).resolves.toBe(false)
  })

  test('setSessionAutoApprove refuses to toggle an inherited flag', async () => {
    const built = await buildCore({}, {
      session: {
        get: async (input: { sessionID: string }) => ({
          id: input.sessionID,
          projectID: 'proj-parented',
          directory: testDir,
          parentID: input.sessionID === 'ses_child' ? 'ses_parent' : null,
        }),
      },
    })

    const db = initializeDatabase(join(testDir, 'memory'))
    try {
      createSessionAutoApproveRepo(db).enable(built.projectId, 'ses_parent', Date.now())
    } finally {
      closeDatabase(db)
    }

    await expect(built.core.setSessionAutoApprove('ses_child', true)).resolves.toEqual({
      error: 'Auto-approve is inherited from parent session ses_parent; toggle it there',
    })
    await expect(built.core.setSessionAutoApprove('ses_child', false)).resolves.toEqual({
      error: 'Auto-approve is inherited from parent session ses_parent; toggle it there',
    })
  })

  test('setSessionAutoApprove refuses to enable inside an active loop', async () => {
    const built = await buildCore()

    const db = initializeDatabase(join(testDir, 'memory'))
    try {
      createLoopsRepo(db).insert(runningLoopRow(built.projectId, 'ses_host_1'), { lastAuditResult: null })
    } finally {
      closeDatabase(db)
    }

    await expect(built.core.setSessionAutoApprove('ses_host_1', true)).resolves.toEqual({
      error: 'Loop sessions already auto-approve everything not denied',
    })
  })

  test('emits autoApproveChanged when a session flag changes', async () => {
    const events: ForgeTuiEvent[] = []
    const built = await buildCore({}, undefined, { publishTuiEvent: (event) => events.push(event) })

    await expect(built.core.setSessionAutoApprove('ses_host_1', true)).resolves.toEqual({
      enabled: true,
      ownerSessionId: 'ses_host_1',
      inherited: false,
    })
    expect(events.filter((event) => event.type === 'autoApproveChanged'))
      .toEqual([{ type: 'autoApproveChanged', projectId: built.projectId, sessionId: 'ses_host_1' }])

    events.length = 0
    await expect(built.core.setSessionAutoApprove('ses_host_1', false)).resolves.toEqual({ enabled: false, inherited: false })
    expect(events.filter((event) => event.type === 'autoApproveChanged'))
      .toEqual([{ type: 'autoApproveChanged', projectId: built.projectId, sessionId: 'ses_host_1' }])
  })

  test('emits hostSandboxChanged when the desired host sandbox revision is written', async () => {
    const events: ForgeTuiEvent[] = []
    const built = await buildCore({}, undefined, { publishTuiEvent: (event) => events.push(event) })

    const result = built.core.tui.requestHostSandbox('ses_host_1', true)
    expect('revision' in result).toBe(true)
    expect(events.filter((event) => event.type === 'hostSandboxChanged').at(-1))
      .toEqual({ type: 'hostSandboxChanged', projectId: built.projectId })
  })

  test('emits one coalesced loopsChanged on a loop change', async () => {
    const events: ForgeTuiEvent[] = []
    const built = await buildCore({}, undefined, { publishTuiEvent: (event) => events.push(event) })

    const db = initializeDatabase(join(testDir, 'memory'))
    try {
      createLoopsRepo(db).insert({
        ...runningLoopRow(built.projectId, 'ses_loop_1'),
        status: 'stalled',
        terminationReason: 'stall_timeout',
      }, { lastAuditResult: null })
    } finally {
      closeDatabase(db)
    }

    const restarted = await built.core.tui.restartLoop({
      loopName: 'core-loop',
      auditorModel: 'prov/aud',
      auditorVariant: '',
    })
    expect('sessionId' in restarted).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events.filter((event) => event.type === 'loopsChanged')).toEqual([
      { type: 'loopsChanged', projectId: built.projectId },
    ])
  })

  test('throttles the flag TTL touch to once an hour per session', async () => {
    const built = await buildCore()
    const db = initializeDatabase(join(testDir, 'memory'))
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      const base = 1_000_000
      nowSpy.mockReturnValue(base)
      createSessionAutoApproveRepo(db).enable(built.projectId, 'ses_host_1', base)
      expect(autoApproveExpiresAt(db, built.projectId, 'ses_host_1')).toBe(base + SESSION_AUTO_APPROVE_TTL_MS)

      nowSpy.mockReturnValue(base + 1000)
      await built.core.chatMessage({ sessionID: 'ses_host_1' }, { message: {}, parts: [{ type: 'text', text: 'one' }] })
      const afterFirstTouch = autoApproveExpiresAt(db, built.projectId, 'ses_host_1')
      expect(afterFirstTouch).toBe(base + 1000 + SESSION_AUTO_APPROVE_TTL_MS)

      nowSpy.mockReturnValue(base + 2000)
      await built.core.chatMessage({ sessionID: 'ses_host_1' }, { message: {}, parts: [{ type: 'text', text: 'two' }] })
      expect(autoApproveExpiresAt(db, built.projectId, 'ses_host_1')).toBe(afterFirstTouch)
    } finally {
      nowSpy.mockRestore()
      closeDatabase(db)
    }
  })

  test('logs and toasts invalid autoApprove.deny entries without throwing', async () => {
    const logFile = join(testDir, 'forge.log')
    const built = await buildCore({
      logging: { enabled: true, file: logFile },
      autoApprove: { deny: [{ action: 'shell' }, 'nope'] as unknown as AutoApproveDenyRule[] },
    })

    expect(built.core.autoApproveDenyRules).toEqual([])
    const log = readFileSync(logFile, 'utf-8')
    expect(log).toContain('autoApprove.deny entry 0 is ignored')
    expect(log).toContain('autoApprove.deny entry 1 is ignored')
    expect(
      built.calls.some((call) => call.method === 'toast' && (call.params as { title?: string }).title === 'Forge auto-approve config'),
    ).toBe(true)
  })

  test('ignores a non-array autoApprove.deny without throwing', async () => {
    const built = await buildCore({ autoApprove: { deny: 'nope' as unknown as AutoApproveDenyRule[] } })

    expect(built.core.autoApproveDenyRules).toEqual([])
  })
})

describe('resolveSessionAutoApproveFlag', () => {
  const enabledSet = (ids: string[]) => (sessionID: string) => ids.includes(sessionID)
  const parents = (map: Record<string, string | null>) => async (sessionID: string) => map[sessionID] ?? null

  test('returns true when the flag is enabled for the session itself', async () => {
    const result = await resolveSessionAutoApproveFlag({
      sessionID: 'a',
      isEnabled: enabledSet(['a']),
      getParentId: parents({}),
      isInActiveLoop: async () => false,
    })

    expect(result).toEqual({ enabled: true, flagOwnerId: 'a' })
  })

  test('returns true when the flag is enabled for an ancestor', async () => {
    const result = await resolveSessionAutoApproveFlag({
      sessionID: 'c',
      isEnabled: enabledSet(['a']),
      getParentId: parents({ c: 'b', b: 'a' }),
      isInActiveLoop: async () => false,
    })

    expect(result).toEqual({ enabled: true, flagOwnerId: 'a' })
  })

  test('returns false inside an active loop even when the flag is enabled', async () => {
    const result = await resolveSessionAutoApproveFlag({
      sessionID: 'a',
      isEnabled: enabledSet(['a']),
      getParentId: parents({}),
      isInActiveLoop: async () => true,
    })

    expect(result).toEqual({ enabled: false })
  })

  test('fails closed when a parent lookup throws', async () => {
    const error = new Error('lookup failed')
    const result = await resolveSessionAutoApproveFlag({
      sessionID: 'a',
      isEnabled: enabledSet([]),
      getParentId: async () => {
        throw error
      },
      isInActiveLoop: async () => false,
    })

    expect(result).toEqual({ enabled: false, error })
  })

  test('stops on a cycle instead of looping forever', async () => {
    const result = await resolveSessionAutoApproveFlag({
      sessionID: 'a',
      isEnabled: enabledSet([]),
      getParentId: parents({ a: 'b', b: 'a' }),
      isInActiveLoop: async () => false,
    })

    expect(result).toEqual({ enabled: false })
  })

  test('returns false when nothing is enabled', async () => {
    const result = await resolveSessionAutoApproveFlag({
      sessionID: 'a',
      isEnabled: enabledSet([]),
      getParentId: parents({ a: 'b', b: null }),
      isInActiveLoop: async () => false,
    })

    expect(result).toEqual({ enabled: false })
  })

  test('checks the flag before the active-loop rule', async () => {
    let loopChecked = false
    const result = await resolveSessionAutoApproveFlag({
      sessionID: 'a',
      isEnabled: enabledSet([]),
      getParentId: parents({}),
      isInActiveLoop: async () => {
        loopChecked = true
        return true
      },
    })

    expect(result).toEqual({ enabled: false })
    expect(loopChecked).toBe(false)
  })

  test('walks up to the shared ancestor depth and stops beyond it', async () => {
    const chain: Record<string, string | null> = {}
    for (let i = 0; i < 12; i++) chain[`s${i}`] = `s${i + 1}`
    chain['s12'] = null

    const atDepth = await resolveSessionAutoApproveFlag({
      sessionID: 's0',
      isEnabled: enabledSet(['s10']),
      getParentId: parents(chain),
      isInActiveLoop: async () => false,
    })
    expect(atDepth).toEqual({ enabled: true, flagOwnerId: 's10' })

    const beyondDepth = await resolveSessionAutoApproveFlag({
      sessionID: 's0',
      isEnabled: enabledSet(['s11']),
      getParentId: parents(chain),
      isInActiveLoop: async () => false,
    })
    expect(beyondDepth).toEqual({ enabled: false })
  })
})
