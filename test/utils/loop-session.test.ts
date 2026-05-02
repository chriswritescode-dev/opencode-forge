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
        sessionRestore: () => Promise.resolve({ data: {} }),
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
        sessionRestore: () => Promise.resolve({ data: {} }),
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
  const mockSessionRestore = () => Promise.resolve({
    error: { name: 'NotFound', data: { message: 'not found' } },
  })
  const mockClient = {
    session: {
      create: mockSessionCreate,
    },
    experimental: {
      workspace: {
        sessionRestore: mockSessionRestore,
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
