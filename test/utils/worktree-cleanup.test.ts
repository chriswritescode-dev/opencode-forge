import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanupLoopWorktree } from '../../src/utils/worktree-cleanup'
import { finalizeWorktreeBranch } from '../../src/utils/worktree-branch'

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}))

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue('/tmp/.git'),
  spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' }),
}))

function createMockLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

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
