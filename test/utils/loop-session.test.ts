import { test, expect } from 'vitest'
import { createLoopSessionWithWorkspace, deleteSessionBestEffort } from '../../src/utils/loop-session'
import type { Logger } from '../../src/types'
import { buildLoopPermissionRuleset } from '../../src/constants/loop'
import { createFakeForgeClient } from '../helpers/fake-client'
import { ForgeClientError } from '../../src/client/port'

test('session.create body does NOT include workspace query param', async () => {
  let capturedParams: unknown
  const mockSessionCreate = (params: unknown) => {
    capturedParams = params
    return { id: 'session-123' }
  }
  const { client } = createFakeForgeClient({
    session: {
      create: mockSessionCreate,
    },
  })

  const logger: Logger | Console = {
    log: () => {},
    error: () => {},
    debug: () => {},
  }

  await createLoopSessionWithWorkspace({
    client,
    title: 'Test Session',
    directory: '/test/dir',
    permission: buildLoopPermissionRuleset(),
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
    return { id: 'session-123' }
  }
  const { client } = createFakeForgeClient({
    session: {
      create: mockSessionCreate,
    },
  })

  const logger: Logger | Console = {
    log: () => {},
    error: () => {},
    debug: () => {},
  }

  await createLoopSessionWithWorkspace({
    client,
    title: 'Test Session',
    directory: '/test/dir',
    permission: buildLoopPermissionRuleset(),
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
  const { client } = createFakeForgeClient({
    session: {
      create: async () => ({ id: 'session-123' }),
    },
    workspace: {
      warp: async () => { throw new ForgeClientError({ kind: 'not-found', method: 'workspace.warp', message: 'not found' }) },
    },
  })

  const logger: Logger | Console = {
    log: () => {},
    error: (...args: unknown[]) => { capturedErrorArgs = args },
    debug: () => {},
  }

  const result = await createLoopSessionWithWorkspace({
    client,
    title: 'Test Session',
    directory: '/test/dir',
    permission: buildLoopPermissionRuleset(),
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
    return { id: 'session-456' }
  }
  const { client } = createFakeForgeClient({
    session: {
      create: mockSessionCreate,
    },
  })

  const logger: Logger | Console = {
    log: () => {},
    error: () => {},
    debug: () => {},
  }

  const result = await createLoopSessionWithWorkspace({
    client,
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

test('Returns null when session.create fails', async () => {
  const { client } = createFakeForgeClient({
    session: {
      create: async () => { throw new ForgeClientError({ kind: 'request', method: 'session.create', message: 'Unable to connect' }) },
    },
  })

  const logger: Logger | Console = {
    log: () => {},
    error: () => {},
    debug: () => {},
  }

  const result = await createLoopSessionWithWorkspace({
    client,
    title: 'No Fallback Session',
    directory: '/test/dir',
    logPrefix: 'test',
    logger,
  })

  expect(result).toBeNull()
})

test('createLoopSessionWithWorkspace does not emit [perm-diag] log entries', async () => {
  const logEntries: string[] = []
  const errorEntries: string[] = []
  const logger: Logger | Console = {
    log: (msg: string) => { logEntries.push(msg) },
    error: (msg: string) => { errorEntries.push(typeof msg === 'string' ? msg : String(msg)) },
    debug: () => {},
  }
  const { client } = createFakeForgeClient({
    session: {
      create: async () => ({ id: 's1' }),
    },
  })

  await createLoopSessionWithWorkspace({
    client,
    title: 't',
    directory: '/d',
    permission: buildLoopPermissionRuleset(),
    workspaceId: 'ws-1',
    logPrefix: 'test',
    logger,
  })

  const allEntries = [...logEntries, ...errorEntries]
  expect(allEntries.some((e) => e.includes('[perm-diag]'))).toBe(false)
  expect(allEntries.some((e) => e.includes('DRIFT'))).toBe(false)
})

test('deleteSessionBestEffort logs an unavailable delete at debug only', async () => {
  const debugEntries: unknown[][] = []
  const errorEntries: unknown[][] = []
  const logger: Logger = {
    log: () => {},
    debug: (...args: unknown[]) => { debugEntries.push(args) },
    error: (...args: unknown[]) => { errorEntries.push(args) },
  }
  const { client } = createFakeForgeClient({
    session: {
      delete: async () => {
        throw new ForgeClientError({ kind: 'unavailable', method: 'session.delete', message: 'not supported' })
      },
    },
  })

  await deleteSessionBestEffort(client, { sessionID: 's1', directory: '/d' }, logger, 'delete failed')

  expect(debugEntries).toHaveLength(1)
  expect(debugEntries[0]?.[0]).toBe('delete failed')
  expect(errorEntries).toHaveLength(0)
})

test('deleteSessionBestEffort logs other failures at error', async () => {
  const debugEntries: unknown[][] = []
  const errorEntries: unknown[][] = []
  const logger: Logger = {
    log: () => {},
    debug: (...args: unknown[]) => { debugEntries.push(args) },
    error: (...args: unknown[]) => { errorEntries.push(args) },
  }
  const { client } = createFakeForgeClient({
    session: {
      delete: async () => {
        throw new ForgeClientError({ kind: 'request', method: 'session.delete', message: 'boom' })
      },
    },
  })

  await deleteSessionBestEffort(client, { sessionID: 's1', directory: '/d' }, logger, 'delete failed')

  expect(errorEntries).toHaveLength(1)
  expect(errorEntries[0]?.[0]).toBe('delete failed')
  expect(debugEntries).toHaveLength(0)
})

test('deleteSessionBestEffort logs nothing on success', async () => {
  const debugEntries: unknown[][] = []
  const errorEntries: unknown[][] = []
  const logger: Logger = {
    log: () => {},
    debug: (...args: unknown[]) => { debugEntries.push(args) },
    error: (...args: unknown[]) => { errorEntries.push(args) },
  }
  const { client, calls } = createFakeForgeClient()

  await deleteSessionBestEffort(client, { sessionID: 's1', directory: '/d' }, logger, 'delete failed')

  expect(debugEntries).toHaveLength(0)
  expect(errorEntries).toHaveLength(0)
  expect(calls.some((call) => call.method === 'session.delete')).toBe(true)
})
