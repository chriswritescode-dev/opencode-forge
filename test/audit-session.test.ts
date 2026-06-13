import { describe, test, expect, mock } from 'bun:test'
import { createAuditSession, promptAuditSession } from '../src/utils/audit-session'
import { buildAuditSessionPermissionRuleset } from '../src/constants/loop'
import type { Logger } from '../src/types'
import { createFakeForgeClient } from './helpers/fake-client'
import { ForgeClientError } from '../src/client/port'

describe('createAuditSession', () => {
  function createMockClient() {
    const { client } = createFakeForgeClient({
      session: {
        create: async (params: any) => ({ id: 'sess_mock_123' }),
        promptAsync: async () => {},
        delete: async () => {},
      },
      workspace: {
        warp: async () => {},
      },
    })
    return { client, sessionCreate: client.session.create, promptAsync: client.session.promptAsync }
  }

  test('creates session with correct audit ruleset', async () => {
    const { client, sessionCreate } = createMockClient()
    const logger = { log: mock(), error: mock() } as unknown as Logger

    const result = await createAuditSession({
      client,
      loopName: 'test-loop',
      iteration: 1,
      currentSectionIndex: 0,
      totalSections: 0,
      worktreeDir: '/tmp/test',
      isSandbox: true,
      prompt: 'test prompt',
      logger,
    })

    expect(result).not.toBeNull()
    expect(sessionCreate).toHaveBeenCalled()
    const callArgs = (sessionCreate as any).mock.calls[0][0]
    expect(callArgs.permission).toEqual(buildAuditSessionPermissionRuleset({ sandbox: true }))
    expect(callArgs.title).toBe('audit: test-loop #1')
    expect(callArgs).not.toHaveProperty('parentID')
  })

  test('returns null on session creation error', async () => {
    const { client } = createFakeForgeClient({
      session: {
        create: async () => { throw new ForgeClientError({ kind: 'request', method: 'session.create', message: 'create failed', cause: new Error('create failed') }) },
      },
      workspace: {
        warp: async () => {},
      },
    })
    const logger = { log: mock(), error: mock() } as unknown as Logger

    const result = await createAuditSession({
      client,
      loopName: 'test-loop',
      iteration: 1,
      currentSectionIndex: 0,
      totalSections: 0,
      worktreeDir: '/tmp/test',
      isSandbox: true,
      prompt: 'test prompt',
      logger,
    })

    expect(result).toBeNull()
  })

  test('uses non-sandbox ruleset when isSandbox is false', async () => {
    const { client, sessionCreate } = createMockClient()
    const logger = { log: mock(), error: mock() } as unknown as Logger

    await createAuditSession({
      client,
      loopName: 'test-loop',
      iteration: 1,
      currentSectionIndex: 0,
      totalSections: 0,
      worktreeDir: '/tmp/test',
      isSandbox: false,
      prompt: 'test prompt',
      logger,
    })

    const callArgs = (sessionCreate as any).mock.calls[0][0]
    expect(callArgs.permission).toEqual(buildAuditSessionPermissionRuleset({ sandbox: false }))
  })

  test('creates audit session as top-level session even when previous code session exists', async () => {
    const { client, sessionCreate } = createMockClient()
    const logger = { log: mock(), error: mock() } as unknown as Logger

    await createAuditSession({
      client,
      loopName: 'test-loop',
      iteration: 2,
      currentSectionIndex: 0,
      totalSections: 0,
      worktreeDir: '/tmp/test',
      workspaceId: 'workspace-1',
      isSandbox: false,
      prompt: 'test prompt',
      logger,
    })

    const callArgs = (sessionCreate as any).mock.calls[0][0]
    expect(callArgs.workspaceID).toBe('workspace-1')
    expect(callArgs).not.toHaveProperty('parentID')
  })

  test('formats title with section context for sectioned loops', async () => {
    const { client, sessionCreate } = createMockClient()
    const logger = { log: mock(), error: mock() } as unknown as Logger

    await createAuditSession({
      client,
      loopName: 'test-loop',
      iteration: 3,
      currentSectionIndex: 1,
      totalSections: 4,
      worktreeDir: '/tmp/test',
      isSandbox: true,
      prompt: 'test prompt',
      logger,
    })

    const callArgs = (sessionCreate as any).mock.calls[0][0]
    expect(callArgs.title).toBe('audit: test-loop 2/4 #3')
  })
})

describe('promptAuditSession', () => {
  function makeClient() {
    const { client } = createFakeForgeClient({
      session: {
        promptAsync: async () => {},
      },
    })
    return { client, promptAsync: client.session.promptAsync }
  }

  test('returns ok:true on success', async () => {
    const { client, promptAsync } = makeClient()

    const result = await promptAuditSession(client, {
      sessionId: 'sess_audit_123',
      worktreeDir: '/tmp/test',
      prompt: 'test prompt',
    })

    expect(result).toEqual({ ok: true })
    expect(promptAsync).toHaveBeenCalled()
  })

  test('returns ok:false on error', async () => {
    const testError = new Error('prompt failed')
    const { client } = createFakeForgeClient({
      session: {
        promptAsync: async () => { throw testError },
      },
    })

    const result = await promptAuditSession(client, {
      sessionId: 'sess_audit_123',
      worktreeDir: '/tmp/test',
      prompt: 'test prompt',
    })

    expect(result).toEqual({ ok: false, error: testError })
  })

  test('passes auditorModel when provided', async () => {
    const { client, promptAsync } = makeClient()

    await promptAuditSession(client, {
      sessionId: 'sess_audit_123',
      worktreeDir: '/tmp/test',
      prompt: 'test prompt',
      auditorModel: { providerID: 'openai', modelID: 'gpt-4' },
    })

    const callArgs = (promptAsync as any).mock.calls[0][0]
    expect(callArgs.model).toEqual({ providerID: 'openai', modelID: 'gpt-4' })
    expect(callArgs.agent).toBe('auditor-loop')
  })
})
