import { describe, test, expect, mock } from 'bun:test'
import { createAuditSession, promptAuditSession, deleteAuditSession } from '../src/utils/audit-session'
import { buildAuditSessionPermissionRuleset } from '../src/constants/loop'
import type { Logger } from '../src/types'

interface MockV2Client {
  session: {
    create: ReturnType<typeof mock<(params: any) => Promise<{ data?: { id: string }; error?: unknown }>>>
    promptAsync: ReturnType<typeof mock<(params: any) => Promise<{ data?: unknown; error?: unknown }>>>
    delete: ReturnType<typeof mock<(params: any) => Promise<void>>>
  }
}

function createMockV2Client(): MockV2Client {
  return {
    session: {
      create: mock(() => Promise.resolve({ data: { id: 'sess_mock_123' } })),
      promptAsync: mock(() => Promise.resolve({ data: {} })),
      delete: mock(() => Promise.resolve()),
    },
  }
}

describe('createAuditSession', () => {
  test('creates session with correct audit ruleset', async () => {
    const mockV2 = createMockV2Client()
    const logger = { log: mock(), error: mock() } as unknown as Logger

    const result = await createAuditSession({
      v2: mockV2 as any,
      loopName: 'test-loop',
      iteration: 1,
      worktreeDir: '/tmp/test',
      isSandbox: true,
      prompt: 'test prompt',
      logger,
    })

    expect(result).not.toBeNull()
    expect(mockV2.session.create).toHaveBeenCalled()
    const callArgs = (mockV2.session.create as any).mock.calls[0][0]
    expect(callArgs.permission).toEqual(buildAuditSessionPermissionRuleset({ isSandbox: true }))
    expect(callArgs.title).toBe('audit: test-loop #1')
    expect(callArgs).not.toHaveProperty('parentID')
  })

  test('returns null on session creation error', async () => {
    const mockV2 = createMockV2Client()
    mockV2.session.create = mock(() => Promise.resolve({ error: new Error('create failed') }))
    const logger = { log: mock(), error: mock() } as unknown as Logger

    const result = await createAuditSession({
      v2: mockV2 as any,
      loopName: 'test-loop',
      iteration: 1,
      worktreeDir: '/tmp/test',
      isSandbox: true,
      prompt: 'test prompt',
      logger,
    })

    expect(result).toBeNull()
  })

  test('uses non-sandbox ruleset when isSandbox is false', async () => {
    const mockV2 = createMockV2Client()
    const logger = { log: mock(), error: mock() } as unknown as Logger

    await createAuditSession({
      v2: mockV2 as any,
      loopName: 'test-loop',
      iteration: 1,
      worktreeDir: '/tmp/test',
      isSandbox: false,
      prompt: 'test prompt',
      logger,
    })

    const callArgs = (mockV2.session.create as any).mock.calls[0][0]
    expect(callArgs.permission).toEqual(buildAuditSessionPermissionRuleset({ isSandbox: false }))
  })

  test('creates audit session as top-level session even when previous code session exists', async () => {
    const mockV2 = createMockV2Client()
    const logger = { log: mock(), error: mock() } as unknown as Logger

    await createAuditSession({
      v2: mockV2 as any,
      loopName: 'test-loop',
      iteration: 2,
      worktreeDir: '/tmp/test',
      workspaceId: 'workspace-1',
      isSandbox: false,
      prompt: 'test prompt',
      logger,
    })

    const callArgs = (mockV2.session.create as any).mock.calls[0][0]
    expect(callArgs.workspaceID).toBe('workspace-1')
    expect(callArgs).not.toHaveProperty('parentID')
  })
})

describe('promptAuditSession', () => {
  test('returns ok:true on success', async () => {
    const mockV2 = createMockV2Client()
    mockV2.session.promptAsync = mock(() => Promise.resolve({ data: {} }))

    const result = await promptAuditSession(mockV2 as any, {
      sessionId: 'sess_audit_123',
      worktreeDir: '/tmp/test',
      prompt: 'test prompt',
    })

    expect(result).toEqual({ ok: true })
    expect(mockV2.session.promptAsync).toHaveBeenCalled()
  })

  test('returns ok:false on error', async () => {
    const mockV2 = createMockV2Client()
    const testError = new Error('prompt failed')
    mockV2.session.promptAsync = mock(() => Promise.resolve({ error: testError }))

    const result = await promptAuditSession(mockV2 as any, {
      sessionId: 'sess_audit_123',
      worktreeDir: '/tmp/test',
      prompt: 'test prompt',
    })

    expect(result).toEqual({ ok: false, error: testError })
  })

  test('passes auditorModel when provided', async () => {
    const mockV2 = createMockV2Client()
    mockV2.session.promptAsync = mock(() => Promise.resolve({ data: {} }))

    await promptAuditSession(mockV2 as any, {
      sessionId: 'sess_audit_123',
      worktreeDir: '/tmp/test',
      prompt: 'test prompt',
      auditorModel: { providerID: 'openai', modelID: 'gpt-4' },
    })

    const callArgs = (mockV2.session.promptAsync as any).mock.calls[0][0]
    expect(callArgs.model).toEqual({ providerID: 'openai', modelID: 'gpt-4' })
    expect(callArgs.agent).toBe('auditor-loop')
  })
})

describe('deleteAuditSession', () => {
  test('deletes session successfully', async () => {
    const mockV2 = createMockV2Client()
    const logger = { log: mock(), error: mock() } as unknown as Logger

    await deleteAuditSession(mockV2 as any, 'sess_audit_123', '/tmp/test', logger)

    expect(mockV2.session.delete).toHaveBeenCalledWith({ sessionID: 'sess_audit_123', directory: '/tmp/test' })
  })

  test('swallows errors and logs them', async () => {
    const mockV2 = createMockV2Client()
    const deleteError = new Error('delete failed')
    mockV2.session.delete = mock(() => Promise.reject(deleteError))
    const logger = { log: mock(), error: mock() } as unknown as Logger

    await deleteAuditSession(mockV2 as any, 'sess_audit_123', '/tmp/test', logger)

    expect(logger.error).toHaveBeenCalled()
  })
})
