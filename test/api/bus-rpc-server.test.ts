import { describe, it, expect, vi, beforeEach } from 'bun:test'
import { createBusRpcEventHook } from '../../src/api/bus-rpc'
import { decodeReply, encodeRequest, decodeEvent, encodeEvent } from '../../src/api/bus-protocol'
import type { ToolContext } from '../../src/tools/types'
import type { Logger } from '../../src/types'
import type { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2'
import type { ProjectRegistry } from '../../src/api/project-registry'
import type { LoopsRepo } from '../../src/storage/repos/loops-repo'
import type { LoopService } from '../../src/services/loop'
import type { PlansRepo } from '../../src/storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../../src/storage/repos/review-findings-repo'
import * as loopsHandler from '../../src/api/handlers/loops'

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
    loopService: {
      generateUniqueLoopName: vi.fn((base: string) => `${base}-1`),
      getActiveState: vi.fn(),
      resolveLoopName: vi.fn(),
      listActive: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      findMatchByName: vi.fn(),
      setState: vi.fn(),
      deleteState: vi.fn(),
      registerLoopSession: vi.fn(),
      getPlanText: vi.fn(() => ''),
    } as unknown as LoopService,
    loopHandler: vi.fn(),
    v2: createMockV2(),
    cleanup: vi.fn(),
    input: {} as any,
    sandboxManager: null,
    plansRepo: {
      getForSession: vi.fn(),
      getForLoop: vi.fn(),
      writeForSession: vi.fn(),
      writeForLoop: vi.fn(),
      deleteForSession: vi.fn(),
      deleteForLoop: vi.fn(),
    } as unknown as PlansRepo,
    loopsRepo: {
      write: vi.fn(),
      read: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(() => []),
      findById: vi.fn(),
      findLatest: vi.fn(),
    } as unknown as LoopsRepo,
    reviewFindingsRepo: {
      write: vi.fn(),
      read: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(() => []),
      findById: vi.fn(),
    } as unknown as ReviewFindingsRepo,
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
          command: 'unknown.verb',
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
    
    // Set up mock for ctx2's plansRepo
    vi.spyOn(ctx2.plansRepo, 'getForSession').mockReturnValue({
      sessionId: 's2',
      loopName: null,
      content: 'beta plan content',
      updatedAt: 123,
    } as any)
    
    registry.register(ctx1)
    registry.register(ctx2)

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
    expect(decoded).toContain('beta plan content')
  })

  it('loop-worktree mode: publishes loop.started event before final reply', async () => {
    const ctx = createMockToolContext('proj1', '/test')
    registry.register(ctx)

    const hook = createBusRpcEventHook({ registry, logger, v2, instanceDirectory: '/test' })

    const req = {
      verb: 'plan.execute',
      rid: 'loop-test-123',
      projectId: 'proj1',
      params: { sessionId: 's1' },
      body: {
        mode: 'loop-worktree',
        plan: 'test plan content',
        title: 'Test Loop',
        executionModel: 'test-model',
      },
    }

    let resolveDispatch!: () => void
    const dispatchDeferred = new Promise<void>((resolve) => {
      resolveDispatch = resolve
    })

    const mockResult = {
      ok: true as const,
      data: {
        loopName: 'test-loop-1',
        sessionId: 'test-session-1',
        displayName: 'Test Loop',
        worktreeDir: '/tmp/worktree',
        workspaceId: 'ws-1',
        modelUsed: 'test-model',
      },
    }

    const executionModule = await import('../../src/services/execution')
    vi.spyOn(executionModule, 'createForgeExecutionService').mockImplementation((deps: any) => {
      return {
        dispatch: vi.fn().mockImplementation(async (execCtx: any, command: any) => {
          command.lifecycle?.onStarted?.({
            mode: command.mode,
            sessionId: 'test-session-1',
            loopName: 'test-loop-1',
            displayName: 'Test Loop',
            worktreeDir: '/tmp/worktree',
            workspaceId: 'ws-1',
          })
          await dispatchDeferred
          return mockResult
        }),
      } as any
    })

    hook({
      event: {
        type: 'tui.command.execute',
        properties: {
          command: encodeRequest(req),
        },
      },
    })

    // Wait for deferred publishes - both event and reply should be scheduled before dispatch completes
    await new Promise(resolve => setTimeout(resolve, 50))

    // Should have 2 publishes: event first, then reply - BEFORE dispatch resolves
    expect(v2.tui.publish).toHaveBeenCalledTimes(2)

    // First publish should be the loop.started event
    const eventCall = (v2.tui.publish as any).mock.calls[0][0]
    const eventCmd = eventCall.body.properties.command as string
    expect(eventCmd).toContain('forge.evt:loop.started:loop-test-123:')

    const decodedEvent = decodeEvent(eventCmd)
    expect(decodedEvent).toBeTruthy()
    if (decodedEvent && 'rid' in decodedEvent) {
      expect(decodedEvent.name).toBe('loop.started')
      expect(decodedEvent.rid).toBe('loop-test-123')
      const eventData = decodedEvent.data as { sessionId?: string; loopName?: string }
      expect(eventData?.sessionId).toBe('test-session-1')
      expect(eventData?.loopName).toBe('test-loop-1')
    }

    // Second publish should be the reply (published early, before dispatch completes)
    const replyCall = (v2.tui.publish as any).mock.calls[1][0]
    const replyCmd = replyCall.body.properties.command as string
    expect(replyCmd).toContain('forge.rep:loop-test-123:ok:')

    const decodedReply = decodeReply(replyCmd)
    expect(decodedReply).toBeTruthy()
    expect(decodedReply?.status).toBe('ok')
    const replyData = decodedReply?.data as { sessionId?: string; loopName?: string }
    expect(replyData?.sessionId).toBe('test-session-1')
    expect(replyData?.loopName).toBe('test-loop-1')

    // Now let dispatch complete to avoid async leaks
    resolveDispatch()
  })
})
