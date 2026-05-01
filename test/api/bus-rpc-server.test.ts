import { describe, it, expect, vi, beforeEach } from 'bun:test'
import { createBusRpcEventHook } from '../../src/api/bus-rpc'
import { decodeReply, encodeRequest } from '../../src/api/bus-protocol'
import type { ToolContext } from '../../src/tools/types'
import type { Logger } from '../../src/types'
import type { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2'
import type { ProjectRegistry } from '../../src/api/project-registry'

// Mock bun:sqlite for vitest compatibility
vi.mock('bun:sqlite', () => ({
  Database: vi.fn(),
}))

function createMockV2() {
  return {
    tui: {
      publish: vi.fn().mockResolvedValue(undefined),
    },
    session: {
      get: vi.fn(),
    },
  } as unknown as ReturnType<typeof createV2Client>
}

function waitForDeferredPublish(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function createMockLogger(): Logger {
  return {
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

function createMockRegistry(): ProjectRegistry {
  const entries = new Map<string, ToolContext>()
  
  return {
    register(ctx: ToolContext) {
      entries.set(ctx.projectId, ctx)
    },
    unregister(projectId: string) {
      entries.delete(projectId)
    },
    get(projectId: string): ToolContext | null {
      return entries.get(projectId) ?? null
    },
    findByDirectory(directory: string): ToolContext | null {
      for (const ctx of entries.values()) {
        if (ctx.directory === directory) {
          return ctx
        }
      }
      return null
    },
    list(): ToolContext[] {
      return Array.from(entries.values())
    },
    size(): number {
      return entries.size
    },
  }
}

function createMockToolContext(projectId: string, directory: string): ToolContext {
  return {
    projectId,
    directory,
    config: {} as any,
    logger: createMockLogger(),
    db: {} as any,
    dataDir: '/tmp',
    loopService: {} as any,
    loopHandler: {} as any,
    v2: createMockV2(),
    cleanup: vi.fn(),
    input: {} as any,
    sandboxManager: null,
    graphService: null,
    plansRepo: {
      getForSession: vi.fn(),
      getForLoop: vi.fn(),
      writeForSession: vi.fn(),
      writeForLoop: vi.fn(),
      deleteForSession: vi.fn(),
      deleteForLoop: vi.fn(),
    } as any,
    reviewFindingsRepo: {} as any,
    graphStatusRepo: {} as any,
    loopsRepo: {} as any,
  }
}

describe('bus-rpc server', () => {
  let v2: ReturnType<typeof createV2Client>
  let logger: Logger
  let registry: ProjectRegistry

  beforeEach(() => {
    v2 = createMockV2()
    logger = createMockLogger()
    registry = createMockRegistry()
  })

  it('routes plan.read.session to handler and publishes ok reply', async () => {
    const ctx = createMockToolContext('proj1', '/test')
    registry.register(ctx)

    vi.spyOn(ctx.plansRepo, 'getForSession').mockReturnValue({
      sessionId: 's1',
      loopName: null,
      content: 'plan content',
      updatedAt: 123,
    } as any)

    const hook = createBusRpcEventHook({ registry, logger, v2, instanceDirectory: '/test' })

    const req = {
      verb: 'plan.read.session',
      rid: 'test123',
      projectId: 'proj1',
      params: { sessionId: 's1' },
      body: undefined,
    }

    await hook({
      event: {
        type: 'tui.command.execute',
        properties: {
          command: encodeRequest(req),
        },
      },
    })
    await waitForDeferredPublish()

    expect(v2.tui.publish).toHaveBeenCalledTimes(1)
    const call = (v2.tui.publish as any).mock.calls[0][0]
    expect(call.body.properties.command).toContain('forge.rep:test123:ok:')
  })

  it('ignores events with unknown projectId', async () => {
    const ctx = createMockToolContext('proj1', '/test')
    registry.register(ctx)

    const hook = createBusRpcEventHook({ registry, logger, v2, instanceDirectory: '/test' })

    const req = {
      verb: 'plan.read.session',
      rid: 'test456',
      projectId: 'unknown',
      params: { sessionId: 's1' },
      body: undefined,
    }

    await hook({
      event: {
        type: 'tui.command.execute',
        properties: {
          command: encodeRequest(req),
        },
      },
    })

    expect(v2.tui.publish).not.toHaveBeenCalled()
  })

  it('returns err reply on not_found error', async () => {
    const ctx = createMockToolContext('proj1', '/test')
    registry.register(ctx)

    vi.spyOn(ctx.plansRepo, 'getForSession').mockReturnValue(null as any)

    const hook = createBusRpcEventHook({ registry, logger, v2, instanceDirectory: '/test' })

    const req = {
      verb: 'plan.read.session',
      rid: 'test789',
      projectId: 'proj1',
      params: { sessionId: 's1' },
      body: undefined,
    }

    await hook({
      event: {
        type: 'tui.command.execute',
        properties: {
          command: encodeRequest(req),
        },
      },
    })
    await waitForDeferredPublish()

    expect(v2.tui.publish).toHaveBeenCalledTimes(1)
    const call = (v2.tui.publish as any).mock.calls[0][0]
    const replyCmd = call.body.properties.command as string
    expect(replyCmd).toContain('forge.rep:test789:err:')
    // Decode base64url payload to verify error code
    const parts = replyCmd.split(':')
    const b64 = parts.slice(3).join(':')
    const decoded = Buffer.from(b64, 'base64url').toString('utf8')
    expect(decoded).toContain('not_found')
  })

  it('filters events by directory when projectId not provided', async () => {
    const ctx = createMockToolContext('proj1', '/test')
    registry.register(ctx)

    const hook = createBusRpcEventHook({ registry, logger, v2, instanceDirectory: '/test' })

    const req = {
      verb: 'plan.read.session',
      rid: 'testdir',
      directory: '/test',
      params: { sessionId: 's1' },
      body: undefined,
    }

    await hook({
      event: {
        type: 'tui.command.execute',
        properties: {
          command: encodeRequest(req),
        },
      },
    })
    await waitForDeferredPublish()

    expect(v2.tui.publish).toHaveBeenCalledTimes(1)
  })

  it('answers projects.list for requested cwd even when plugin instance cwd differs', async () => {
    const ctx = createMockToolContext('proj1', '/host')
    registry.register(ctx)

    const hook = createBusRpcEventHook({ registry, logger, v2, instanceDirectory: '/host' })

    await hook({
      event: {
        type: 'tui.command.execute',
        properties: {
          command: encodeRequest({
            verb: 'projects.list',
            rid: 'cwdlookup',
            directory: '/requested',
            params: {},
            body: { directory: '/requested' },
          }),
        },
      },
    })
    await waitForDeferredPublish()

    expect(v2.tui.publish).toHaveBeenCalledTimes(1)
    const call = (v2.tui.publish as any).mock.calls[0][0]
    expect(call.directory).toBe('/requested')

    const reply = decodeReply(call.body.properties.command as string)
    expect(reply?.status).toBe('ok')
  })

  it('ignores non-forge requests', async () => {
    const ctx = createMockToolContext('proj1', '/test')
    registry.register(ctx)

    const hook = createBusRpcEventHook({ registry, logger, v2, instanceDirectory: '/test' })

    await hook({
      event: {
        type: 'tui.command.execute',
        properties: {
          command: 'graph.scan',
        },
      },
    })

    expect(v2.tui.publish).not.toHaveBeenCalled()
  })

  it('ignores non-tui.command.execute events', async () => {
    const ctx = createMockToolContext('proj1', '/test')
    registry.register(ctx)

    const hook = createBusRpcEventHook({ registry, logger, v2, instanceDirectory: '/test' })

    await hook({
      event: {
        type: 'other.event',
        properties: {
          command: encodeRequest({
            verb: 'plan.read.session',
            rid: 'test',
            projectId: 'proj1',
            params: { sessionId: 's1' },
            body: undefined,
          }),
        },
      },
    })

    expect(v2.tui.publish).not.toHaveBeenCalled()
  })

  it('two registered projects only handle events matched by directory', async () => {
    const ctx1 = createMockToolContext('proj1', '/project-alpha')
    const ctx2 = createMockToolContext('proj2', '/project-beta')
    registry.register(ctx1)
    registry.register(ctx2)

    vi.spyOn(ctx1.plansRepo, 'getForSession').mockReturnValue({
      sessionId: 's1',
      loopName: null,
      content: 'alpha plan',
      updatedAt: 123,
    } as any)
    vi.spyOn(ctx2.plansRepo, 'getForSession').mockReturnValue({
      sessionId: 's2',
      loopName: null,
      content: 'beta plan',
      updatedAt: 456,
    } as any)

    const hook = createBusRpcEventHook({ registry, logger, v2, instanceDirectory: '/project-beta' })

    // Request for project-beta directory should only be handled by ctx2
    const req = {
      verb: 'plan.read.session',
      rid: 'testdir1',
      directory: '/project-beta',
      params: { sessionId: 's2' },
      body: undefined,
    }

    await hook({
      event: {
        type: 'tui.command.execute',
        properties: {
          command: encodeRequest(req),
        },
      },
    })
    await waitForDeferredPublish()

    expect(v2.tui.publish).toHaveBeenCalledTimes(1)
    const call = (v2.tui.publish as any).mock.calls[0][0]
    expect(call.directory).toBe('/project-beta')
    const replyCmd = call.body.properties.command as string
    expect(replyCmd).toContain('forge.rep:testdir1:ok:')
    const parts = replyCmd.split(':')
    const b64 = parts.slice(3).join(':')
    const decoded = Buffer.from(b64, 'base64url').toString('utf8')
    expect(decoded).toContain('beta plan')
  })
})
