import { describe, it, expect, vi, beforeEach } from 'bun:test'
import { encodeRequest, decodeReply, newRid, decodeRequest, encodeReply, encodeEvent, decodeEvent } from '../../src/api/bus-protocol'
import { connectForgeProject } from '../../src/utils/tui-client'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'

async function waitForPublishs(mock: { getPublishCount: () => number }, count: number): Promise<void> {
  while (mock.getPublishCount() < count) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('tui-client bus-RPC integration', () => {
  describe('protocol helpers', () => {
    it('encodes and decodes requests correctly', () => {
      const req = {
        verb: 'plan.read.session',
        rid: 'test123',
        projectId: 'proj1',
        directory: '/test',
        params: { sessionId: 's1' },
        body: undefined,
      }
      const encoded = encodeRequest(req)
      expect(encoded).toContain('forge.req:plan.read.session:test123:')
      
      const decoded = decodeRequest(encoded)
      expect(decoded).toEqual(req)
    })

    it('encodes ok replies correctly', () => {
      const reply = {
        rid: 'test123',
        status: 'ok' as const,
        data: { content: 'plan content' },
      }
      const encoded = encodeReply(reply)
      const decoded = decodeReply(encoded)
      expect(decoded).toEqual(reply)
    })

    it('encodes err replies correctly', () => {
      const reply = {
        rid: 'test123',
        status: 'err' as const,
        code: 'not_found',
        message: 'plan not found',
      }
      const encoded = encodeReply(reply)
      const decoded = decodeReply(encoded)
      expect(decoded).toEqual(reply)
    })

    it('generates unique rids', () => {
      const rid1 = newRid()
      const rid2 = newRid()
      expect(rid1).not.toBe(rid2)
      expect(rid1.length).toBe(8)
    })

    it('returns null for non-forge command', () => {
      expect(decodeRequest('unknown.verb')).toBeNull()
    })

    it('returns null for malformed base64', () => {
      expect(decodeRequest('forge.req:plan.read:abc123:!!!invalid!!!')).toBeNull()
    })
  })

  describe('connectForgeProject', () => {
    it('resolves projectId via projects.list RPC', async () => {
      let capturedHandler: ((event: any) => void) | undefined
      let publishCallCount = 0
      let lastPublishedPayload: any = null
      
      const mockApi = {
        client: {
          worktree: {
            create: vi.fn().mockResolvedValue({
              data: { directory: '/tmp/worktree', branch: 'test-loop' },
              error: undefined,
            }),
          },
          session: {
            create: vi.fn().mockResolvedValue({
              data: { id: 's1' },
              error: undefined,
            }),
            promptAsync: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
          },
          tui: {
            publish: vi.fn().mockImplementation(async (payload: any) => {
              publishCallCount++
              lastPublishedPayload = payload
              return Promise.resolve()
            }),
          },
        },
        event: {
          on: vi.fn().mockImplementation((_event: string, handler: any) => {
            capturedHandler = handler
          }),
        },
      } as unknown as TuiPluginApi

      // Start the connection
      const clientPromise = connectForgeProject(mockApi, '/test')
      
      // Wait for publish to be called
      while (publishCallCount === 0) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      
      // Trigger the reply for projects.list
      const decoded = decodeRequest(lastPublishedPayload.body.properties.command as string)
      if (capturedHandler && decoded && decoded.verb === 'projects.list') {
        capturedHandler({
          properties: {
            command: encodeReply({
              rid: decoded.rid,
              status: 'ok',
              data: { projects: [{ id: 'proj1', directory: '/test' }] },
            }),
          },
        })
      }

      const client = await clientPromise
      expect(client).not.toBeNull()
      expect(client?.projectId).toBe('proj1')
    })

    it('continues with cwd routing when discovery fails after all retries', async () => {
      const mockApi = {
        client: {
          worktree: {
            create: vi.fn().mockResolvedValue({
              data: { directory: '/tmp/worktree', branch: 'test-loop' },
              error: undefined,
            }),
          },
          session: {
            create: vi.fn().mockResolvedValue({
              data: { id: 's1' },
              error: undefined,
            }),
            promptAsync: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
          },
          tui: {
            publish: vi.fn().mockResolvedValue(undefined),
          },
        },
        event: {
          on: vi.fn(),
        },
      } as unknown as TuiPluginApi

      const client = await connectForgeProject(mockApi, '/test')
      expect(client).not.toBeNull()
      expect(client?.projectId).toBe('')
    }, 30000)

    it('publishes encoded request and resolves with reply data', async () => {
      let capturedHandler: ((event: any) => void) | undefined
      let publishCallCount = 0
      let lastPublishedPayload: any = null
      let replyMode: 'projects' | 'plan' = 'projects'
      let planContent = 'test plan content'
      
      const mockApi = {
        client: {
          worktree: {
            create: vi.fn().mockResolvedValue({
              data: { directory: '/tmp/worktree', branch: 'test-loop' },
              error: undefined,
            }),
          },
          session: {
            create: vi.fn().mockResolvedValue({
              data: { id: 's1' },
              error: undefined,
            }),
            promptAsync: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
          },
          tui: {
            publish: vi.fn().mockImplementation(async (payload: any) => {
              publishCallCount++
              lastPublishedPayload = payload
              return Promise.resolve()
            }),
          },
        },
        event: {
          on: vi.fn().mockImplementation((_event: string, handler: any) => {
            capturedHandler = handler
          }),
        },
      } as unknown as TuiPluginApi

      // Start connection - will trigger projects.list
      const clientPromise = connectForgeProject(mockApi, '/test')
      
      // Wait for first publish
      while (publishCallCount === 0) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      
      // Reply to projects.list
      if (capturedHandler && lastPublishedPayload) {
        const decoded = decodeRequest(lastPublishedPayload.body.properties.command as string)
        if (decoded && decoded.verb === 'projects.list') {
          capturedHandler({
            properties: {
              command: encodeReply({
                rid: decoded.rid,
                status: 'ok',
                data: { projects: [{ id: 'proj1', directory: '/test' }] },
              }),
            },
          })
        }
      }
      
      const client = await clientPromise
      expect(client).not.toBeNull()
      
      // Now trigger plan.read
      const planPromise = client!.plan.read('s1')
      
      // Wait for second publish
      while (publishCallCount < 2) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      
      // Reply to plan.read.session
      if (capturedHandler && lastPublishedPayload) {
        const decoded = decodeRequest(lastPublishedPayload.body.properties.command as string)
        if (decoded && decoded.verb === 'plan.read.session') {
          capturedHandler({
            properties: {
              command: encodeReply({
                rid: decoded.rid,
                status: 'ok',
                data: { sessionId: 's1', content: planContent },
              }),
            },
          })
        }
      }
      
      const result = await planPromise
      expect(result).toBe(planContent)
    })



    it('plan.read swallows errors and returns null', async () => {
      let capturedHandler: ((event: any) => void) | undefined
      let publishCallCount = 0
      let lastPublishedPayload: any = null
      
      const mockApi = {
        client: {
          tui: {
            publish: vi.fn().mockImplementation(async (payload: any) => {
              publishCallCount++
              lastPublishedPayload = payload
              return Promise.resolve()
            }),
          },
        },
        event: {
          on: vi.fn().mockImplementation((_event: string, handler: any) => {
            capturedHandler = handler
          }),
        },
      } as unknown as TuiPluginApi

      // Start connection - will trigger projects.list
      const clientPromise = connectForgeProject(mockApi, '/test')
      
      // Wait for first publish
      while (publishCallCount === 0) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      
      // Reply to projects.list
      if (capturedHandler && lastPublishedPayload) {
        const decoded = decodeRequest(lastPublishedPayload.body.properties.command as string)
        if (decoded && decoded.verb === 'projects.list') {
          capturedHandler({
            properties: {
              command: encodeReply({
                rid: decoded.rid,
                status: 'ok',
                data: { projects: [{ id: 'proj1', directory: '/test' }] },
              }),
            },
          })
        }
      }
      
      const client = await clientPromise
      expect(client).not.toBeNull()
      
      // Now trigger plan.read
      const planPromise = client!.plan.read('s1')
      
      // Wait for second publish
      while (publishCallCount < 2) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      
      // Reply with error
      if (capturedHandler && lastPublishedPayload) {
        const decoded = decodeRequest(lastPublishedPayload.body.properties.command as string)
        if (decoded && decoded.verb === 'plan.read.session') {
          capturedHandler({
            properties: {
              command: encodeReply({
                rid: decoded.rid,
                status: 'err',
                code: 'not_found',
                message: 'plan not found',
              }),
            },
          })
        }
      }
      
      const result = await planPromise
      expect(result).toBeNull()
    })

    it('loops.start returns expected result', async () => {
      let capturedHandler: ((event: any) => void) | undefined
      let publishCallCount = 0
      let lastPublishedPayload: any = null
      const sessionId = `s-${Date.now()}`
      const workspaceId = 'ws-123'
      
      const mockApi = {
        client: {
          tui: {
            publish: vi.fn().mockImplementation(async (payload: any) => {
              publishCallCount++
              lastPublishedPayload = payload
              return Promise.resolve()
            }),
          },
        },
        event: {
          on: vi.fn().mockImplementation((_event: string, handler: any) => {
            capturedHandler = handler
          }),
        },
      } as unknown as TuiPluginApi

      // Start connection - will trigger projects.list
      const clientPromise = connectForgeProject(mockApi, '/test')
      
      // Wait for first publish
      while (publishCallCount === 0) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      
      // Reply to projects.list
      if (capturedHandler && lastPublishedPayload) {
        const decoded = decodeRequest(lastPublishedPayload.body.properties.command as string)
        if (decoded && decoded.verb === 'projects.list') {
          capturedHandler({
            properties: {
              command: encodeReply({
                rid: decoded.rid,
                status: 'ok',
                data: { projects: [{ id: 'proj1', directory: '/test' }] },
              }),
            },
          })
        }
      }
      
      const client = await clientPromise
      expect(client).not.toBeNull()
      
      // Now trigger loops.start - it should publish to the bus
      const loopsPromise = client!.loops.start({
        plan: 'test plan',
        title: 'test title',
        worktree: true,
      })
      
      // Wait for loops.start publish
      while (publishCallCount < 2) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      
      // Reply to loops.start
      if (capturedHandler && lastPublishedPayload) {
        const decoded = decodeRequest(lastPublishedPayload.body.properties.command as string)
        if (decoded && decoded.verb === 'loops.start') {
          capturedHandler({
            properties: {
              command: encodeReply({
                rid: decoded.rid,
                status: 'ok',
                data: {
                  sessionId,
                  loopName: 'test plan',
                  worktreeDir: '/tmp/worktree',
                  workspaceId,
                },
              }),
            },
          })
        }
      }
      
      const result = await loopsPromise
      expect(result).toEqual({ sessionId, loopName: 'test plan', worktreeDir: '/tmp/worktree', workspaceId })
    })

    it('returns null when RPC call times out after 5000ms (plan.read swallows errors)', async () => {
      let capturedHandler: ((event: any) => void) | undefined
      let publishCallCount = 0
      let lastPublishedPayload: any = null
      
      const mockApi = {
        client: {
          tui: {
            publish: vi.fn().mockImplementation(async (payload: any) => {
              publishCallCount++
              lastPublishedPayload = payload
              return Promise.resolve()
            }),
          },
        },
        event: {
          on: vi.fn().mockImplementation((_event: string, handler: any) => {
            capturedHandler = handler
          }),
        },
      } as unknown as TuiPluginApi

      // Start connection - will trigger projects.list
      const clientPromise = connectForgeProject(mockApi, '/test')
      
      // Wait for first publish
      while (publishCallCount === 0) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      
      // Reply to projects.list to complete connection
      if (capturedHandler && lastPublishedPayload) {
        const decoded = decodeRequest(lastPublishedPayload.body.properties.command as string)
        if (decoded && decoded.verb === 'projects.list') {
          capturedHandler({
            properties: {
              command: encodeReply({
                rid: decoded.rid,
                status: 'ok',
                data: { projects: [{ id: 'proj1', directory: '/test' }] },
              }),
            },
          })
        }
      }
      
      const client = await clientPromise
      expect(client).not.toBeNull()
      
      // Reset publish tracking for the next RPC call
      publishCallCount = 0
      lastPublishedPayload = null
      
      // Now make an RPC call that will timeout
      // plan.read swallows errors and returns null on timeout
      const startTime = Date.now()
      const result = await client!.plan.read('session-without-local-plan')
      const elapsed = Date.now() - startTime
      
      expect(result).toBeNull()
      // Verify it took at least 5 seconds (the timeout)
      expect(elapsed).toBeGreaterThanOrEqual(4900)
    }, 10000)
  })

  describe('loop.started event race', () => {
    function createMockApiWithEventSupport() {
      let capturedHandler: ((event: any) => void) | undefined
      let publishCallCount = 0
      let lastPublishedPayload: any = null
      const publishMock = vi.fn().mockImplementation(async (payload: any) => {
        publishCallCount++
        lastPublishedPayload = payload
        return Promise.resolve()
      })

      const mockApi = {
        client: {
          worktree: {
            create: vi.fn().mockResolvedValue({
              data: { directory: '/tmp/worktree', branch: 'test-loop' },
              error: undefined,
            }),
          },
          session: {
            create: vi.fn().mockResolvedValue({
              data: { id: 's1' },
              error: undefined,
            }),
            promptAsync: vi.fn().mockResolvedValue({ data: {}, error: undefined }),
          },
          tui: {
            publish: publishMock,
          },
        },
        event: {
          on: vi.fn().mockImplementation((_event: string, handler: any) => {
            capturedHandler = handler
          }),
        },
      } as unknown as TuiPluginApi

      return {
        mockApi,
        getHandler: () => capturedHandler,
        getPublishCount: () => publishCallCount,
        getLastPayload: () => lastPublishedPayload,
        publishMock,
      }
    }

    it('event-first: server emits loop.started before reply, TUI resolves with event payload', async () => {
      const { mockApi, getHandler, getPublishCount, publishMock } = createMockApiWithEventSupport()

      // Start connection
      const clientPromise = connectForgeProject(mockApi, '/test')

      // Wait for projects.list publish
      while (getPublishCount() === 0) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }

      // Reply to projects.list
      const handler = getHandler()
      if (handler && publishMock.mock.calls.length > 0) {
        const lastPayload = publishMock.mock.calls[publishMock.mock.calls.length - 1][0]
        const decoded = decodeRequest(lastPayload.body.properties.command as string)
        if (decoded && decoded.verb === 'projects.list') {
          handler({
            properties: {
              command: encodeReply({
                rid: decoded.rid,
                status: 'ok',
                data: { projects: [{ id: 'proj1', directory: '/test' }] },
              }),
            },
          })
        }
      }

      const client = await clientPromise
      expect(client).not.toBeNull()
      expect(client?.projectId).toBe('proj1')

      // Now test plan.execute with loop-worktree mode
      const eventData = {
        sessionId: 'session-event-first',
        loopName: 'test-loop-event',
        displayName: 'Test Loop Event',
        worktreeDir: '/tmp/worktree-event',
        workspaceId: 'ws-event',
        mode: 'loop-worktree' as const,
      }

      const executePromise = client!.plan.execute('s1', {
        mode: 'loop-worktree',
        plan: 'test plan',
        title: 'test title',
        executionModel: 'test-model',
      }, { mode: 'Loop (worktree)' })

      // Wait for the execute publish
      while (getPublishCount() < 2) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }

      // Get the rid from the published request
      const executePayload = publishMock.mock.calls[publishMock.mock.calls.length - 1][0]
      const executeReq = decodeRequest(executePayload.body.properties.command as string)
      expect(executeReq).toBeTruthy()
      const requestRid = executeReq!.rid

      // Simulate server emitting loop.started event FIRST (before reply)
      if (handler) {
        handler({
          properties: {
            command: encodeEvent({
              rid: requestRid,
              name: 'loop.started',
              data: eventData,
            }),
          },
        })
      }

      // Should resolve immediately with event data, not timeout
      const result = await executePromise
      expect(result).toBeTruthy()
      expect(result?.sessionId).toBe(eventData.sessionId)
      expect(result?.loopName).toBe(eventData.loopName)
      expect(result?.worktreeDir).toBe(eventData.worktreeDir)
    })

    it('reply-fallback: server only sends reply (no event), TUI resolves with reply payload', async () => {
      const { mockApi, getHandler, getPublishCount, publishMock } = createMockApiWithEventSupport()

      // Start connection
      const clientPromise = connectForgeProject(mockApi, '/test')

      // Wait for projects.list publish
      while (getPublishCount() === 0) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }

      // Reply to projects.list
      const handler = getHandler()
      if (handler && publishMock.mock.calls.length > 0) {
        const lastPayload = publishMock.mock.calls[publishMock.mock.calls.length - 1][0]
        const decoded = decodeRequest(lastPayload.body.properties.command as string)
        if (decoded && decoded.verb === 'projects.list') {
          handler({
            properties: {
              command: encodeReply({
                rid: decoded.rid,
                status: 'ok',
                data: { projects: [{ id: 'proj1', directory: '/test' }] },
              }),
            },
          })
        }
      }

      const client = await clientPromise
      expect(client).not.toBeNull()

      // Now test plan.execute - only reply, no event
      const replyData = {
        sessionId: 'session-reply-only',
        loopName: 'test-loop-reply',
        displayName: 'Test Loop Reply',
        worktreeDir: '/tmp/worktree-reply',
        workspaceId: 'ws-reply',
        mode: 'loop-worktree' as const,
      }

      const executePromise = client!.plan.execute('s1', {
        mode: 'loop-worktree',
        plan: 'test plan',
        title: 'test title',
        executionModel: 'test-model',
      }, { mode: 'Loop (worktree)' })

      // Wait for the execute publish
      while (getPublishCount() < 2) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }

      // Get the rid from the published request
      const executePayload = publishMock.mock.calls[publishMock.mock.calls.length - 1][0]
      const executeReq = decodeRequest(executePayload.body.properties.command as string)
      expect(executeReq).toBeTruthy()
      const requestRid = executeReq!.rid

      // Simulate server sending ONLY the reply (no event) - backward compatible path
      if (handler) {
        handler({
          properties: {
            command: encodeReply({
              rid: requestRid,
              status: 'ok',
              data: replyData,
            }),
          },
        })
      }

      const result = await executePromise
      expect(result).toBeTruthy()
      expect(result?.sessionId).toBe(replyData.sessionId)
      expect(result?.loopName).toBe(replyData.loopName)
    })

    it('timeout: returns null after 60s and the catch block logs structured diagnostic', async () => {
      vi.useFakeTimers()
      
      const { mockApi, getHandler, publishMock } = createMockApiWithEventSupport()

      // Start connection
      const clientPromise = connectForgeProject(mockApi, '/test')
      await waitForPublishs({ getPublishCount: () => publishMock.mock.calls.length }, 1)

      // Reply to projects.list
      const payloads = publishMock.mock.calls.map(c => c[0])
      const lastPayload = payloads[payloads.length - 1]
      const decoded = decodeRequest(lastPayload.body.properties.command as string)
      if (decoded && decoded.verb === 'projects.list') {
        getHandler()!({
          properties: {
            command: encodeReply({
              rid: decoded.rid,
              status: 'ok',
              data: { projects: [{ id: 'proj1', directory: '/test' }] },
            }),
          },
        })
      }

      const client = await clientPromise
      expect(client).not.toBeNull()

      // Capture the log file content before the test
      const { readFileSync } = await import('fs')
      const { homedir } = await import('os')
      const { join } = await import('path')
      const logPath = join(homedir(), '.local', 'share', 'opencode', 'forge', 'logs', 'forge.log')
      let logBefore = ''
      try {
        logBefore = readFileSync(logPath, 'utf-8')
      } catch {
        // Log file may not exist yet
      }

      // Now test plan.execute - no event, no reply (timeout scenario)
      const executePromise = client!.plan.execute('s1', {
        mode: 'loop-worktree',
        plan: 'test plan',
        title: 'test title',
        executionModel: 'test-model',
      }, { mode: 'Loop (worktree)' })

      // Wait for the execute publish
      await waitForPublishs({ getPublishCount: () => publishMock.mock.calls.length }, 2)

      // Do NOT send any response - simulate timeout
      // Advance time to 60s (the loop timeout)
      vi.advanceTimersByTime(60000)

      // Should resolve with null after timeout
      const result = await executePromise
      expect(result).toBeNull()
      
      // Verify the log file contains the structured diagnostic
      const logAfter = readFileSync(logPath, 'utf-8')
      const newLogs = logAfter.slice(logBefore.length)
      expect(newLogs).toContain('plan.execute loop catch kind=timeout')
      
      vi.useRealTimers()
    })
  })
})
