import { test, expect } from 'bun:test'
import { createLoopWorkspace, bindSessionToWorkspace } from '../../src/workspace/forge-worktree'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

test('createLoopWorkspace: logger receives success line on happy path', async () => {
  let capturedArgs: unknown[] = []
  const mockCreate = () => Promise.resolve({ data: { id: 'ws-server-generated' } })
  const mockClient = {
    experimental: {
      workspace: {
        create: mockCreate,
      },
    },
  } as unknown as OpencodeClient

  const logger = {
    log: (...args: unknown[]) => { capturedArgs = args },
    error: () => {},
  }

  const result = await createLoopWorkspace(mockClient, {
    loopName: 'test-loop',
    directory: '/test/dir',
    branch: null,
  }, logger)

  expect(result).toEqual({ workspaceId: 'ws-server-generated' })
  expect(capturedArgs.length).toBeGreaterThan(0)
  expect(capturedArgs[0]).toContain('ws-server-generated')
  expect(capturedArgs[0]).toContain('test-loop')
})

test('createLoopWorkspace: logger receives error line when SDK returns error', async () => {
  let capturedArgs: unknown[] = []
  const mockCreate = () => Promise.resolve({
    error: { name: 'BadRequest', data: { message: 'nope' } },
  })
  const mockClient = {
    experimental: {
      workspace: {
        create: mockCreate,
      },
    },
  } as unknown as OpencodeClient

  const logger = {
    log: () => {},
    error: (...args: unknown[]) => { capturedArgs = args },
  }

  const result = await createLoopWorkspace(mockClient, {
    loopName: 'test-loop',
    directory: '/test/dir',
    branch: null,
  }, logger)

  expect(result).toBeNull()
  expect(capturedArgs.length).toBeGreaterThan(0)
  expect(capturedArgs[0]).toContain('workspace.create returned error')
  expect(capturedArgs[1]).toEqual({ name: 'BadRequest', data: { message: 'nope' } })
})

test('createLoopWorkspace: logger receives error line when SDK throws', async () => {
  let capturedArgs: unknown[] = []
  const mockCreate = () => Promise.reject(new Error('boom'))
  const mockClient = {
    experimental: {
      workspace: {
        create: mockCreate,
      },
    },
  } as unknown as OpencodeClient

  const logger = {
    log: () => {},
    error: (...args: unknown[]) => { capturedArgs = args },
  }

  const result = await createLoopWorkspace(mockClient, {
    loopName: 'test-loop',
    directory: '/test/dir',
    branch: null,
  }, logger)

  expect(result).toBeNull()
  expect(capturedArgs.length).toBeGreaterThan(0)
  expect(capturedArgs[0]).toBe('createLoopWorkspace: workspace.create threw')
  expect(capturedArgs[1]).toBeInstanceOf(Error)
  expect((capturedArgs[1] as Error).message).toBe('boom')
})

test('createLoopWorkspace: logger receives API unavailable log when client lacks experimental.workspace.create', async () => {
  let capturedArgs: unknown[] = []
  const mockClient = {
    experimental: undefined,
  } as unknown as OpencodeClient

  const logger = {
    log: (...args: unknown[]) => { capturedArgs = args },
    error: () => {},
  }

  const result = await createLoopWorkspace(mockClient, {
    loopName: 'test-loop',
    directory: '/test/dir',
    branch: null,
  }, logger)

  expect(result).toBeNull()
  expect(capturedArgs.length).toBeGreaterThan(0)
  expect(capturedArgs[0]).toBe('createLoopWorkspace: experimental.workspace API not available on this host')
})

test('bindSessionToWorkspace: logs SDK error before throwing', async () => {
  let capturedArgs: unknown[] = []
  const mockSessionRestore = () => Promise.resolve({
    error: { name: 'NotFound', data: { message: 'workspace not found' } },
  })
  const mockClient = {
    experimental: {
      workspace: {
        sessionRestore: mockSessionRestore,
      },
    },
  } as unknown as OpencodeClient

  const logger = {
    log: () => {},
    error: (...args: unknown[]) => { capturedArgs = args },
  }

  await expect(
    bindSessionToWorkspace(mockClient, 'ws-123', 'session-456', logger)
  ).rejects.toThrow('Session restore failed')

  expect(capturedArgs.length).toBeGreaterThan(0)
  expect(capturedArgs[0]).toContain('bindSessionToWorkspace: sessionRestore failed for workspace=ws-123 session=session-456')
  expect(capturedArgs[1]).toEqual({ name: 'NotFound', data: { message: 'workspace not found' } })
})
