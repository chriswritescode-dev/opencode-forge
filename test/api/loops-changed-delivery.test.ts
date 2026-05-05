import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test'
import { encodeEvent, decodeEvent, encodeRequest, decodeRequest, encodeReply, decodeReply } from '../../src/api/bus-protocol'
import { connectForgeProject } from '../../src/utils/tui-client'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import * as fs from 'node:fs'

describe('loops.changed event delivery', () => {
  let eventCallbacks: Array<(event: { properties?: { command?: string } }) => void>
  let publishedEvents: Array<{ directory?: string; body: { type: string; properties: { command: string } } }>
  let appendFileSyncSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    eventCallbacks = []
    publishedEvents = []
    appendFileSyncSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {})
  })

  afterEach(() => {
    appendFileSyncSpy.mockRestore()
  })

  function createMockApiWithEventSupport() {
    const publishMock = vi.fn().mockImplementation(async (payload: any) => {
      publishedEvents.push(payload)
      return Promise.resolve()
    })

    const mockApi = {
      client: {
        tui: {
          publish: publishMock,
        },
      },
      event: {
        on: vi.fn().mockImplementation((_event: string, handler: any) => {
          eventCallbacks.push(handler)
        }),
      },
    } as unknown as TuiPluginApi

    return {
      mockApi,
      getHandler: (index = 0) => eventCallbacks[index],
      getPublishCount: () => publishedEvents.length,
      getLastPayload: () => publishedEvents[publishedEvents.length - 1],
      publishMock,
    }
  }

  async function connectAndDiscover(mockApi: TuiPluginApi, directory: string, projectId: string) {
    const clientPromise = connectForgeProject(mockApi, directory)

    while (publishedEvents.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    const decoded = decodeRequest(publishedEvents[publishedEvents.length - 1].body.properties.command)
    if (decoded?.verb === 'projects.list') {
      eventCallbacks[0]({
        properties: {
          command: encodeReply({
            rid: decoded.rid,
            status: 'ok',
            data: { projects: [{ id: projectId, directory }] },
          }),
        },
      })
    }

    const client = await clientPromise
    expect(client).not.toBeNull()
    return client!
  }

  it('notifyLoopChange with projectDir hint publishes event with projectId and directory === projectDir', async () => {
    const { mockApi, getHandler } = createMockApiWithEventSupport()
    const directory = '/test/dir'
    const projectId = 'test-project'
    const projectDir = '/project/dir'

    const client = await connectAndDiscover(mockApi, directory, projectId)

    const loopChanges: Array<{ reason: string; loopName: string }> = []
    client.events.onLoopsChanged((payload) => {
      loopChanges.push(payload)
    })

    // Simulate server sending loops.changed with projectDir hint
    const payload = { reason: 'phase', loopName: 'test-loop' }
    const encoded = encodeEvent({
      name: 'loops.changed',
      projectId,
      directory: projectDir,
      payload,
    })

    getHandler()({ properties: { command: encoded } })

    expect(loopChanges).toEqual([payload])
  })

  it('notifyLoopChange without hint falls back to plugin instance directory', async () => {
    const { mockApi, getHandler } = createMockApiWithEventSupport()
    const directory = '/test/dir'
    const projectId = 'test-project'

    const client = await connectAndDiscover(mockApi, directory, projectId)

    const loopChanges: Array<{ reason: string; loopName: string }> = []
    client.events.onLoopsChanged((payload) => {
      loopChanges.push(payload)
    })

    // Simulate server sending loops.changed with instance directory (no hint)
    const payload = { reason: 'iteration', loopName: 'test-loop' }
    const encoded = encodeEvent({
      name: 'loops.changed',
      projectId,
      directory,
      payload,
    })

    getHandler()({ properties: { command: encoded } })

    expect(loopChanges).toEqual([payload])
  })

  it('TUI client accepts event with matching directory even when projectId differs', async () => {
    const { mockApi, getHandler } = createMockApiWithEventSupport()
    const directory = '/test/dir'
    const projectId = 'test-project'
    const differentProjectId = 'different-project'

    const client = await connectAndDiscover(mockApi, directory, projectId)

    const loopChanges: Array<{ reason: string; loopName: string }> = []
    client.events.onLoopsChanged((payload) => {
      loopChanges.push(payload)
    })

    // Simulate event with different projectId but matching directory
    const payload = { reason: 'terminate', loopName: 'test-loop' }
    const encoded = encodeEvent({
      name: 'loops.changed',
      projectId: differentProjectId,
      directory,
      payload,
    })

    getHandler()({ properties: { command: encoded } })

    // Should accept because directory matches
    expect(loopChanges).toEqual([payload])
  })

  it('TUI client rejects event when both projectId and directory differ', async () => {
    const { mockApi, getHandler } = createMockApiWithEventSupport()
    const directory = '/test/dir'
    const projectId = 'test-project'
    const differentProjectId = 'different-project'
    const differentDirectory = '/different/dir'

    const client = await connectAndDiscover(mockApi, directory, projectId)

    const loopChanges: Array<{ reason: string; loopName: string }> = []
    client.events.onLoopsChanged((payload) => {
      loopChanges.push(payload)
    })

    // Simulate event with both different projectId and directory
    const payload = { reason: 'error', loopName: 'test-loop' }
    const encoded = encodeEvent({
      name: 'loops.changed',
      projectId: differentProjectId,
      directory: differentDirectory,
      payload,
    })

    getHandler()({ properties: { command: encoded } })

    // Should reject because neither projectId nor directory matches
    expect(loopChanges).toEqual([])
    // Verify the event dropped debug line was recorded
    expect(appendFileSyncSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('event dropped'),
      expect.any(String),
    )
  })

  it('TUI client accepts event with no scoping info (projectId and directory both absent)', async () => {
    const { mockApi, getHandler } = createMockApiWithEventSupport()
    const directory = '/test/dir'
    const projectId = 'test-project'

    const client = await connectAndDiscover(mockApi, directory, projectId)

    const loopChanges: Array<{ reason: string; loopName: string }> = []
    client.events.onLoopsChanged((payload) => {
      loopChanges.push(payload)
    })

    // Simulate event with no scoping info
    const payload = { reason: 'status', loopName: 'test-loop' }
    const encoded = encodeEvent({
      name: 'loops.changed',
      payload,
    })

    getHandler()({ properties: { command: encoded } })

    // Should accept because event has no scoping info
    expect(loopChanges).toEqual([payload])
  })
})
