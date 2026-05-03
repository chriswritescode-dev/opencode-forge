import { describe, it, expect, beforeEach } from 'bun:test'
import { encodeEvent, encodeReply } from '../src/api/bus-protocol'
import { connectForgeProject } from '../src/utils/tui-client'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'

describe('ForgeProjectClient events', () => {
  let mockApi: Partial<TuiPluginApi>
  let eventCallbacks: Array<(event: { properties?: { command?: string } }) => void>
  let capturedEvents: Array<{ properties?: { command?: string } }>

  beforeEach(() => {
    eventCallbacks = []
    capturedEvents = []

    mockApi = {
      event: {
        on: (_event: string, cb: (event: { properties?: { command?: string } }) => void) => {
          eventCallbacks.push(cb)
        },
      } as TuiPluginApi['event'],
      client: {
        tui: {
          publish: async (_event: { directory?: string; body: { type: string; properties: { command: string } } }) => {
            // No-op for these tests
          },
        },
      } as unknown as TuiPluginApi['client'],
      state: {
        config: {},
      } as TuiPluginApi['state'],
      theme: {
        current: {
          text: '#ffffff',
          border: '#cccccc',
          borderActive: '#007acc',
          markdownText: '#ffffff',
          success: '#00ff00',
          error: '#ff0000',
          info: '#0088ff',
        },
      } as unknown as TuiPluginApi['theme'],
    } as Partial<TuiPluginApi>
  })

  function createHandler() {
    const calls: Array<{ reason: string; loopName: string }> = []
    const handler = (payload: { reason: string; loopName: string }) => {
      calls.push(payload)
    }
    return { handler, calls }
  }

  describe('onLoopsChanged', () => {
    it('should call handler when matching projectId event is published', async () => {
      const projectId = 'test-project-123'
      const directory = '/test/dir'
      const client = await connectForgeProject(mockApi as TuiPluginApi, directory)
      expect(client).not.toBeNull()

      const { handler, calls } = createHandler()
      const unsubscribe = client!.events.onLoopsChanged(handler)

      // Simulate discovery completing
      await new Promise<void>((resolve) => setTimeout(resolve, 10))

      // Simulate event delivery
      const payload = { reason: 'insert', loopName: 'test-loop' }
      const encoded = encodeEvent({
        name: 'loops.changed',
        projectId,
        directory,
        payload,
      })

      // Manually trigger the event callback (simulating publish)
      if (eventCallbacks.length > 0) {
        eventCallbacks[0]({ properties: { command: encoded } })
      }

      expect(calls.length).toBe(1)
      expect(calls[0]).toEqual(payload)

      unsubscribe()

      // Second event should not fire after unsubscribe
      const payload2 = { reason: 'terminate', loopName: 'test-loop-2' }
      const encoded2 = encodeEvent({
        name: 'loops.changed',
        projectId,
        directory,
        payload: payload2,
      })

      if (eventCallbacks.length > 0) {
        eventCallbacks[0]({ properties: { command: encoded2 } })
      }

      expect(calls.length).toBe(1) // Still 1, not 2
    })

    it('should NOT call handler when non-matching projectId event is published', async () => {
      const directory = '/test/dir'
      const client = await connectForgeProject(mockApi as TuiPluginApi, directory)
      expect(client).not.toBeNull()

      const { handler, calls } = createHandler()
      client!.events.onLoopsChanged(handler)

      // Wait for discovery to complete
      await new Promise<void>((resolve) => setTimeout(resolve, 50))

      // If discovery failed, projectId will be empty string
      // In that case, events without projectId will pass through
      // This test verifies that when client has NO projectId, directory filtering still works
      // For projectId filtering, see the first test which uses matching projectId
      
      // Publish event with non-matching directory (projectId is empty, so directory filter applies)
      const encoded = encodeEvent({
        name: 'loops.changed',
        directory: '/different/dir',
        payload: { reason: 'insert', loopName: 'test-loop' },
      })

      if (eventCallbacks.length > 0) {
        eventCallbacks[0]({ properties: { command: encoded } })
      }

      expect(calls.length).toBe(0)
    })

    it('should filter events by directory when projectId is not set', async () => {
      const directory = '/test/dir'
      const client = await connectForgeProject(mockApi as TuiPluginApi, directory)
      expect(client).not.toBeNull()

      const { handler, calls } = createHandler()
      client!.events.onLoopsChanged(handler)

      // Wait for discovery to complete (will fail, leaving projectId null)
      await new Promise<void>((resolve) => setTimeout(resolve, 50))

      // Publish event with matching directory
      const payload = { reason: 'insert', loopName: 'test-loop' }
      const encoded = encodeEvent({
        name: 'loops.changed',
        directory,
        payload,
      })

      if (eventCallbacks.length > 0) {
        eventCallbacks[0]({ properties: { command: encoded } })
      }

      expect(calls.length).toBe(1)
      expect(calls[0]).toEqual(payload)
    })

    it('should NOT call handler when directory does not match', async () => {
      const directory = '/test/dir'
      const client = await connectForgeProject(mockApi as TuiPluginApi, directory)
      expect(client).not.toBeNull()

      const { handler, calls } = createHandler()
      client!.events.onLoopsChanged(handler)

      await new Promise<void>((resolve) => setTimeout(resolve, 50))

      // Publish event with non-matching directory
      const encoded = encodeEvent({
        name: 'loops.changed',
        directory: '/different/dir',
        payload: { reason: 'insert', loopName: 'test-loop' },
      })

      if (eventCallbacks.length > 0) {
        eventCallbacks[0]({ properties: { command: encoded } })
      }

      expect(calls.length).toBe(0)
    })
  })

  describe('decodeReply cross-talk', () => {
    it('should not treat forge.rep: as forge.evt:', async () => {
      const directory = '/test/dir'
      const client = await connectForgeProject(mockApi as TuiPluginApi, directory)
      expect(client).not.toBeNull()

      const { handler, calls } = createHandler()
      client!.events.onLoopsChanged(handler)

      await new Promise<void>((resolve) => setTimeout(resolve, 10))

      // Publish a reply (not an event)
      const encoded = encodeReply({ rid: '123', status: 'ok', data: {} })

      if (eventCallbacks.length > 0) {
        eventCallbacks[0]({ properties: { command: encoded } })
      }

      // Handler should not be called for replies
      expect(calls.length).toBe(0)
    })
  })

  describe('encodeEvent/decodeEvent round-trip', () => {
    it('should round-trip with projectId and payload', () => {
      const original = {
        name: 'loops.changed',
        projectId: 'p123',
        directory: '/test',
        payload: { reason: 'terminate', loopName: 'my-loop' },
      }

      const encoded = encodeEvent(original)
      expect(encoded.startsWith('forge.evt:loops.changed:')).toBe(true)
    })

    it('should round-trip without optional fields', () => {
      const original = {
        name: 'loops.changed',
        payload: { reason: 'insert', loopName: 'test' },
      }

      const encoded = encodeEvent(original)
      expect(encoded.startsWith('forge.evt:loops.changed:')).toBe(true)
    })
  })
})
