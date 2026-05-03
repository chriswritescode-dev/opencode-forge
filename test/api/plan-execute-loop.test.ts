import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test'
import { encodeEvent, decodeEvent, encodeReply, decodeReply, encodeRequest, decodeRequest } from '../../src/api/bus-protocol'
import { connectForgeProject } from '../../src/utils/tui-client'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'

describe('plan-execute-loop end-to-end race', () => {
  function createMockApiWithEventSupport() {
    let capturedHandler: ((event: any) => void) | undefined
    let publishCallCount = 0
    let publishedPayloads: any[] = []
    const publishMock = vi.fn().mockImplementation(async (payload: any) => {
      publishCallCount++
      publishedPayloads.push(payload)
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
      getPublishedPayloads: () => publishedPayloads,
      publishMock,
    }
  }

  async function waitForPublishs(mock: { getPublishCount: () => number }, count: number): Promise<void> {
    while (mock.getPublishCount() < count) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  async function replyToLastRequest(
    mock: { getHandler: () => ((event: any) => void) | undefined; getPublishedPayloads: () => any[] },
    replyData: any
  ): Promise<void> {
    const handler = mock.getHandler()
    const payloads = mock.getPublishedPayloads()
    if (handler && payloads.length > 0) {
      const lastPayload = payloads[payloads.length - 1]
      const decoded = decodeRequest(lastPayload.body.properties.command as string)
      if (decoded) {
        handler!({
          properties: {
            command: encodeReply({
              rid: decoded.rid,
              status: 'ok',
              data: replyData,
            }),
          },
        })
      }
    }
  }

  describe('event-first: server emits loop.started before reply', () => {
    it('resolves with loop info before 60s timeout when event arrives at 5ms', async () => {
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

      // Start the execute call - this will publish the request
      const executePromise = client!.plan.execute('s1', {
        mode: 'loop-worktree',
        plan: 'test plan',
        title: 'test title',
        executionModel: 'test-model',
      }, { mode: 'Loop (worktree)' })

      // Wait for the execute publish
      await waitForPublishs({ getPublishCount: () => publishMock.mock.calls.length }, 2)

      // Get the rid from the published request
      const executePayloads = publishMock.mock.calls.map(c => c[0])
      const executePayload = executePayloads[executePayloads.length - 1]
      const executeReq = decodeRequest(executePayload.body.properties.command as string)
      expect(executeReq).toBeTruthy()
      const requestRid = executeReq!.rid

      // Simulate server emitting loop.started event at 5ms
      vi.advanceTimersByTime(5)
      
      if (getHandler()) {
        getHandler()!({
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
      expect(result?.workspaceId).toBe(eventData.workspaceId)
      
      vi.useRealTimers()
    })
  })

  describe('reply-fallback: server only sends reply (no event)', () => {
    it('resolves with reply payload for backward compatibility', async () => {
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
      await waitForPublishs({ getPublishCount: () => publishMock.mock.calls.length }, 2)

      // Get the rid from the published request
      const executePayloads = publishMock.mock.calls.map(c => c[0])
      const executePayload = executePayloads[executePayloads.length - 1]
      const executeReq = decodeRequest(executePayload.body.properties.command as string)
      expect(executeReq).toBeTruthy()
      const requestRid = executeReq!.rid

      // Simulate server sending ONLY the reply (no event) - backward compatible path
      vi.advanceTimersByTime(100)
      
      if (getHandler()) {
        getHandler()!({
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
      
      vi.useRealTimers()
    })
  })

  describe('timeout path: neither event nor reply arrives', () => {
    it('returns null after 60s timeout and logs structured diagnostic', async () => {
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
