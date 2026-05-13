import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanupLoopWorktree } from '../../src/utils/worktree-cleanup'

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
