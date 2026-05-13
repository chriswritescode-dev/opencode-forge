import { describe, test, expect, vi, beforeEach } from 'vitest'
import { selectInitialWorktreeSession } from '../../src/services/execution'
import { createWorkspaceStatusRegistry } from '../../src/utils/workspace-status-registry'

const mockLogger = {
  log: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

describe('selectInitialWorktreeSession', () => {
  beforeEach(() => {
    mockLogger.log.mockClear()
    mockLogger.error.mockClear()
    mockLogger.debug.mockClear()
  })

  test('cached readiness calls selectSessionFn once with sessionID and workspace', async () => {
    const registry = createWorkspaceStatusRegistry({ logger: mockLogger })
    registry.primeFromSnapshot([{ workspaceID: 'ws_test', status: 'connected' }])
    const selectFn = vi.fn().mockResolvedValue(undefined)

    await selectInitialWorktreeSession('session1', 'ws_test', 'test-context', {
      selectSession: true,
      logger: mockLogger,
      workspaceStatusRegistry: registry,
      selectSessionFn: selectFn,
    })

    expect(selectFn).toHaveBeenCalledTimes(1)
    expect(selectFn).toHaveBeenCalledWith({ sessionID: 'session1', workspace: 'ws_test' })

    const logCalls = mockLogger.log.mock.calls.map((c: string[]) => c[0])
    expect(logCalls.some((m: string) => m.includes('[warp] select.ready') && m.includes('source=cached'))).toBe(true)
    expect(logCalls.some((m: string) => m.includes('[warp] select.complete') && m.includes('context="test-context"'))).toBe(true)
  })

  test('event readiness delays selection until resolved and logs elapsedMs >= 50ms', async () => {
    const registry = createWorkspaceStatusRegistry({ logger: mockLogger })
    const selectFn = vi.fn().mockResolvedValue(undefined)

    // Start the selection (which will block waiting for connected status)
    const promise = selectInitialWorktreeSession('session1', 'ws_test', 'test-event', {
      selectSession: true,
      logger: mockLogger,
      workspaceStatusRegistry: registry,
      selectSessionFn: selectFn,
    })

    // Wait at least 50ms before sending event
    await new Promise<void>((resolve) => setTimeout(resolve, 60))

    // Record an event that triggers connected status
    registry.recordEvent({
      type: 'workspace.status',
      properties: { workspaceID: 'ws_test', status: 'connected' },
    })

    await promise

    expect(selectFn).toHaveBeenCalledTimes(1)
    expect(selectFn).toHaveBeenCalledWith({ sessionID: 'session1', workspace: 'ws_test' })

    const logCalls = mockLogger.log.mock.calls.map((c: string[]) => c[0])
    expect(logCalls.some((m: string) => m.includes('[warp] select.ready') && m.includes('source=event'))).toBe(true)

    // Check that elapsedMs is at least 50ms (allowing for small timing variance)
    const readyLog = logCalls.find(
      (m: string) => m.includes('[warp] select.ready') && m.includes('source=event'),
    )
    if (!readyLog) throw new Error('Expected ready log with source=event')
    const elapsedMatch = readyLog.match(/elapsedMs=(\d+)/)
    expect(elapsedMatch).not.toBeNull()
    expect(Number(elapsedMatch![1])).toBeGreaterThanOrEqual(50)
  }, 10_000)

  test('timeout readiness still calls selectSessionFn and logs degraded message', async () => {
    const registry = createWorkspaceStatusRegistry({ logger: mockLogger })
    const selectFn = vi.fn().mockResolvedValue(undefined)

    // Use a short timeout so the test doesn't hang
    // We override awaitConnected indirectly via the timeout param in the function
    // The function passes { timeoutMs: 5000 }, but we can test with a shorter approach

    // Actually, we need to verify that when timeout fires, it still calls selectSessionFn
    // The function uses timeoutMs: 5000 which is too long for tests.
    // Instead, we can call it without connecting the workspace and see what happens after timeout.

    // Since we can't easily modify the timeout value used internally, let's just
    // verify behavior by not priming or recording events. This will result in timeout behavior.

    // For testing purposes, let's mock awaitConnected to return timeout faster
    // Actually, since the function creates its own timeout, we need to work with it differently.

    // Best approach: use a fake registry that immediately returns timeout
    const fakeRegistry = {
      recordEvent: vi.fn(),
      getStatus: vi.fn(),
      primeFromSnapshot: vi.fn(),
      awaitConnected: vi.fn().mockResolvedValue({
        connected: false,
        source: 'timeout',
        reason: 'timeout',
        lastStatus: undefined,
        elapsedMs: 100,
      }),
    }

    await selectInitialWorktreeSession('session1', 'ws_test', 'test-timeout', {
      selectSession: true,
      logger: mockLogger,
      workspaceStatusRegistry: fakeRegistry as any,
      selectSessionFn: selectFn,
    })

    expect(selectFn).toHaveBeenCalledTimes(1)
    expect(selectFn).toHaveBeenCalledWith({ sessionID: 'session1', workspace: 'ws_test' })

    const logCalls = mockLogger.log.mock.calls.map((c: string[]) => c[0])
    expect(logCalls.some((m: string) => m.includes('[warp] select.degraded') && m.includes('reason="timeout"'))).toBe(true)
    expect(logCalls.some((m: string) => m.includes('[warp] select.complete') && m.includes('context="test-timeout"'))).toBe(true)
  })

  test('lifecycle.selectSession === false skips selection and logs skipped', async () => {
    const registry = createWorkspaceStatusRegistry({ logger: mockLogger })
    const selectFn = vi.fn().mockResolvedValue(undefined)

    await selectInitialWorktreeSession('session1', 'ws_test', 'test-skip-select', {
      selectSession: false,
      logger: mockLogger,
      workspaceStatusRegistry: registry,
      selectSessionFn: selectFn,
    })

    expect(selectFn).not.toHaveBeenCalled()

    const logCalls = mockLogger.log.mock.calls.map((c: string[]) => c[0])
    expect(logCalls.some((m: string) => m.includes('[warp] select.entry') && m.includes('context="test-skip-select"'))).toBe(true)
    expect(logCalls.some((m: string) =>
      m.includes('[warp] select.exit') && m.includes('reason=no-select-session'),
    )).toBe(true)
  })

  test('missing boundWorkspaceId skips selection and logs skipped', async () => {
    const registry = createWorkspaceStatusRegistry({ logger: mockLogger })
    const selectFn = vi.fn().mockResolvedValue(undefined)

    await selectInitialWorktreeSession('session1', undefined, 'test-skip-workspace', {
      selectSession: true,
      logger: mockLogger,
      workspaceStatusRegistry: registry,
      selectSessionFn: selectFn,
    })

    expect(selectFn).not.toHaveBeenCalled()

    const logCalls = mockLogger.log.mock.calls.map((c: string[]) => c[0])
    expect(logCalls.some((m: string) => m.includes('[warp] select.entry') && m.includes('context="test-skip-workspace"'))).toBe(true)
    expect(logCalls.some((m: string) =>
      m.includes('[warp] select.exit') && m.includes('reason=no-workspace'),
    )).toBe(true)
  })

  test('selection failure logs error message', async () => {
    const registry = createWorkspaceStatusRegistry({ logger: mockLogger })
    registry.primeFromSnapshot([{ workspaceID: 'ws_test', status: 'connected' }])
    const selectFn = vi.fn().mockRejectedValue(new Error('tui unavailable'))

    await selectInitialWorktreeSession('session1', 'ws_test', 'test-failure', {
      selectSession: true,
      logger: mockLogger,
      workspaceStatusRegistry: registry,
      selectSessionFn: selectFn,
    })

    expect(mockLogger.error).toHaveBeenCalled()
    const errorCall = mockLogger.error.mock.calls.find(
      (c: string[]) => c[0].includes('[warp] select.failed') && c[0].includes('context="test-failure"'),
    )
    expect(errorCall).toBeDefined()
    expect(errorCall![0]).toContain('error="tui unavailable"')
  })
})
