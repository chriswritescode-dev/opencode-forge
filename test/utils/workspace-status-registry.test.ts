import { describe, it, expect, vi } from 'vitest'
import { createWorkspaceStatusRegistry, type WorkspaceStatusRegistry } from '../../src/utils/workspace-status-registry'

function createMockLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

describe('workspace-status-registry', () => {
  describe('cached connected status', () => {
    it('resolves immediately with source: cached', async () => {
      const registry = createWorkspaceStatusRegistry()

      registry.recordEvent({
        type: 'workspace.status',
        properties: { workspaceID: 'ws-1', status: 'connected' },
      })

      const result = await registry.awaitConnected('ws-1')

      expect(result.connected).toBe(true)
      expect(result.source).toBe('cached')
      expect(result.elapsedMs).toBe(0)
    })
  })

  describe('event-resolved connected status', () => {
    it('resolves when a later workspace.status event arrives with source: event', async () => {
      const registry = createWorkspaceStatusRegistry()
      const promise = registry.awaitConnected('ws-1')

      registry.recordEvent({
        type: 'workspace.status',
        properties: { workspaceID: 'ws-1', status: 'connected' },
      })

      const result = await promise

      expect(result.connected).toBe(true)
      expect(result.source).toBe('event')
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('timeout behavior', () => {
    it('resolves with connected: false and reason: timeout', async () => {
      const registry = createWorkspaceStatusRegistry()

      const result = await registry.awaitConnected('ws-1', { timeoutMs: 50 })

      expect(result.connected).toBe(false)
      expect(result.reason).toBe('timeout')
      expect(result.source).toBe('timeout')
      expect(result.lastStatus).toBeUndefined()
      expect(result.elapsedMs).toBeGreaterThanOrEqual(40)
    })
  })

  describe('concurrent waiters', () => {
    it('multiple waiters for one workspace all resolve from one event', async () => {
      const registry = createWorkspaceStatusRegistry()

      const p1 = registry.awaitConnected('ws-1')
      const p2 = registry.awaitConnected('ws-1')
      const p3 = registry.awaitConnected('ws-1')

      registry.recordEvent({
        type: 'workspace.status',
        properties: { workspaceID: 'ws-1', status: 'connected' },
      })

      const [r1, r2, r3] = await Promise.all([p1, p2, p3])

      expect(r1.connected).toBe(true)
      expect(r2.connected).toBe(true)
      expect(r3.connected).toBe(true)
      expect(r1.source).toBe('event')
      expect(r2.source).toBe('event')
      expect(r3.source).toBe('event')
    })
  })

  describe('connecting before connected does not resolve early', () => {
    it('does not resolve waiter on connecting status', async () => {
      const registry = createWorkspaceStatusRegistry()

      let resolved = false
      const promise = registry.awaitConnected('ws-1', { timeoutMs: 100 }).then((r) => {
        resolved = true
        return r
      })

      registry.recordEvent({
        type: 'workspace.status',
        properties: { workspaceID: 'ws-1', status: 'connecting' },
      })

      // Small delay to ensure the connecting event has been processed
      await new Promise((r) => setTimeout(r, 10))

      expect(resolved).toBe(false)

      // Now send connected to resolve the waiter
      registry.recordEvent({
        type: 'workspace.status',
        properties: { workspaceID: 'ws-1', status: 'connected' },
      })

      const result = await promise

      expect(resolved).toBe(true)
      expect(result.connected).toBe(true)
      expect(result.source).toBe('event')
    })
  })

  describe('non-workspace events are ignored', () => {
    it('ignores events with type other than workspace.status or workspace.ready', () => {
      const registry = createWorkspaceStatusRegistry()

      registry.recordEvent({
        type: 'server.instance.disposed',
        properties: { workspaceID: 'ws-1', status: 'connected' },
      })

      expect(registry.getStatus('ws-1')).toBeUndefined()
    })

    it('ignores events without workspaceID', () => {
      const registry = createWorkspaceStatusRegistry()

      registry.recordEvent({
        type: 'workspace.status',
        properties: { status: 'connected' },
      })

      expect(registry.getStatus('ws-1')).toBeUndefined()
    })

    it('ignores events with unknown status', () => {
      const registry = createWorkspaceStatusRegistry()

      registry.recordEvent({
        type: 'workspace.status',
        properties: { workspaceID: 'ws-1', status: 'unknown_status' },
      })

      expect(registry.getStatus('ws-1')).toBeUndefined()
    })

    it('ignores events with missing properties', () => {
      const registry = createWorkspaceStatusRegistry()

      registry.recordEvent({ type: 'workspace.status' })

      expect(registry.getStatus('ws-1')).toBeUndefined()
    })
  })

  describe('getStatus', () => {
    it('returns undefined for unknown workspace', () => {
      const registry = createWorkspaceStatusRegistry()
      expect(registry.getStatus('nonexistent')).toBeUndefined()
    })

    it('returns correct status after recording event', () => {
      const registry = createWorkspaceStatusRegistry()

      registry.recordEvent({
        type: 'workspace.status',
        properties: { workspaceID: 'ws-1', status: 'connecting' },
      })

      expect(registry.getStatus('ws-1')).toBe('connecting')

      registry.recordEvent({
        type: 'workspace.status',
        properties: { workspaceID: 'ws-1', status: 'connected' },
      })

      expect(registry.getStatus('ws-1')).toBe('connected')
    })
  })

  describe('recordEvent never throws', () => {
    it('does not throw even with malformed input', () => {
      const registry = createWorkspaceStatusRegistry()

      expect(() => registry.recordEvent(null as unknown as { type: string })).not.toThrow()
      expect(() => registry.recordEvent(undefined as unknown as { type: string })).not.toThrow()
      expect(() => registry.recordEvent({} as unknown as { type: string })).not.toThrow()
      expect(() =>
        registry.recordEvent({
          type: 'workspace.status',
          properties: null as unknown as Record<string, unknown>,
        }),
      ).not.toThrow()
    })
  })

  describe('logger dependency', () => {
    it('calls logger.debug for valid events', () => {
      const logger = createMockLogger()
      const registry = createWorkspaceStatusRegistry({ logger })

      registry.recordEvent({
        type: 'workspace.status',
        properties: { workspaceID: 'ws-1', status: 'connected' },
      })

      expect(logger.debug).toHaveBeenCalledWith(
        '[workspace-status-registry] ws-1 -> connected',
      )
    })
  })

  describe('primeFromSnapshot', () => {
    it('resolves pending waiters for connected workspaces from snapshot', async () => {
      const registry = createWorkspaceStatusRegistry()

      const promise = registry.awaitConnected('ws-1')

      registry.primeFromSnapshot([{ workspaceID: 'ws-1', status: 'connected' }])

      const result = await promise

      expect(result.connected).toBe(true)
      expect(result.source).toBe('event')
    })

    it('does not resolve waiters for non-connected statuses', async () => {
      const registry = createWorkspaceStatusRegistry()

      let resolved = false
      const promise = registry.awaitConnected('ws-1', { timeoutMs: 50 }).then((r) => {
        resolved = true
        return r
      })

      registry.primeFromSnapshot([{ workspaceID: 'ws-1', status: 'connecting' }])

      await new Promise((r) => setTimeout(r, 10))

      expect(resolved).toBe(false)

      const result = await promise

      expect(result.connected).toBe(false)
      expect(result.reason).toBe('timeout')
    })

    it('updates status cache for snapshot entries', () => {
      const registry = createWorkspaceStatusRegistry()

      registry.primeFromSnapshot([
        { workspaceID: 'ws-1', status: 'connected' },
        { workspaceID: 'ws-2', status: 'disconnected' },
      ])

      expect(registry.getStatus('ws-1')).toBe('connected')
      expect(registry.getStatus('ws-2')).toBe('disconnected')
    })

    it('ignores unknown statuses without throwing', () => {
      const registry = createWorkspaceStatusRegistry()

      expect(() =>
        registry.primeFromSnapshot([{ workspaceID: 'ws-1', status: 'unknown_status' }]),
      ).not.toThrow()

      expect(registry.getStatus('ws-1')).toBeUndefined()
    })

    it('handles empty snapshot array', () => {
      const registry = createWorkspaceStatusRegistry()

      expect(() => registry.primeFromSnapshot([])).not.toThrow()
    })

    it('does not throw with malformed input', () => {
      const registry = createWorkspaceStatusRegistry()

      expect(() => registry.primeFromSnapshot(null as unknown as Array<{ workspaceID: string; status: string }>)).not.toThrow()
      expect(() => registry.primeFromSnapshot(undefined as unknown as Array<{ workspaceID: string; status: string }>)).not.toThrow()
    })
  })

  describe('default timeout', () => {
    it('uses default 5000ms timeout when no options provided', async () => {
      vi.useFakeTimers()
      try {
        const registry = createWorkspaceStatusRegistry()

        const promise = registry.awaitConnected('ws-1')
        await vi.advanceTimersByTimeAsync(5000)
        const result = await promise

        expect(result.connected).toBe(false)
        expect(result.reason).toBe('timeout')
        expect(result.elapsedMs).toBeGreaterThanOrEqual(4800)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
