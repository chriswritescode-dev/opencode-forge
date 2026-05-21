import { describe, test, expect, mock } from 'bun:test'
import { createLoopPermissionAskHook } from '../../src/hooks/loop-permission-ask'
import type { Logger } from '../../src/types'

function makeLogger(): Logger {
  return { log: mock(), error: mock(), debug: mock() } as unknown as Logger
}

function makeResolver(result: Awaited<ReturnType<ReturnType<typeof import('../../src/services/session-loop-resolver').createSessionLoopResolver>['resolveActiveLoopForSession']>>) {
  return { resolveActiveLoopForSession: mock(async () => result) }
}

describe('createLoopPermissionAskHook', () => {
  test('no-op when session is outside an active loop', async () => {
    const logger = makeLogger()
    const hook = createLoopPermissionAskHook({
      sessionLoopResolver: makeResolver(null) as any,
      logger,
    })
    const output = { status: 'ask' as const }
    await hook({ sessionID: 'sess-1', type: 'bash', pattern: 'ls' }, output)
    expect(output.status).toBe('ask')
  })

  test('sets status=allow for tools matching loop allow-all', async () => {
    const logger = makeLogger()
    const hook = createLoopPermissionAskHook({
      sessionLoopResolver: makeResolver({ loopName: 'my-loop', active: true }) as any,
      logger,
    })
    const output = { status: 'ask' as 'ask' | 'deny' | 'allow' }
    await hook({ sessionID: 'sess-1', type: 'bash', pattern: 'ls' }, output)
    expect(output.status).toBe('allow')
  })

  test('sets status=deny for git push', async () => {
    const logger = makeLogger()
    const hook = createLoopPermissionAskHook({
      sessionLoopResolver: makeResolver({ loopName: 'my-loop', active: true }) as any,
      logger,
    })
    const output = { status: 'ask' as 'ask' | 'deny' | 'allow' }
    await hook({ sessionID: 'sess-1', type: 'bash', pattern: 'git push origin main' }, output)
    expect(output.status).toBe('deny')
  })

  test('sets status=deny for review-write', async () => {
    const logger = makeLogger()
    const hook = createLoopPermissionAskHook({
      sessionLoopResolver: makeResolver({ loopName: 'my-loop', active: true }) as any,
      logger,
    })
    const output = { status: 'ask' as 'ask' | 'deny' | 'allow' }
    await hook({ sessionID: 'sess-1', type: 'review-write' }, output)
    expect(output.status).toBe('deny')
  })

  test('sets status=deny for external_directory', async () => {
    const logger = makeLogger()
    const hook = createLoopPermissionAskHook({
      sessionLoopResolver: makeResolver({ loopName: 'my-loop', active: true }) as any,
      logger,
    })
    const output = { status: 'ask' as 'ask' | 'deny' | 'allow' }
    await hook({ sessionID: 'sess-1', type: 'external_directory', pattern: '/etc/passwd' }, output)
    expect(output.status).toBe('deny')
  })

  test('handles pattern as string[] by using first element', async () => {
    const logger = makeLogger()
    const hook = createLoopPermissionAskHook({
      sessionLoopResolver: makeResolver({ loopName: 'my-loop', active: true }) as any,
      logger,
    })
    const output = { status: 'ask' as 'ask' | 'deny' | 'allow' }
    await hook({ sessionID: 'sess-1', type: 'bash', pattern: ['git push origin main'] }, output)
    expect(output.status).toBe('deny')
  })

  test('missing sessionID is a no-op', async () => {
    const logger = makeLogger()
    const hook = createLoopPermissionAskHook({
      sessionLoopResolver: makeResolver({ loopName: 'my-loop', active: true }) as any,
      logger,
    })
    const output = { status: 'ask' as 'ask' | 'deny' | 'allow' }
    await hook({ sessionID: '', type: 'bash', pattern: 'ls' }, output)
    expect(output.status).toBe('ask')
  })
})

describe('integration with sessionLoopResolver', () => {
  test('when resolver returns active=false, hook is a no-op', async () => {
    const logger = makeLogger()
    const hook = createLoopPermissionAskHook({
      sessionLoopResolver: makeResolver({ loopName: 'x', active: false }) as any,
      logger,
    })
    const output = { status: 'ask' as 'ask' | 'deny' | 'allow' }
    await hook({ sessionID: 'sess-1', type: 'bash', pattern: 'ls' }, output)
    expect(output.status).toBe('ask')
  })

  test('resolver errors are swallowed and hook is a no-op', async () => {
    const logger = makeLogger()
    const hook = createLoopPermissionAskHook({
      sessionLoopResolver: {
        resolveActiveLoopForSession: mock(async () => { throw new Error('resolver failed') }),
      } as any,
      logger,
    })
    const output = { status: 'ask' as 'ask' | 'deny' | 'allow' }
    await hook({ sessionID: 'sess-1', type: 'bash', pattern: 'ls' }, output)
    expect(output.status).toBe('ask')
    expect((logger.error as ReturnType<typeof mock>).mock.calls.length).toBe(1)
  })

  test('two concurrent asks for the same session both get answered without sharing state', async () => {
    const logger = makeLogger()
    const hook = createLoopPermissionAskHook({
      sessionLoopResolver: makeResolver({ loopName: 'my-loop', active: true }) as any,
      logger,
    })
    const outputA = { status: 'ask' as 'ask' | 'deny' | 'allow' }
    const outputB = { status: 'ask' as 'ask' | 'deny' | 'allow' }
    await Promise.all([
      hook({ sessionID: 'sess-1', type: 'bash', pattern: 'git push origin main' }, outputA),
      hook({ sessionID: 'sess-1', type: 'bash', pattern: 'ls' }, outputB),
    ])
    expect(outputA.status).toBe('deny')
    expect(outputB.status).toBe('allow')
  })
})
