import { describe, it, expect, vi, beforeEach } from 'vitest'
import { teardownWorktreeArtifacts, cleanupLoopWorktree, type TeardownInput } from '../../src/utils/worktree-cleanup'
import { finalizeWorktreeBranch } from '../../src/utils/worktree-branch'

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

    expect(result.sessionDeleted).toBe(false)
    expect(result.workspaceDeleted).toBe(true)
    expect(result.worktreeRemoved).toBe(false)
    expect(result.committed).toBe(false)
    expect(result.errors).toEqual([])

    expect(mockV2.experimental.workspace.remove).toHaveBeenCalledWith({ id: 'workspace-456' })
    expect(mockV2.session.delete).not.toHaveBeenCalled()
  })

  it('does not call session.delete (sessions are preserved)', async () => {
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

    expect(mockV2.session.delete).not.toHaveBeenCalled()
  })

  it('does not call session.delete even if it would fail', async () => {
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
    expect(mockV2.session.delete).not.toHaveBeenCalled()
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
    expect(result.sessionDeleted).toBe(false)
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
    expect(result.sessionDeleted).toBe(false)
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
    expect(result.sessionDeleted).toBe(false)
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
    expect(result.sessionDeleted).toBe(false)
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

  it('does not call session.delete (sessions are preserved in normal lifecycle)', async () => {
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

    expect(mockV2.session.delete).not.toHaveBeenCalled()
    expect(result.sessionDeleted).toBe(false)
  })

  it('does not call session.delete even with fallback dirs', async () => {
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

    expect(mockV2.session.delete).not.toHaveBeenCalled()
    expect(result.sessionDeleted).toBe(false)
  })

  it('does not call session.delete when both dirs are same', async () => {
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

    expect(mockV2.session.delete).not.toHaveBeenCalled()
    expect(result.sessionDeleted).toBe(false)
  })
  it('renames branch BEFORE removing workspace', async () => {
    const childProcess = await import('child_process')
    const callOrder: string[] = []
    const workspaceRemoveCallOrder = { index: -1 }

    vi.spyOn(childProcess, 'spawnSync').mockImplementation((cmd: any, args?: any, _opts?: any) => {
      if (cmd === 'git' && Array.isArray(args) && args[0] === 'branch' && args.includes('-m')) {
        callOrder.push(`branch -m @ ${callOrder.length}`)
      } else if (cmd === 'git' && Array.isArray(args) && args[0] === 'show-ref') {
        return { status: 1, stdout: '', stderr: '', error: undefined, pid: 0, output: [null, null, null], signal: null }
      }
      return { status: 0, stdout: '', stderr: '', error: undefined, pid: 0, output: [null, null, null], signal: null }
    })

    const removeMock = vi.fn().mockImplementation(async () => {
      workspaceRemoveCallOrder.index = callOrder.length
      callOrder.push(`workspace.remove @ ${callOrder.length}`)
      return {}
    })

    const input: TeardownInput = {
      v2: {
        session: { delete: vi.fn().mockResolvedValue({ error: undefined }), abort: vi.fn() },
        experimental: { workspace: { remove: removeMock } },
      },
      loopName: 'my-loop',
      sessionId: 'session-1',
      workspaceId: 'ws_test',
      worktreeDir: '/tmp/wt',
      projectDir: '/tmp/wt',
      worktree: true,
      doCommit: false,
      doRemoveWorktree: true,
      reasonLabel: 'completed',
      worktreeBranch: 'opencode/some-old',
      iteration: 1,
      logPrefix: 'Test',
      logger: createMockLogger(),
    } as any

    await teardownWorktreeArtifacts(input)

    const branchMIdx = callOrder.findIndex((c) => c.startsWith('branch -m'))
    const removeIdx = callOrder.findIndex((c) => c.startsWith('workspace.remove'))

    expect(branchMIdx).toBeGreaterThanOrEqual(0)
    expect(removeIdx).toBeGreaterThanOrEqual(0)
    expect(branchMIdx).toBeLessThan(removeIdx)
  })

  it('skips branch rename when worktreeBranch has forge/ prefix', async () => {
    const childProcess = await import('child_process')
    let branchRenameCalled = false

    vi.spyOn(childProcess, 'spawnSync').mockImplementation((cmd: any, args?: any, _opts?: any) => {
      if (cmd === 'git' && Array.isArray(args) && args[0] === 'branch' && args.includes('-m')) {
        branchRenameCalled = true
      }
      return { status: 0, stdout: '', stderr: '', error: undefined, pid: 0, output: [null, null, null], signal: null }
    })

    const input: TeardownInput = {
      v2: {
        session: { delete: vi.fn().mockResolvedValue({ error: undefined }), abort: vi.fn() },
        experimental: { workspace: { remove: vi.fn().mockResolvedValue({}) } },
      },
      loopName: 'my-loop',
      sessionId: 'session-1',
      workspaceId: 'ws_test',
      worktreeDir: '/tmp/wt',
      projectDir: '/tmp/wt',
      worktree: true,
      doCommit: false,
      doRemoveWorktree: true,
      reasonLabel: 'completed',
      worktreeBranch: 'forge/my-loop',
      iteration: 1,
      logPrefix: 'Test',
      logger: createMockLogger(),
    } as any

    await teardownWorktreeArtifacts(input)

    expect(branchRenameCalled).toBe(false)
  })

  it('renames branch when worktreeBranch does NOT have forge/ prefix', async () => {
    const childProcess = await import('child_process')
    let branchRenameCalled = false

    vi.spyOn(childProcess, 'spawnSync').mockImplementation((cmd: any, args?: any, _opts?: any) => {
      if (cmd === 'git' && Array.isArray(args) && args[0] === 'branch' && args.includes('-m')) {
        branchRenameCalled = true
      }
      if (cmd === 'git' && Array.isArray(args) && args[0] === 'show-ref') {
        return { status: 1, stdout: '', stderr: '', error: undefined, pid: 0, output: [null, null, null], signal: null }
      }
      return { status: 0, stdout: '', stderr: '', error: undefined, pid: 0, output: [null, null, null], signal: null }
    })

    const input: TeardownInput = {
      v2: {
        session: { delete: vi.fn().mockResolvedValue({ error: undefined }), abort: vi.fn() },
        experimental: { workspace: { remove: vi.fn().mockResolvedValue({}) } },
      },
      loopName: 'my-loop',
      sessionId: 'session-1',
      workspaceId: 'ws_test',
      worktreeDir: '/tmp/wt',
      projectDir: '/tmp/wt',
      worktree: true,
      doCommit: false,
      doRemoveWorktree: true,
      reasonLabel: 'completed',
      worktreeBranch: 'old-branch',
      iteration: 1,
      logPrefix: 'Test',
      logger: createMockLogger(),
    } as any

    await teardownWorktreeArtifacts(input)

    expect(branchRenameCalled).toBe(true)
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

describe('finalizeWorktreeBranch', () => {
  const worktreeDir = '/tmp/wt'
  const mockLogger = { log: vi.fn(), error: vi.fn() }

  beforeEach(() => {
    vi.restoreAllMocks()
    mockLogger.log.mockReset()
    mockLogger.error.mockReset()
  })

  it('renames branch to opencode/<slug> on completion (no conflict)', async () => {
    const childProcess = await import('child_process')
    vi.spyOn(childProcess, 'spawnSync').mockImplementation((cmd: string, args?: readonly string[], _opts?: any) => {
      if (cmd === 'git' && Array.isArray(args) && args[0] === 'show-ref') {
        return { status: 1, stdout: '', stderr: '', error: undefined, pid: 0, output: [null, null, null], signal: null }
      }
      if (cmd === 'git' && Array.isArray(args) && args[0] === 'branch' && args.includes('-m')) {
        return { status: 0, stdout: '', stderr: '', error: undefined, pid: 0, output: [null, null, null], signal: null }
      }
      return { status: 1, stdout: '', stderr: '', error: undefined, pid: 0, output: [null, null, null], signal: null }
    })

    const result = await finalizeWorktreeBranch({
      worktreeDir,
      currentBranch: 'old-branch',
      loopName: 'my-loop',
      logger: mockLogger,
    })

    expect(result).toEqual({ renamedTo: 'opencode/my-loop' })
  })

  it('appends -2/-3 suffix on conflict, never -1', async () => {
    const childProcess = await import('child_process')
    vi.spyOn(childProcess, 'spawnSync').mockImplementation((cmd: string, args?: readonly string[], _opts?: any) => {
      if (cmd === 'git' && Array.isArray(args) && args[0] === 'show-ref') {
        const ref = args[args.length - 1]
        if (ref === 'refs/heads/opencode/my-loop' || ref === 'refs/heads/opencode/my-loop-2') {
          return { status: 0, stdout: '', stderr: '', error: undefined, pid: 0, output: [null, null, null], signal: null }
        }
        return { status: 1, stdout: '', stderr: '', error: undefined, pid: 0, output: [null, null, null], signal: null }
      }
      if (cmd === 'git' && Array.isArray(args) && args[0] === 'branch' && args.includes('-m')) {
        return { status: 0, stdout: '', stderr: '', error: undefined, pid: 0, output: [null, null, null], signal: null }
      }
      return { status: 1, stdout: '', stderr: '', error: undefined, pid: 0, output: [null, null, null], signal: null }
    })

    const result = await finalizeWorktreeBranch({
      worktreeDir,
      currentBranch: 'old-branch',
      loopName: 'my-loop',
      logger: mockLogger,
    })

    expect(result).toEqual({ renamedTo: 'opencode/my-loop-3' })
  })

  it('skips rename when current branch already matches target', async () => {
    const childProcess = await import('child_process')
    vi.spyOn(childProcess, 'spawnSync').mockImplementation((cmd: string, args?: readonly string[], _opts?: any) => {
      if (cmd === 'git' && Array.isArray(args) && args[0] === 'show-ref') {
        return { status: 1, stdout: '', stderr: '', error: undefined, pid: 0, output: [null, null, null], signal: null }
      }
      return { status: 0, stdout: '', stderr: '', error: undefined, pid: 0, output: [null, null, null], signal: null }
    })

    const result = await finalizeWorktreeBranch({
      worktreeDir,
      currentBranch: 'opencode/my-loop',
      loopName: 'my-loop',
      logger: mockLogger,
    })

    expect(result).toEqual({ renamedTo: 'opencode/my-loop' })
  })

  it('returns null on git failure', async () => {
    const childProcess = await import('child_process')
    vi.spyOn(childProcess, 'spawnSync').mockImplementation(() => ({
      status: -1,
      stdout: '',
      stderr: 'fatal',
      error: undefined,
      pid: 0,
      output: [null, null, null],
      signal: null,
    }))

    const result = await finalizeWorktreeBranch({
      worktreeDir,
      currentBranch: 'old-branch',
      loopName: 'my-loop',
      logger: mockLogger,
    })

    expect(result).toBeNull()
    expect(mockLogger.error).toHaveBeenCalled()
  })

  it('strips multiple leading and trailing dashes', async () => {
    const childProcess = await import('child_process')
    vi.spyOn(childProcess, 'spawnSync').mockImplementation((cmd: string, args?: readonly string[], _opts?: any) => {
      if (cmd === 'git' && Array.isArray(args) && args[0] === 'show-ref') {
        return { status: 1, stdout: '', stderr: '', error: undefined, pid: 0, output: [null, null, null], signal: null }
      }
      if (cmd === 'git' && Array.isArray(args) && args[0] === 'branch' && args.includes('-m')) {
        return { status: 0, stdout: '', stderr: '', error: undefined, pid: 0, output: [null, null, null], signal: null }
      }
      return { status: 1, stdout: '', stderr: '', error: undefined, pid: 0, output: [null, null, null], signal: null }
    })

    const result = await finalizeWorktreeBranch({
      worktreeDir,
      currentBranch: 'old-branch',
      loopName: '--foo--bar--',
      logger: mockLogger,
    })

    expect(result).toEqual({ renamedTo: 'opencode/foo-bar' })
  })

  it('returns null when loopName slugifies to empty', async () => {
    const result = await finalizeWorktreeBranch({
      worktreeDir,
      currentBranch: 'old-branch',
      loopName: '!!!',
      logger: mockLogger,
    })

    expect(result).toBeNull()
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('slugifies to empty'),
    )
  })
})
