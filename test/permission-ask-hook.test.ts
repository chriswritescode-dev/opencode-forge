import { describe, test, expect } from 'bun:test'
import { createPermissionAskHandler } from '../src/hooks/permission-ask'
import type { Permission } from '@opencode-ai/sdk'

const mockLogger = {
  log: () => {},
  debug: () => {},
  error: () => {},
}

function makePermission(overrides: Partial<Permission> = {}): Permission {
  return {
    sessionID: 'session-1',
    type: 'bash',
    pattern: 'ls *',
    id: '1',
    messageID: '1',
    title: 'test',
    metadata: {},
    time: { created: 0 },
    ...overrides,
  } as Permission
}

describe('createPermissionAskHandler', () => {
  test('never mutates output.status (worktree, in-place, or unresolved)', async () => {
    const cases = [
      { loopName: 'wt', active: true, sandbox: true, worktree: true, worktreeDir: '/tmp/wt' },
      { loopName: 'wt-ns', active: true, sandbox: false, worktree: true, worktreeDir: '/tmp/wt' },
      { loopName: 'ip', active: true, sandbox: false, worktree: false, worktreeDir: '/project' },
      null,
    ] as const

    for (const state of cases) {
      const resolver = { resolveActiveLoopForSession: async () => state }
      const handler = createPermissionAskHandler({ resolver: resolver as any, logger: mockLogger })
      const output: { status?: 'allow' | 'deny' | 'ask' } = {}
      await handler(makePermission(), output)
      expect(output.status).toBeUndefined()
    }
  })

  test('logs mode=worktree for worktree loops', async () => {
    const resolver = {
      resolveActiveLoopForSession: async () => ({
        loopName: 'wt-loop',
        active: true,
        sandbox: true,
        worktree: true,
        worktreeDir: '/tmp/wt',
      }),
    }
    const logs: string[] = []
    const logger = { ...mockLogger, log: (msg: string) => logs.push(msg) }
    const handler = createPermissionAskHandler({ resolver: resolver as any, logger })
    await handler(makePermission({ sessionID: 's1' }), {})
    expect(logs.some((l) => l.includes('mode=worktree'))).toBe(true)
    expect(logs.some((l) => l.includes('loop=wt-loop'))).toBe(true)
  })

  test('logs mode=in-place for in-place loops (worktree=false)', async () => {
    const resolver = {
      resolveActiveLoopForSession: async () => ({
        loopName: 'ip-loop',
        active: true,
        sandbox: false,
        worktree: false,
        worktreeDir: '/project',
      }),
    }
    const logs: string[] = []
    const logger = { ...mockLogger, log: (msg: string) => logs.push(msg) }
    const handler = createPermissionAskHandler({ resolver: resolver as any, logger })
    await handler(makePermission({ sessionID: 's2' }), {})
    expect(logs.some((l) => l.includes('mode=in-place'))).toBe(true)
    expect(logs.some((l) => l.includes('loop=ip-loop'))).toBe(true)
  })

  test('logs mode=non-loop when session does not belong to a loop', async () => {
    const resolver = { resolveActiveLoopForSession: async () => null }
    const logs: string[] = []
    const logger = { ...mockLogger, log: (msg: string) => logs.push(msg) }
    const handler = createPermissionAskHandler({ resolver: resolver as any, logger })
    await handler(makePermission({ sessionID: 's3' }), {})
    expect(logs.some((l) => l.includes('mode=non-loop'))).toBe(true)
    expect(logs.some((l) => l.includes('loop=none'))).toBe(true)
  })

  test('serializes array patterns into the log entry', async () => {
    const resolver = {
      resolveActiveLoopForSession: async () => ({
        loopName: 'ip',
        active: true,
        sandbox: false,
        worktree: false,
        worktreeDir: '/project',
      }),
    }
    const logs: string[] = []
    const logger = { ...mockLogger, log: (msg: string) => logs.push(msg) }
    const handler = createPermissionAskHandler({ resolver: resolver as any, logger })
    await handler(makePermission({ pattern: ['ls *', 'git push origin main'] }), {})
    expect(logs.some((l) => l.includes('ls *') && l.includes('git push origin main'))).toBe(true)
  })

  test('treats resolver rejections as non-loop without throwing', async () => {
    const resolver = {
      resolveActiveLoopForSession: async () => { throw new Error('boom') },
    }
    const logs: string[] = []
    const logger = { ...mockLogger, log: (msg: string) => logs.push(msg) }
    const handler = createPermissionAskHandler({ resolver: resolver as any, logger })
    const output: { status?: 'allow' | 'deny' | 'ask' } = {}
    await handler(makePermission({ sessionID: 's4' }), output)
    expect(output.status).toBeUndefined()
    expect(logs.some((l) => l.includes('mode=non-loop'))).toBe(true)
  })
})