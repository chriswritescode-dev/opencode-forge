import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanupLoopWorktree } from '../../src/utils/worktree-cleanup'
import { createFakeGitService } from '../helpers/fake-git'
import type { GitService, GitResult } from '../../src/utils/git-service'

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  rmSync: vi.fn(),
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
  let mockExistsSync: ReturnType<typeof vi.fn>
  let mockRmSync: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    mockLogger = createMockLogger()
    const fs = await import('fs')
    mockExistsSync = vi.mocked(fs.existsSync)
    mockRmSync = vi.mocked(fs.rmSync)
  })

  it('removes stale directories without .git before running git commands', async () => {
    mockExistsSync
      .mockReturnValueOnce(true)  // worktreeDir exists
      .mockReturnValueOnce(false) // .git does not exist

    const fake = createFakeGitService()

    const result = await cleanupLoopWorktree({
      worktreeDir: '/tmp/not-git',
      logPrefix: 'Test',
      logger: mockLogger,
      git: fake,
    })

    expect(result.removed).toBe(true)
    expect(result.error).toBeUndefined()
    expect(mockRmSync).toHaveBeenCalledWith('/tmp/not-git', { recursive: true, force: true })
    expect(fake.revParseGitCommonDir).not.toHaveBeenCalled()
    expect(fake.worktreeRemove).not.toHaveBeenCalled()
    expect(fake.worktreePrune).not.toHaveBeenCalled()
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('removed non-git worktree directory'),
    )
  })

  it('returns removed when worktreeDir is missing at entry', async () => {
    mockExistsSync.mockReturnValue(false)

    const fake = createFakeGitService()

    const result = await cleanupLoopWorktree({
      worktreeDir: '/tmp/gone',
      logPrefix: 'Test',
      logger: mockLogger,
      git: fake,
    })

    expect(result.removed).toBe(true)
    expect(result.error).toBeUndefined()
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('worktree directory already removed'),
    )
  })

  it('returns removed with prune when Permission denied and dir is gone', async () => {
    mockExistsSync
      .mockReturnValueOnce(true)  // worktreeDir exists
      .mockReturnValueOnce(true)  // .git exists
      .mockReturnValueOnce(false) // worktreeDir gone after remove attempt

    const fake = createFakeGitService({
      revParseGitCommonDir: vi.fn<[string], GitResult>().mockReturnValue({
        ok: true, status: 0, stdout: '/tmp/.git', stderr: '',
      }),
      worktreeRemove: vi.fn<[string, string], GitResult>().mockReturnValue({
        ok: false, status: 1, stdout: '', stderr: 'Permission denied',
      }),
    })

    const result = await cleanupLoopWorktree({
      worktreeDir: '/tmp/wt',
      logPrefix: 'Test',
      logger: mockLogger,
      git: fake,
    })

    expect(result.removed).toBe(true)
    expect(result.error).toBeUndefined()
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('worktree directory already removed'),
    )
    expect(fake.worktreePrune).toHaveBeenCalled()
  })

  it('returns error for genuine failures (dir present, remove fails)', async () => {
    mockExistsSync.mockReturnValue(true)

    const fake = createFakeGitService({
      revParseGitCommonDir: vi.fn<[string], GitResult>().mockReturnValue({
        ok: true, status: 0, stdout: '/tmp/.git', stderr: '',
      }),
      worktreeRemove: vi.fn<[string, string], GitResult>().mockReturnValue({
        ok: false, status: 1, stdout: '', stderr: 'git worktree remove failed',
      }),
    })

    const result = await cleanupLoopWorktree({
      worktreeDir: '/tmp/wt',
      logPrefix: 'Test',
      logger: mockLogger,
      git: fake,
    })

    expect(result.removed).toBe(false)
    expect(result.error).toBeDefined()
    expect(mockLogger.error).toHaveBeenCalled()
  })

  it('removes directory when rev-parse indicates not a git repository', async () => {
    mockExistsSync
      .mockReturnValueOnce(true)  // worktreeDir exists
      .mockReturnValueOnce(true)  // .git exists

    const fake = createFakeGitService({
      revParseGitCommonDir: vi.fn<[string], GitResult>().mockReturnValue({
        ok: false, status: 128, stdout: '', stderr: 'fatal: not a git repository /tmp/wt',
      }),
    })

    const result = await cleanupLoopWorktree({
      worktreeDir: '/tmp/wt',
      logPrefix: 'Test',
      logger: mockLogger,
      git: fake,
    })

    expect(result.removed).toBe(true)
    expect(result.error).toBeUndefined()
    expect(mockRmSync).toHaveBeenCalledWith('/tmp/wt', { recursive: true, force: true })
    expect(fake.worktreeRemove).not.toHaveBeenCalled()
    expect(fake.worktreePrune).not.toHaveBeenCalled()
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('removed non-git worktree directory'),
    )
  })
})
