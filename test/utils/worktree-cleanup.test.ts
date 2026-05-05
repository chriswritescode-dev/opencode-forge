import { describe, it, expect, vi, beforeEach } from 'vitest'
import { teardownWorktreeArtifacts, type TeardownInput } from '../../src/utils/worktree-cleanup'

function createMockV2Client(overrides?: Partial<any>) {
  return {
    session: {
      abort: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    experimental: {
      workspace: {
        remove: vi.fn().mockResolvedValue({}),
      },
    },
    ...overrides,
  }
}

function createMockLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

describe('teardownWorktreeArtifacts', () => {
  let mockV2: ReturnType<typeof createMockV2Client>
  let mockLogger: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    mockV2 = createMockV2Client()
    mockLogger = createMockLogger()
  })

  it('executes all steps in order and returns success flags', async () => {
    const input: TeardownInput = {
      v2: mockV2 as any,
      loopName: 'test-loop',
      sessionId: 'session-123',
      workspaceId: 'workspace-456',
      worktreeDir: '/tmp/test-worktree',
      projectDir: '/tmp/test-worktree',
      worktree: true,
      doCommit: false,
      doRemoveWorktree: false,
      reasonLabel: 'completed',
      worktreeBranch: 'loop/test-loop',
      iteration: 1,
      logPrefix: 'Test',
      logger: mockLogger,
    }

    const result = await teardownWorktreeArtifacts(input)

    expect(result.sessionDeleted).toBe(true)
    expect(result.workspaceDeleted).toBe(true)
    expect(result.worktreeRemoved).toBe(false)
    expect(result.committed).toBe(false)
    expect(result.errors).toEqual([])

    expect(mockV2.experimental.workspace.remove).toHaveBeenCalledWith({ id: 'workspace-456' })
    expect(mockV2.session.delete).toHaveBeenCalledWith({
      sessionID: 'session-123',
      directory: '/tmp/test-worktree',
    })
  })

  it('uses projectDir for session.delete when provided (host directory for worktree loops)', async () => {
    const input: TeardownInput = {
      v2: mockV2 as any,
      loopName: 'test-loop',
      sessionId: 'session-123',
      workspaceId: 'workspace-456',
      worktreeDir: '/path/to/worktree',
      projectDir: '/path/to/host',
      worktree: true,
      doCommit: false,
      doRemoveWorktree: false,
      reasonLabel: 'completed',
      logPrefix: 'Test',
      logger: mockLogger,
    } as any

    await teardownWorktreeArtifacts(input)

    expect(mockV2.session.delete).toHaveBeenCalledWith({
      sessionID: 'session-123',
      directory: '/path/to/host',
    })
    const callArg = (mockV2.session.delete as any).mock.calls[0][0]
    expect(callArg.directory).toBe('/path/to/host')
  })

  it('continues when session.delete fails', async () => {
    mockV2.session.delete = vi.fn().mockRejectedValue(new Error('session delete failed'))

    const input: TeardownInput = {
      v2: mockV2 as any,
      loopName: 'test-loop',
      sessionId: 'session-123',
      workspaceId: 'workspace-456',
      worktreeDir: '/tmp/test-worktree',
      worktree: true,
      doCommit: false,
      doRemoveWorktree: false,
      reasonLabel: 'completed',
      logPrefix: 'Test',
      logger: mockLogger,
    }

    const result = await teardownWorktreeArtifacts(input)

    expect(result.sessionDeleted).toBe(false)
    expect(result.workspaceDeleted).toBe(true)
    expect(result.errors).toContain('session delete failed')
  })

  it('continues when workspace.remove fails', async () => {
    mockV2.experimental.workspace.remove = vi.fn().mockRejectedValue(new Error('workspace remove failed'))

    const input: TeardownInput = {
      v2: mockV2 as any,
      loopName: 'test-loop',
      sessionId: 'session-123',
      workspaceId: 'workspace-456',
      worktreeDir: '/tmp/test-worktree',
      worktree: true,
      doCommit: false,
      doRemoveWorktree: false,
      reasonLabel: 'completed',
      logPrefix: 'Test',
      logger: mockLogger,
    }

    const result = await teardownWorktreeArtifacts(input)

    expect(result.workspaceDeleted).toBe(false)
    expect(result.sessionDeleted).toBe(true)
    expect(result.errors).toContain('workspace remove failed')
  })

  it('skips workspace removal when workspaceId is null', async () => {
    const input: TeardownInput = {
      v2: mockV2 as any,
      loopName: 'test-loop',
      sessionId: 'session-123',
      workspaceId: null,
      worktreeDir: '/tmp/test-worktree',
      worktree: true,
      doCommit: false,
      doRemoveWorktree: false,
      reasonLabel: 'completed',
      logPrefix: 'Test',
      logger: mockLogger,
    }

    const result = await teardownWorktreeArtifacts(input)

    expect(result.workspaceDeleted).toBe(false)
    expect(result.sessionDeleted).toBe(true)
    expect(mockV2.experimental.workspace.remove).not.toHaveBeenCalled()
  })

  it('skips workspace and worktree steps when worktree is false', async () => {
    const input: TeardownInput = {
      v2: mockV2 as any,
      loopName: 'test-loop',
      sessionId: 'session-123',
      workspaceId: 'workspace-456',
      worktreeDir: '/tmp/test-worktree',
      worktree: false,
      doCommit: true,
      doRemoveWorktree: true,
      reasonLabel: 'completed',
      logPrefix: 'Test',
      logger: mockLogger,
    }

    const result = await teardownWorktreeArtifacts(input)

    expect(result.workspaceDeleted).toBe(false)
    expect(result.worktreeRemoved).toBe(false)
    expect(result.sessionDeleted).toBe(true)
    expect(mockV2.experimental.workspace.remove).not.toHaveBeenCalled()
  })

  it('skips worktree removal when doRemoveWorktree is false', async () => {
    const input: TeardownInput = {
      v2: mockV2 as any,
      loopName: 'test-loop',
      sessionId: 'session-123',
      workspaceId: 'workspace-456',
      worktreeDir: '/tmp/test-worktree',
      worktree: true,
      doCommit: false,
      doRemoveWorktree: false,
      reasonLabel: 'completed',
      logPrefix: 'Test',
      logger: mockLogger,
    }

    const result = await teardownWorktreeArtifacts(input)

    expect(result.worktreeRemoved).toBe(false)
    expect(result.sessionDeleted).toBe(true)
    expect(result.workspaceDeleted).toBe(true)
  })

  it('skips workspace removal when worktree is false', async () => {
    const input: TeardownInput = {
      v2: mockV2 as any,
      loopName: 'test-loop',
      sessionId: 'session-123',
      workspaceId: 'workspace-456',
      worktreeDir: '/tmp/test-worktree',
      worktree: false,
      doCommit: false,
      doRemoveWorktree: true,
      reasonLabel: 'completed',
      logPrefix: 'Test',
      logger: mockLogger,
    }

    const result = await teardownWorktreeArtifacts(input)

    expect(result.workspaceDeleted).toBe(false)
    expect(result.worktreeRemoved).toBe(false)
  })
})
