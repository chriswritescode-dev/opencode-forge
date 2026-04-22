import { describe, test, expect } from 'bun:test'
import { createPermissionAskHandler, type PermissionAskDeps } from '../src/hooks/permission-ask'
import type { Permission } from '@opencode-ai/sdk'

const mockLogger = {
  log: () => {},
  debug: () => {},
  error: () => {},
}

describe('createPermissionAskHandler', () => {
  test('worktree loop (sandbox) + non-push pattern → falls through to opencode default', async () => {
    const resolver = {
      resolveActiveLoopForSession: async (_sessionId: string) => ({ loopName: 'test-loop', active: true, sandbox: true, worktreeDir: '/tmp/test' }),
    }

    const logs: string[] = []
    const logger = { ...mockLogger, log: (msg: string) => logs.push(msg) }

    const handler = createPermissionAskHandler({ resolver: resolver as any, logger })
    const output: { status?: 'allow' | 'deny' | 'ask' } = {}

    await handler(
      { sessionID: 'session-1', type: 'bash', pattern: 'ls *', id: '1', messageID: '1', title: 'test', metadata: {}, time: { created: 0 } } as Permission,
      output,
    )

    expect(output.status).toBeUndefined()
    expect(logs.some((l) => l.includes('worktree loop'))).toBe(true)
  })

  test('worktree loop (sandbox) + git push origin main → falls through to opencode default', async () => {
    const resolver = {
      resolveActiveLoopForSession: async (_sessionId: string) => ({ loopName: 'test-loop', active: true, sandbox: true, worktreeDir: '/tmp/test' }),
    }

    const logs: string[] = []
    const logger = { ...mockLogger, log: (msg: string) => logs.push(msg) }

    const handler = createPermissionAskHandler({ resolver: resolver as any, logger })
    const output: { status?: 'allow' | 'deny' | 'ask' } = {}

    await handler(
      { sessionID: 'session-1', type: 'bash', pattern: 'git push origin main', id: '1', messageID: '1', title: 'test', metadata: {}, time: { created: 0 } } as Permission,
      output,
    )

    expect(output.status).toBeUndefined()
    expect(logs.some((l) => l.includes('worktree loop'))).toBe(true)
  })

  test('worktree loop (sandbox) + mixed patterns including git push → falls through to opencode default', async () => {
    const resolver = {
      resolveActiveLoopForSession: async (_sessionId: string) => ({ loopName: 'test-loop', active: true, sandbox: true, worktreeDir: '/tmp/test' }),
    }

    const logs: string[] = []
    const logger = { ...mockLogger, log: (msg: string) => logs.push(msg) }

    const handler = createPermissionAskHandler({ resolver: resolver as any, logger })
    const output: { status?: 'allow' | 'deny' | 'ask' } = {}

    await handler(
      { sessionID: 'session-1', type: 'bash', pattern: ['ls *', 'git push origin main'], id: '1', messageID: '1', title: 'test', metadata: {}, time: { created: 0 } } as Permission,
      output,
    )

    expect(output.status).toBeUndefined()
    expect(logs.some((l) => l.includes('worktree loop'))).toBe(true)
  })

  test('worktree loop (non-sandbox) + non-push pattern → falls through to opencode default', async () => {
    const resolver = {
      resolveActiveLoopForSession: async (_sessionId: string) => ({ loopName: 'test-loop', active: true, sandbox: false, worktreeDir: '/tmp/test' }),
    }

    const logs: string[] = []
    const logger = { ...mockLogger, log: (msg: string) => logs.push(msg) }

    const handler = createPermissionAskHandler({ resolver: resolver as any, logger })
    const output: { status?: 'allow' | 'deny' | 'ask' } = {}

    await handler(
      { sessionID: 'session-worktree', type: 'bash', pattern: 'ls *', id: '1', messageID: '1', title: 'test', metadata: {}, time: { created: 0 } } as Permission,
      output,
    )

    expect(output.status).toBeUndefined()
    expect(logs.some((l) => l.includes('worktree loop'))).toBe(true)
  })

  test('worktree loop (non-sandbox) + git push → falls through to opencode default', async () => {
    const resolver = {
      resolveActiveLoopForSession: async (_sessionId: string) => ({ loopName: 'test-loop', active: true, sandbox: false, worktreeDir: '/tmp/test' }),
    }

    const logs: string[] = []
    const logger = { ...mockLogger, log: (msg: string) => logs.push(msg) }

    const handler = createPermissionAskHandler({ resolver: resolver as any, logger })
    const output: { status?: 'allow' | 'deny' | 'ask' } = {}

    await handler(
      { sessionID: 'session-worktree', type: 'bash', pattern: 'git push origin main', id: '1', messageID: '1', title: 'test', metadata: {}, time: { created: 0 } } as Permission,
      output,
    )

    expect(output.status).toBeUndefined()
    expect(logs.some((l) => l.includes('worktree loop'))).toBe(true)
  })

  test('in-place loop (non-worktree) → falls through to host default (output.status unchanged)', async () => {
    const resolver = {
      resolveActiveLoopForSession: async (_sessionId: string) => ({ loopName: 'test-loop', active: true, sandbox: false }),
    }

    const logs: string[] = []
    const logger = { ...mockLogger, log: (msg: string) => logs.push(msg) }

    const handler = createPermissionAskHandler({ resolver: resolver as any, logger })
    const output: { status?: 'allow' | 'deny' | 'ask' } = {}

    await handler(
      { sessionID: 'session-inplace', type: 'bash', pattern: 'ls *', id: '1', messageID: '1', title: 'test', metadata: {}, time: { created: 0 } } as Permission,
      output,
    )

    expect(output.status).toBeUndefined()
    expect(logs.some((l) => l.includes('not a worktree loop'))).toBe(true)
  })

  test('unresolved session → output.status unchanged', async () => {
    const resolver = {
      resolveActiveLoopForSession: async (_sessionId: string) => null,
    }

    const logs: string[] = []
    const logger = { ...mockLogger, log: (msg: string) => logs.push(msg) }

    const handler = createPermissionAskHandler({ resolver: resolver as any, logger })
    const output: { status?: 'allow' | 'deny' | 'ask' } = {}

    await handler(
      { sessionID: 'session-unknown', type: 'bash', pattern: 'ls *', id: '1', messageID: '1', title: 'test', metadata: {}, time: { created: 0 } } as Permission,
      output,
    )

    expect(output.status).toBeUndefined()
    expect(logs.some((l) => l.includes('unresolved'))).toBe(true)
  })

  test('logger called with entry log and outcome log', async () => {
    const resolver = {
      resolveActiveLoopForSession: async (_sessionId: string) => ({ loopName: 'test-loop', active: true, sandbox: true }),
    }

    const logs: string[] = []
    const logger = { ...mockLogger, log: (msg: string) => logs.push(msg) }

    const handler = createPermissionAskHandler({ resolver: resolver as any, logger })
    const output: { status?: 'allow' | 'deny' | 'ask' } = {}

    await handler(
      { sessionID: 'session-1', type: 'bash', pattern: 'echo hello', id: '1', messageID: '1', title: 'test', metadata: {}, time: { created: 0 } } as Permission,
      output,
    )

    expect(logs.some((l) => l.includes('[permission.ask]'))).toBe(true)
    expect(logs.some((l) => l.includes('session=session-1'))).toBe(true)
  })
})