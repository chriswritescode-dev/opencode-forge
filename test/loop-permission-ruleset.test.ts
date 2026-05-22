import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { buildLoopPermissionRuleset, buildAuditSessionPermissionRuleset } from '../src/constants/loop'
import { createLoopPermissionRejectHook, __resetLoopPermissionCache } from '../src/hooks/loop-permission'
import { createAuditSession } from '../src/utils/audit-session'
import { createLoopSessionWithWorkspace } from '../src/utils/loop-session'
import type { Logger } from '../src/types'

beforeEach(() => {
  __resetLoopPermissionCache()
})

describe('buildLoopPermissionRuleset', () => {
  test('worktree + sandbox ruleset: allow-all first, external_directory denied, code-agent denies, then operational denies last', () => {
    const rules = buildLoopPermissionRuleset()
    expect(rules).toEqual([
      { permission: '*',                  pattern: '*',          action: 'allow' },
      { permission: 'external_directory', pattern: '*',          action: 'deny' },
      { permission: 'review-write',       pattern: '*',          action: 'deny' },
      { permission: 'review-delete',      pattern: '*',          action: 'deny' },
      { permission: 'plan',               pattern: '*',          action: 'deny' },
      { permission: 'plan_enter',         pattern: '*',          action: 'deny' },
      { permission: 'plan_exit',          pattern: '*',          action: 'deny' },
      { permission: 'loop',               pattern: '*',          action: 'deny' },
      { permission: 'question',           pattern: '*',          action: 'deny' },
      { permission: 'bash',               pattern: '*',          action: 'deny' },
      { permission: 'forge-bash',         pattern: 'git push *', action: 'deny' },
      { permission: 'loop-cancel',        pattern: '*',          action: 'deny' },
      { permission: 'loop-status',        pattern: '*',          action: 'deny' },
    ])
  })

  test('EMITS session-level denies for code-agent tool exclusions (auditor now runs in separate session)', () => {
    const required = ['review-write', 'review-delete', 'plan', 'plan_enter', 'plan_exit', 'loop', 'question']
    const rules = buildLoopPermissionRuleset()
    for (const tool of required) {
      expect(rules.find((r) => r.permission === tool && r.action === 'deny')).toBeDefined()
    }
  })

  test('contains external_directory:*:deny rule', () => {
    const rules = buildLoopPermissionRuleset()
    expect(rules).toContainEqual({ permission: 'external_directory', pattern: '*', action: 'deny' })
  })

  test('does not contain any external_directory allow rule (host/sandbox path mismatch makes /tmp unsafe)', () => {
    const rules = buildLoopPermissionRuleset()
    const externalAllow = rules.find(
      (r) => r.permission === 'external_directory' && r.action === 'allow',
    )
    expect(externalAllow).toBeUndefined()
  })
})

describe('buildAuditSessionPermissionRuleset', () => {
  test('sandbox audit session ruleset: allow-all, external_directory denied, mutation denies', () => {
    const rules = buildAuditSessionPermissionRuleset()
    expect(rules[0]).toEqual({ permission: '*', pattern: '*', action: 'allow' })
    expect(rules[1]).toEqual({ permission: 'external_directory', pattern: '*', action: 'deny' })
    
    // Mutation denies
    expect(rules.some(r => r.permission === 'edit' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'write' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'multiedit' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'apply_patch' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    
    // Bash mutation denies
    expect(rules.some(r => r.permission === 'bash' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'forge-bash' && r.pattern === 'git commit *' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'forge-bash' && r.pattern === 'git push *' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'forge-bash' && r.pattern === 'git reset *' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'forge-bash' && r.pattern === 'git rm *' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'forge-bash' && r.pattern === 'git mv *' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'forge-bash' && r.pattern === 'rm *' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'forge-bash' && r.pattern === 'mv *' && r.action === 'deny')).toBe(true)
    
    // Loop/plan denies
    expect(rules.some(r => r.permission === 'plan' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'plan_enter' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'plan_exit' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'loop' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'question' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'loop-cancel' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'loop-status' && r.pattern === '*' && r.action === 'deny')).toBe(true)
  })

  test('non-sandbox audit session ruleset: allow-all, external_directory denied, mutation denies', () => {
    const rules = buildAuditSessionPermissionRuleset()
    expect(rules[0]).toEqual({ permission: '*', pattern: '*', action: 'allow' })
    expect(rules[1]).toEqual({ permission: 'external_directory', pattern: '*', action: 'deny' })
    
    // All the same mutation denies as sandbox mode
    expect(rules.some(r => r.permission === 'edit' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'write' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'multiedit' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'apply_patch' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'bash' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'forge-bash' && r.pattern === 'git commit *' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'forge-bash' && r.pattern === 'git push *' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'plan' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'plan_enter' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'plan_exit' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'loop' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'question' && r.pattern === '*' && r.action === 'deny')).toBe(true)
  })

  test('contains external_directory:*:deny rule', () => {
    const rules = buildAuditSessionPermissionRuleset()
    expect(rules).toContainEqual({ permission: 'external_directory', pattern: '*', action: 'deny' })
  })

  test('external_directory:*:deny appears before any /tmp allow rule if present', () => {
    const rules = buildAuditSessionPermissionRuleset()
    const denyIdx = rules.findIndex(
      (r) => r.permission === 'external_directory' && r.pattern === '*' && r.action === 'deny',
    )
    const allowIdx = rules.findIndex(
      (r) => r.permission === 'external_directory' && r.pattern === '/tmp' && r.action === 'allow',
    )
    expect(denyIdx).toBeGreaterThanOrEqual(0)
    // If a /tmp allow rule exists, deny must come first; otherwise deny is sufficient
    if (allowIdx >= 0) {
      expect(denyIdx).toBeLessThan(allowIdx)
    }
  })
})

describe('createAuditSession passes audit permission rules into session creation', () => {
  test('session.create receives permission equal to buildAuditSessionPermissionRuleset()', async () => {
    const expectedPermission = buildAuditSessionPermissionRuleset()
    const mockCreate = mock(async (params: any) => ({ data: { id: 'audit-session' }, error: null }))
    const mockGet = mock(async () => ({ data: { permission: expectedPermission }, error: null }))
    const mockV2 = {
      session: {
        create: mockCreate,
        get: mockGet,
      },
    } as any

    const logger = { log: mock(), error: mock() } as unknown as Logger

    await createAuditSession({
      v2: mockV2,
      loopName: 'permission-loop',
      iteration: 1,
      currentSectionIndex: 0,
      totalSections: 1,
      worktreeDir: '/tmp/permission-loop',
      isSandbox: false,
      prompt: 'audit',
      logger,
    })

    expect(mockCreate).toHaveBeenCalled()
    const callArgs = (mockCreate as any).mock.calls[0][0]
    expect(callArgs.directory).toBe('/tmp/permission-loop')
    expect(callArgs.permission).toEqual(expectedPermission)
    expect(callArgs.permission).toContainEqual({
      permission: 'external_directory',
      pattern: '*',
      action: 'deny',
    })
  })
})

describe('createLoopSessionWithWorkspace passes loop permission rules into session creation', () => {
  test('session.create receives permission exactly equal to buildLoopPermissionRuleset()', async () => {
    const expectedPermission = buildLoopPermissionRuleset()
    const mockCreate = mock(async (params: any) => ({ data: { id: 'loop-session' }, error: null }))
    const mockGet = mock(async () => ({ data: {} }))
    const mockV2 = {
      session: {
        create: mockCreate,
        get: mockGet,
      },
    } as any

    const logger = { log: mock(), error: mock() } as unknown as Logger

    await createLoopSessionWithWorkspace({
      v2: mockV2,
      title: 'test loop session',
      directory: '/tmp/permission-loop',
      permission: expectedPermission,
      logPrefix: 'test',
      logger,
    })

    expect(mockCreate).toHaveBeenCalled()
    const callArgs = (mockCreate as any).mock.calls[0][0]
    expect(callArgs.permission).toEqual(expectedPermission)
    expect(callArgs.directory).toBe('/tmp/permission-loop')
    expect(callArgs.permission).toContainEqual({
      permission: 'external_directory',
      pattern: '*',
      action: 'deny',
    })
  })
})

describe('createLoopPermissionRejectHook', () => {
  test('does not update subagent session permissions when the session is outside an active loop', async () => {
    const mockGet = mock(async () => ({ data: { permission: buildLoopPermissionRuleset() } }))
    const mockUpdate = mock(async () => ({ data: {}, error: null }))
    const mockResolve = mock(async () => null)
    const logger = { log: mock(), error: mock(), debug: mock() } as unknown as Logger

    const hook = createLoopPermissionRejectHook({
      v2: {
        session: {
          get: mockGet,
          update: mockUpdate,
        },
      } as any,
      sessionLoopResolver: {
        resolveActiveLoopForSession: mockResolve,
      } as any,
      directory: '/repo',
      logger,
    })

    await hook({
      event: {
        type: 'session.created',
        properties: {
          info: {
            id: 'child-session',
            parentID: 'parent-session',
            directory: '/repo',
          },
        },
      },
    })

    expect(mockResolve).toHaveBeenCalledWith('child-session')
    expect(mockGet).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  test('copies active loop parent permissions onto child subagent sessions', async () => {
    const parentPermission = buildLoopPermissionRuleset()
    const mockGet = mock(async () => ({ data: { permission: parentPermission } }))
    const mockUpdate = mock(async () => ({ data: {}, error: null }))
    const logger = { log: mock(), error: mock(), debug: mock() } as unknown as Logger

    const hook = createLoopPermissionRejectHook({
      v2: {
        session: {
          get: mockGet,
          update: mockUpdate,
        },
      } as any,
      sessionLoopResolver: {
        resolveActiveLoopForSession: mock(async () => ({
          loopName: 'active-loop',
          active: true,
          worktreeDir: '/repo/.worktrees/active-loop',
        })),
      } as any,
      directory: '/repo',
      logger,
    })

    await hook({
      event: {
        type: 'session.created',
        properties: {
          info: {
            id: 'child-session',
            parentID: 'parent-session',
          },
        },
      },
    })

    expect(mockGet).toHaveBeenCalledWith({
      sessionID: 'parent-session',
      directory: '/repo/.worktrees/active-loop',
    })
    expect(mockUpdate).toHaveBeenCalledWith({
      sessionID: 'child-session',
      directory: '/repo/.worktrees/active-loop',
      permission: parentPermission,
    })
  })

  test('is idempotent: firing twice for the same child session results in a single session.update call', async () => {
    const parentPermission = buildLoopPermissionRuleset()
    const mockGet = mock(async () => ({ data: { permission: parentPermission } }))
    const mockUpdate = mock(async () => ({ data: {}, error: null }))
    const logger = { log: mock(), error: mock(), debug: mock() } as unknown as Logger

    const hook = createLoopPermissionRejectHook({
      v2: { session: { get: mockGet, update: mockUpdate } } as any,
      sessionLoopResolver: {
        resolveActiveLoopForSession: mock(async () => ({
          loopName: 'active-loop',
          active: true,
          worktreeDir: '/repo/.worktrees/active-loop',
        })),
      } as any,
      directory: '/repo',
      logger,
    })

    const event = {
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-session', parentID: 'parent-session' } },
      },
    }
    await hook(event)
    await hook(event)

    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })
})
