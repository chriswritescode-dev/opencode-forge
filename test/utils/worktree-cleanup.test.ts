import { describe, it, expect, vi, beforeEach } from 'vitest'
import { teardownWorktreeArtifacts, cleanupLoopWorktree, type TeardownInput } from '../../src/utils/worktree-cleanup'

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}))

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue('/tmp/.git'),
  spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' }),
}))

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

  it('uses worktreeDir for session.delete first, not projectDir', async () => {
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
      directory: '/path/to/worktree',
    })
    const callArg = (mockV2.session.delete as any).mock.calls[0][0]
    expect(callArg.directory).toBe('/path/to/worktree')
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

  it('deletes session against worktreeDir, not projectDir', async () => {
    const input: TeardownInput = {
      v2: mockV2 as any,
      loopName: 'test-loop',
      sessionId: 'session-123',
      workspaceId: undefined,
      worktreeDir: '/tmp/wt',
      projectDir: '/host/proj',
      worktree: true,
      doCommit: false,
      doRemoveWorktree: false,
      reasonLabel: 'completed',
      logPrefix: 'Test',
      logger: mockLogger,
    }

    const result = await teardownWorktreeArtifacts(input)

    expect(mockV2.session.delete).toHaveBeenCalledTimes(1)
    expect(mockV2.session.delete).toHaveBeenCalledWith({
      sessionID: 'session-123',
      directory: '/tmp/wt',
    })
    expect(result.sessionDeleted).toBe(true)
  })

  it('falls back to projectDir on first-attempt error', async () => {
    mockV2.session.delete = vi.fn()
      .mockResolvedValueOnce({ error: { message: 'not found' } })
      .mockResolvedValueOnce({ error: undefined })

    const input: TeardownInput = {
      v2: mockV2 as any,
      loopName: 'test-loop',
      sessionId: 'session-123',
      workspaceId: undefined,
      worktreeDir: '/tmp/wt',
      projectDir: '/host/proj',
      worktree: true,
      doCommit: false,
      doRemoveWorktree: false,
      reasonLabel: 'completed',
      logPrefix: 'Test',
      logger: mockLogger,
    }

    const result = await teardownWorktreeArtifacts(input)

    expect(mockV2.session.delete).toHaveBeenCalledTimes(2)
    expect(mockV2.session.delete).toHaveBeenNthCalledWith(1, {
      sessionID: 'session-123',
      directory: '/tmp/wt',
    })
    expect(mockV2.session.delete).toHaveBeenNthCalledWith(2, {
      sessionID: 'session-123',
      directory: '/host/proj',
    })
    expect(result.sessionDeleted).toBe(true)
  })

  it('records error when both attempts fail', async () => {
    mockV2.session.delete = vi.fn()
      .mockResolvedValue({ error: { message: 'not found' } })

    const input: TeardownInput = {
      v2: mockV2 as any,
      loopName: 'test-loop',
      sessionId: 'session-123',
      workspaceId: undefined,
      worktreeDir: '/tmp/wt',
      projectDir: '/host/proj',
      worktree: true,
      doCommit: false,
      doRemoveWorktree: false,
      reasonLabel: 'completed',
      logPrefix: 'Test',
      logger: mockLogger,
    }

    const result = await teardownWorktreeArtifacts(input)

    expect(result.sessionDeleted).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(1)
  })

  it('does not retry projectDir when it equals worktreeDir', async () => {
    mockV2.session.delete = vi.fn()
      .mockResolvedValue({ error: { message: 'not found' } })

    const input: TeardownInput = {
      v2: mockV2 as any,
      loopName: 'test-loop',
      sessionId: 'session-123',
      workspaceId: undefined,
      worktreeDir: '/tmp/wt',
      projectDir: '/tmp/wt',
      worktree: true,
      doCommit: false,
      doRemoveWorktree: false,
      reasonLabel: 'completed',
      logPrefix: 'Test',
      logger: mockLogger,
    }

    const result = await teardownWorktreeArtifacts(input)

    expect(mockV2.session.delete).toHaveBeenCalledTimes(1)
    expect(mockV2.session.delete).toHaveBeenCalledWith({
      sessionID: 'session-123',
      directory: '/tmp/wt',
    })
    expect(result.sessionDeleted).toBe(false)
  })
})

describe('cleanupLoopWorktree', () => {
  let mockLogger: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  it('returns removed when worktreeDir is missing at entry', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const result = await cleanupLoopWorktree({
      worktreeDir: '/tmp/gone',
      logPrefix: 'Test',
      logger: mockLogger,
    })

    expect(result.removed).toBe(true)
    expect(result.error).toBeUndefined()
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('worktree directory already removed'),
    )
  })

  it('returns removed with prune when Permission denied and dir is gone', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)

    const childProcess = await import('child_process')
    vi.mocked(childProcess.spawnSync).mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'Permission denied',
      error: undefined,
      pid: 0,
      output: [null, null, null],
      signal: null,
    })

    const result = await cleanupLoopWorktree({
      worktreeDir: '/tmp/wt',
      logPrefix: 'Test',
      logger: mockLogger,
    })

    expect(result.removed).toBe(true)
    expect(result.error).toBeUndefined()
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('worktree directory already removed'),
    )
  })

  it('returns error for genuine failures (dir present, remove fails)', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)

    const childProcess = await import('child_process')
    vi.mocked(childProcess.spawnSync).mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'git worktree remove failed',
      error: undefined,
      pid: 0,
      output: [null, null, null],
      signal: null,
    })

    const result = await cleanupLoopWorktree({
      worktreeDir: '/tmp/wt',
      logPrefix: 'Test',
      logger: mockLogger,
    })

    expect(result.removed).toBe(false)
    expect(result.error).toBeDefined()
    expect(mockLogger.error).toHaveBeenCalled()
  })
})
