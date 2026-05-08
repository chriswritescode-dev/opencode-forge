import { test, expect } from 'bun:test'
import { createLoopSessionWithWorkspace } from '../../src/utils/loop-session'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { Logger } from '../../src/types'
import { buildLoopPermissionRuleset } from '../../src/constants/loop'

test('session.create body does NOT include workspace query param', async () => {
  let capturedParams: unknown
  const mockSessionCreate = (params: unknown) => {
    capturedParams = params
    return Promise.resolve({ data: { id: 'session-123' } })
  }
  const mockClient = {
    session: {
      create: mockSessionCreate,
    },
    experimental: {
      workspace: {
        warp: () => Promise.resolve({ data: {} }),
      },
    },
  } as unknown as OpencodeClient

  const logger: Logger | Console = {
    log: () => {},
    error: () => {},
    debug: () => {},
  }

  await createLoopSessionWithWorkspace({
    v2: mockClient,
    title: 'Test Session',
    directory: '/test/dir',
    permission: buildLoopPermissionRuleset({ isWorktree: true, isSandbox: false }),
    workspaceId: 'ws-1',
    logPrefix: 'test',
    logger,
  })

  expect(capturedParams).toBeDefined()
  const params = capturedParams as Record<string, unknown>
  expect(params).not.toHaveProperty('workspace')
  expect(params.workspaceID).toBe('ws-1')
})

test('No workspace field set even when workspaceId is undefined', async () => {
  let capturedParams: unknown
  const mockSessionCreate = (params: unknown) => {
    capturedParams = params
    return Promise.resolve({ data: { id: 'session-123' } })
  }
  const mockClient = {
    session: {
      create: mockSessionCreate,
    },
    experimental: {
      workspace: {
        warp: () => Promise.resolve({ data: {} }),
      },
    },
  } as unknown as OpencodeClient

  const logger: Logger | Console = {
    log: () => {},
    error: () => {},
    debug: () => {},
  }

  await createLoopSessionWithWorkspace({
    v2: mockClient,
    title: 'Test Session',
    directory: '/test/dir',
    permission: buildLoopPermissionRuleset({ isWorktree: true, isSandbox: false }),
    logPrefix: 'test',
    logger,
  })

  expect(capturedParams).toBeDefined()
  const params = capturedParams as Record<string, unknown>
  expect(params).not.toHaveProperty('workspace')
  expect(params).not.toHaveProperty('workspaceID')
})

test('Bind failure path logs via input.logger', async () => {
  let capturedErrorArgs: unknown[] = []
  const mockSessionCreate = () => Promise.resolve({ data: { id: 'session-123' } })
  const mockWarp = () => Promise.resolve({
    error: { name: 'NotFound', data: { message: 'not found' } },
  })
  const mockClient = {
    session: {
      create: mockSessionCreate,
    },
    experimental: {
      workspace: {
        warp: mockWarp,
      },
    },
  } as unknown as OpencodeClient

  const logger: Logger | Console = {
    log: () => {},
    error: (...args: unknown[]) => { capturedErrorArgs = args },
    debug: () => {},
  }

  const result = await createLoopSessionWithWorkspace({
    v2: mockClient,
    title: 'Test Session',
    directory: '/test/dir',
    permission: buildLoopPermissionRuleset({ isWorktree: true, isSandbox: false }),
    workspaceId: 'ws-1',
    logPrefix: 'test',
    logger,
  })

  expect(result).toBeDefined()
  expect(result?.bindFailed).toBe(true)
  expect(capturedErrorArgs.length).toBeGreaterThan(0)
  expect(capturedErrorArgs[0]).toContain('failed to bind session to workspace')
})

test('Calling without permission omits permission from session.create body', async () => {
  let capturedParams: unknown
  const mockSessionCreate = (params: unknown) => {
    capturedParams = params
    return Promise.resolve({ data: { id: 'session-456' } })
  }
  const mockClient = {
    session: {
      create: mockSessionCreate,
    },
    experimental: {
      workspace: {
        warp: () => Promise.resolve({ data: {} }),
      },
    },
  } as unknown as OpencodeClient

  const logger: Logger | Console = {
    log: () => {},
    error: () => {},
    debug: () => {},
  }

  const result = await createLoopSessionWithWorkspace({
    v2: mockClient,
    title: 'No Permission Session',
    directory: '/test/dir',
    workspaceId: 'ws-1',
    logPrefix: 'test',
    logger,
  })

  expect(capturedParams).toBeDefined()
  const params = capturedParams as Record<string, unknown>
  expect(params).not.toHaveProperty('permission')
  expect(params.directory).toBe('/test/dir')
  expect(params.workspaceID).toBe('ws-1')

  expect(result).toBeDefined()
  expect(result?.bindFailed).toBe(false)
})

test('Falls back to legacy SDK when v2 SDK fails and legacy is available', async () => {
  let legacyCapturedBody: unknown
  const mockV2Client = {
    session: {
      create: async () => ({ error: new Error('Unable to connect') }),
      get: async () => ({ data: {} }),
    },
    experimental: {
      workspace: {
        warp: () => Promise.resolve({ data: {} }),
      },
    },
  } as unknown as OpencodeClient

  const mockLegacyClient = {
    session: {
      create: async (args: unknown) => {
        legacyCapturedBody = args
        return { data: { id: 'legacy-session-789' } }
      },
    },
  } as unknown

  const logger: Logger | Console = {
    log: () => {},
    error: () => {},
    debug: () => {},
  }

  const result = await createLoopSessionWithWorkspace({
    v2: mockV2Client,
    title: 'Fallback Session',
    directory: '/test/dir',
    permission: buildLoopPermissionRuleset({ isWorktree: true, isSandbox: false }),
    workspaceId: 'ws-1',
    logPrefix: 'test',
    logger,
    legacyClient: mockLegacyClient as import('@opencode-ai/sdk').OpencodeClient,
  })

  expect(result).toBeDefined()
  expect(result?.sessionId).toBe('legacy-session-789')
  expect(result?.bindFailed).toBe(false)
})

test('Returns null when v2 SDK fails and no legacy client available', async () => {
  const mockV2Client = {
    session: {
      create: async () => ({ error: new Error('Unable to connect') }),
    },
    experimental: {
      workspace: {
        warp: () => Promise.resolve({ data: {} }),
      },
    },
  } as unknown as OpencodeClient

  const logger: Logger | Console = {
    log: () => {},
    error: () => {},
    debug: () => {},
  }

  const result = await createLoopSessionWithWorkspace({
    v2: mockV2Client,
    title: 'No Fallback Session',
    directory: '/test/dir',
    logPrefix: 'test',
    logger,
  })

  expect(result).toBeNull()
})
