import { describe, test, expect, vi, beforeEach } from 'vitest'
import { buildLoopPermissionRuleset, buildAuditSessionPermissionRuleset } from '../src/constants/loop'
import { resolveOpencodeToolOutputDir } from '../src/utils/opencode-paths'
import { createLoopPermissionRejectHook, __resetLoopPermissionCache } from '../src/hooks/loop-permission'
import { createAuditSession } from '../src/utils/audit-session'
import { createLoopSessionWithWorkspace } from '../src/utils/loop-session'
import type { Logger } from '../src/types'

const TOOL_OUTPUT_DIR = resolveOpencodeToolOutputDir()
const TOOL_OUTPUT_ALLOW_RULES = [
  { permission: 'external_directory', pattern: TOOL_OUTPUT_DIR, action: 'allow' as const },
  { permission: 'external_directory', pattern: `${TOOL_OUTPUT_DIR}/**`, action: 'allow' as const },
]

beforeEach(() => {
  __resetLoopPermissionCache()
})

describe('buildLoopPermissionRuleset', () => {
  test('loop ruleset: allow-all first, external_directory denied then tool-output allowed, code-agent denies, then operational denies last', () => {
    const rules = buildLoopPermissionRuleset()
    expect(rules).toEqual([
      { permission: '*',                  pattern: '*', action: 'allow' },
      { permission: 'external_directory', pattern: '*', action: 'deny' },
      ...TOOL_OUTPUT_ALLOW_RULES,
      { permission: 'review-write',       pattern: '*', action: 'deny' },
      { permission: 'review-delete',      pattern: '*', action: 'deny' },
      { permission: 'plan',               pattern: '*', action: 'deny' },
      { permission: 'plan_enter',         pattern: '*', action: 'deny' },
      { permission: 'plan_exit',          pattern: '*', action: 'deny' },
      { permission: 'execute-plan',       pattern: '*', action: 'deny' },
      { permission: 'question',           pattern: '*', action: 'deny' },
      { permission: 'loop-cancel',        pattern: '*', action: 'deny' },
      { permission: 'loop-status',        pattern: '*', action: 'deny' },
      { permission: 'launch-group',       pattern: '*', action: 'deny' },
      { permission: 'group-status',       pattern: '*', action: 'deny' },
      { permission: 'group-cancel',       pattern: '*', action: 'deny' },
    ])
  })

  test('emits no sh or bash rules (native bash is covered by the blanket allow)', () => {
    const rules = buildLoopPermissionRuleset()
    expect(rules.some((r) => r.permission === 'sh' || r.permission === 'bash')).toBe(false)
  })

  test('EMITS session-level denies for code-agent tool exclusions (auditor now runs in separate session)', () => {
    const required = ['review-write', 'review-delete', 'plan', 'plan_enter', 'plan_exit', 'execute-plan', 'question']
    const rules = buildLoopPermissionRuleset()
    for (const tool of required) {
      expect(rules.find((r) => r.permission === tool && r.action === 'deny')).toBeDefined()
    }
  })

  test('contains external_directory:*:deny rule', () => {
    const rules = buildLoopPermissionRuleset()
    expect(rules).toContainEqual({ permission: 'external_directory', pattern: '*', action: 'deny' })
  })

  test('always allows the opencode tool-output directory, layered after the blanket deny', () => {
    const rules = buildLoopPermissionRuleset()
    const denyIdx = rules.findIndex(
      (r) => r.permission === 'external_directory' && r.pattern === '*' && r.action === 'deny',
    )
    expect(denyIdx).toBeGreaterThanOrEqual(0)
    for (const allowRule of TOOL_OUTPUT_ALLOW_RULES) {
      const idx = rules.findIndex(
        (r) => r.permission === allowRule.permission && r.pattern === allowRule.pattern && r.action === allowRule.action,
      )
      expect(idx).toBeGreaterThan(denyIdx)
    }
  })

  test('does not allow arbitrary external directories beyond tool-output and configured opt-ins', () => {
    const rules = buildLoopPermissionRuleset()
    const allowPatterns = rules
      .filter((r) => r.permission === 'external_directory' && r.action === 'allow')
      .map((r) => r.pattern)
    expect(allowPatterns).toEqual([TOOL_OUTPUT_DIR, `${TOOL_OUTPUT_DIR}/**`])
  })
})

describe('buildAuditSessionPermissionRuleset', () => {
  test('audit session ruleset: allow-all, external_directory denied, mutation denies', () => {
    const rules = buildAuditSessionPermissionRuleset()
    expect(rules[0]).toEqual({ permission: '*', pattern: '*', action: 'allow' })
    expect(rules[1]).toEqual({ permission: 'external_directory', pattern: '*', action: 'deny' })

    // Mutation denies
    expect(rules.some(r => r.permission === 'edit' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'write' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'multiedit' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'apply_patch' && r.pattern === '*' && r.action === 'deny')).toBe(true)

    // No shell-specific rules: native bash is covered by the blanket allow.
    expect(rules.some(r => r.permission === 'sh' || r.permission === 'bash')).toBe(false)

    // Loop/plan denies
    expect(rules.some(r => r.permission === 'plan' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'plan_enter' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'plan_exit' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'execute-plan' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'question' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'loop-cancel' && r.pattern === '*' && r.action === 'deny')).toBe(true)
    expect(rules.some(r => r.permission === 'loop-status' && r.pattern === '*' && r.action === 'deny')).toBe(true)
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
    const mockCreate = vi.fn(async (params: any) => ({ id: 'audit-session' }))
    const mockClient = {
      session: {
        create: mockCreate,
        get: vi.fn(async () => ({})),
        promptAsync: vi.fn(async () => {}),
        aborts: vi.fn(async () => {}),
        status: vi.fn(async () => ({})),
        messages: vi.fn(async () => []),
        update: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      },
      workspace: {
        create: vi.fn(async () => ({ id: '', directory: '', branch: '' })),
        list: vi.fn(async () => []),
        status: vi.fn(async () => []),
        syncList: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        warp: vi.fn(async () => {}),
      },
      tui: {
        publish: vi.fn(async () => {}),
        selectSession: vi.fn(async () => {}),
      },
      sync: {
        start: vi.fn(async () => {}),
      },
    } as any

    const logger = { log: vi.fn(), error: vi.fn() } as unknown as Logger

    await createAuditSession({
      client: mockClient,
      loopName: 'permission-loop',
      iteration: 1,
      currentSectionIndex: 0,
      totalSections: 1,
      worktreeDir: '/tmp/permission-loop',
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
    const mockCreate = vi.fn(async (params: any) => ({ id: 'loop-session' }))
    const mockClient = {
      session: {
        create: mockCreate,
        get: vi.fn(async () => ({})),
        promptAsync: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
        status: vi.fn(async () => ({})),
        messages: vi.fn(async () => []),
        update: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      },
      workspace: {
        create: vi.fn(async () => ({ id: '', directory: '', branch: '' })),
        list: vi.fn(async () => []),
        status: vi.fn(async () => []),
        syncList: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        warp: vi.fn(async () => {}),
      },
      tui: {
        publish: vi.fn(async () => {}),
        selectSession: vi.fn(async () => {}),
      },
      sync: {
        start: vi.fn(async () => {}),
      },
    } as any

    const logger = { log: vi.fn(), error: vi.fn() } as unknown as Logger

    await createLoopSessionWithWorkspace({
      client: mockClient,
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
    const mockGet = vi.fn(async () => ({ permission: buildLoopPermissionRuleset() }))
    const mockUpdate = vi.fn(async () => {})
    const mockResolve = vi.fn(async () => null)
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

    const hook = createLoopPermissionRejectHook({
      client: {
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
    const mockGet = vi.fn(async () => ({ permission: parentPermission }))
    const mockUpdate = vi.fn(async () => {})
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

    const hook = createLoopPermissionRejectHook({
      client: {
        session: {
          get: mockGet,
          update: mockUpdate,
        },
      } as any,
      sessionLoopResolver: {
        resolveActiveLoopForSession: vi.fn(async () => ({
          loopName: 'active-loop',
          active: true,
          worktreeDir: '/repo/.worktrees/active-loop',
          sandbox: true,
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

  test('falls back to worktree-only rules when parent permissions are unavailable for a non-sandbox loop', async () => {
    const mockGet = vi.fn(async () => ({}))
    const mockUpdate = vi.fn(async () => {})
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

    const hook = createLoopPermissionRejectHook({
      client: { session: { get: mockGet, update: mockUpdate } } as any,
      sessionLoopResolver: {
        resolveActiveLoopForSession: vi.fn(async () => ({
          loopName: 'active-loop',
          active: true,
          worktreeDir: '/repo/.worktrees/active-loop',
          sandbox: false,
        })),
      } as any,
      directory: '/repo',
      logger,
    })

    await hook({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-session', parentID: 'parent-session' } },
      },
    })

    expect(mockUpdate).toHaveBeenCalledWith({
      sessionID: 'child-session',
      directory: '/repo/.worktrees/active-loop',
      permission: buildLoopPermissionRuleset(),
    })
  })

  test('fallback ruleset includes configured external-directory allowlist for subagent sessions', async () => {
    const VAULT = '/Users/chris/Documents/Obsidian/GFPRO'
    const mockGet = vi.fn(async () => ({}))
    const mockUpdate = vi.fn(async () => {})
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

    const hook = createLoopPermissionRejectHook({
      client: { session: { get: mockGet, update: mockUpdate } } as any,
      sessionLoopResolver: {
        resolveActiveLoopForSession: vi.fn(async () => ({
          loopName: 'active-loop',
          active: true,
          worktreeDir: '/repo/.worktrees/active-loop',
          sandbox: false,
        })),
      } as any,
      directory: '/repo',
      logger,
      getAllowExternalDirectories: () => [VAULT],
    })

    await hook({
      event: {
        type: 'session.created',
        properties: { info: { id: 'child-session', parentID: 'parent-session' } },
      },
    })

    expect(mockUpdate).toHaveBeenCalledWith({
      sessionID: 'child-session',
      directory: '/repo/.worktrees/active-loop',
      permission: buildLoopPermissionRuleset({ allowDirectories: [VAULT] }),
    })
  })

  test('is idempotent: firing twice for the same child session results in a single session.update call', async () => {
    const parentPermission = buildLoopPermissionRuleset()
    const mockGet = vi.fn(async () => ({ permission: parentPermission }))
    const mockUpdate = vi.fn(async () => {})
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

    const hook = createLoopPermissionRejectHook({
      client: { session: { get: mockGet, update: mockUpdate } } as any,
      sessionLoopResolver: {
        resolveActiveLoopForSession: vi.fn(async () => ({
          loopName: 'active-loop',
          active: true,
          worktreeDir: '/repo/.worktrees/active-loop',
          sandbox: true,
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
