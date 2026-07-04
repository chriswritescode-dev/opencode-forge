import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createForgeWorkspaceAdapter } from '../../src/workspace/forge-adapter'
import { createFakeGitService } from '../helpers/fake-git'
import type { GitService, GitResult } from '../../src/utils/git-service'
import { join } from 'path'
import { mkdtempSync, existsSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'

function createMockLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

function makeInfo(loopName: string, projectDirectory?: string) {
  return {
    id: 'ws-1',
    type: 'forge',
    name: '',
    branch: null,
    directory: null,
    extra: projectDirectory ? { loopName, projectDirectory } : { loopName },
    projectID: 'p1',
  }
}

describe('createForgeWorkspaceAdapter with fake GitService', () => {
  let logger: ReturnType<typeof createMockLogger>
  let tmpDataDir: string
  let fake: GitService
  let projectDir: string

  beforeEach(() => {
    logger = createMockLogger()
    tmpDataDir = mkdtempSync(join(tmpdir(), 'forge-adapter-fake-git-'))
    projectDir = join(tmpDataDir, 'project')
  })

  afterEach(() => {
    if (existsSync(tmpDataDir)) {
      rmSync(tmpDataDir, { recursive: true, force: true })
    }
  })

  it('rejects when projectDirectory is not a git work tree', async () => {
    fake = createFakeGitService({
      isInsideWorkTree: vi.fn(() => false),
    })
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
      gitService: fake,
    })
    const configured = adapter.configure(makeInfo('test-loop', projectDir))

    await expect(adapter.create(configured, {})).rejects.toThrow(
      /forge workspace adapter: projectDirectory .* is not a git work tree/,
    )
  })

  it('happy path: new branch creates worktree with createBranch=true', async () => {
    fake = createFakeGitService({
      isInsideWorkTree: vi.fn(() => true),
      branchExists: vi.fn(() => false),
    })
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
      gitService: fake,
    })
    const configured = adapter.configure(makeInfo('happy-loop', projectDir))

    await adapter.create(configured, {})

    expect(fake.worktreeAdd).toHaveBeenCalledWith(
      projectDir,
      configured.directory,
      configured.branch,
      true,
      undefined,
    )
  })

  it('existing branch: passes createBranch=false to worktreeAdd', async () => {
    fake = createFakeGitService({
      isInsideWorkTree: vi.fn(() => true),
      branchExists: vi.fn(() => true),
    })
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
      gitService: fake,
    })
    const configured = adapter.configure(makeInfo('existing-loop', projectDir))

    await adapter.create(configured, {})

    expect(fake.worktreeAdd).toHaveBeenCalledWith(
      projectDir,
      configured.directory,
      configured.branch,
      false,
      undefined,
    )
  })

  it('orphan reuse: reuses worktree when currentBranch matches', async () => {
    fake = createFakeGitService({
      isInsideWorkTree: vi.fn(() => true),
      branchExists: vi.fn(() => false),
      currentBranch: vi.fn(() => 'forge/orphan-reuse-loop'),
    })
    fake.worktreeAdd = vi.fn<[string, string, string, boolean], GitResult>(() => ({
      ok: false,
      status: 128,
      stdout: '',
      stderr: 'fatal: ... already exists',
    }))

    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
      gitService: fake,
    })
    const configured = adapter.configure(makeInfo('orphan-reuse-loop', projectDir))
    // Pre-create the worktree directory so existsSync returns true
    mkdirSync(configured.directory!, { recursive: true })

    await adapter.create(configured, {})

    // worktreeAdd should only be called once (no retry)
    expect(fake.worktreeAdd).toHaveBeenCalledTimes(1)
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('reusing existing worktree'),
    )
  })

  it('orphan cleanup + retry: cleans up and retries worktreeAdd', async () => {
    fake = createFakeGitService({
      isInsideWorkTree: vi.fn(() => true),
      branchExists: vi.fn(() => false),
      currentBranch: vi.fn(() => 'different-branch'),
    })
    const failResult: GitResult = {
      ok: false, status: 128, stdout: '', stderr: 'fatal: ... already exists',
    }
    const okResult: GitResult = {
      ok: true, status: 0, stdout: '', stderr: '',
    }
    fake.worktreeAdd = vi.fn<[string, string, string, boolean], GitResult>()
      .mockReturnValueOnce(failResult)
      .mockReturnValueOnce(okResult)

    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
      gitService: fake,
    })
    const configured = adapter.configure(makeInfo('orphan-retry-loop', projectDir))
    // Pre-create the worktree directory WITHOUT .git so cleanupLoopWorktree does rmSync
    mkdirSync(configured.directory!, { recursive: true })

    await adapter.create(configured, {})

    // worktreeAdd should be called twice (initial + retry)
    expect(fake.worktreeAdd).toHaveBeenCalledTimes(2)
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('after orphan cleanup'),
    )
  })

  it('SHA pinned: passes startPoint when commitExists, does not fetch', async () => {
    fake = createFakeGitService({
      isInsideWorkTree: vi.fn(() => true),
      branchExists: vi.fn(() => false),
      commitExists: vi.fn(() => true),
    })
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
      gitService: fake,
    })
    const info = {
      id: 'ws-1',
      type: 'forge' as const,
      name: '',
      branch: null,
      directory: null,
      extra: { loopName: 'pin-loop', projectDirectory: projectDir, startRef: 'abc123def' },
      projectID: 'p1',
    }
    const configured = adapter.configure(info)

    await adapter.create(configured, {})

    expect(fake.worktreeAdd).toHaveBeenCalledWith(
      projectDir,
      configured.directory,
      configured.branch,
      true,
      'abc123def',
    )
    expect(fake.fetchRef).not.toHaveBeenCalled()
  })

  it('SHA pinned: fetches when commit missing, then passes startPoint', async () => {
    const commitExists = vi.fn<[string, string], boolean>()
      .mockReturnValueOnce(false)  // before fetch
      .mockReturnValueOnce(true)   // after fetch
    fake = createFakeGitService({
      isInsideWorkTree: vi.fn(() => true),
      branchExists: vi.fn(() => false),
      commitExists,
    })
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
      gitService: fake,
    })
    const info = {
      id: 'ws-1',
      type: 'forge' as const,
      name: '',
      branch: null,
      directory: null,
      extra: { loopName: 'fetch-loop', projectDirectory: projectDir, startRef: 'def456abc', syncRef: 'refs/forge/custom', gitRemote: 'upstream' },
      projectID: 'p1',
    }
    const configured = adapter.configure(info)

    await adapter.create(configured, {})

    expect(fake.fetchRef).toHaveBeenCalledWith(projectDir, 'upstream', 'refs/forge/custom')
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('forge-adapter:'),
    )
    expect(fake.worktreeAdd).toHaveBeenCalledWith(
      projectDir,
      configured.directory,
      configured.branch,
      true,
      'def456abc',
    )
  })

  it('SHA pinned: uses defaults for syncRef and gitRemote when omitted', async () => {
    const commitExists = vi.fn<[string, string], boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    fake = createFakeGitService({
      isInsideWorkTree: vi.fn(() => true),
      branchExists: vi.fn(() => false),
      commitExists,
    })
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
      gitService: fake,
    })
    const info = {
      id: 'ws-1',
      type: 'forge' as const,
      name: '',
      branch: null,
      directory: null,
      extra: { loopName: 'defaults-loop', projectDirectory: projectDir, startRef: 'abc' },
      projectID: 'p1',
    }
    const configured = adapter.configure(info)

    await adapter.create(configured, {})

    // syncRef defaults to refs/forge/<loopName>, gitRemote defaults to 'origin'
    expect(fake.fetchRef).toHaveBeenCalledWith(projectDir, 'origin', 'refs/forge/defaults-loop')
    expect(fake.worktreeAdd).toHaveBeenCalledWith(
      projectDir,
      configured.directory,
      configured.branch,
      true,
      'abc',
    )
  })

  it('SHA pinned: rejects with descriptive error when still missing after fetch', async () => {
    fake = createFakeGitService({
      isInsideWorkTree: vi.fn(() => true),
      branchExists: vi.fn(() => false),
      commitExists: vi.fn(() => false),
    })
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
      gitService: fake,
    })
    const info = {
      id: 'ws-1',
      type: 'forge' as const,
      name: '',
      branch: null,
      directory: null,
      extra: { loopName: 'missing-loop', projectDirectory: projectDir, startRef: 'deadbeef', syncRef: 'refs/forge/missing', gitRemote: 'origin' },
      projectID: 'p1',
    }
    const configured = adapter.configure(info)

    await expect(adapter.create(configured, {})).rejects.toThrow(
      /startRef deadbeef not found after fetching refs\/forge\/missing from origin/,
    )
    expect(fake.fetchRef).toHaveBeenCalledWith(projectDir, 'origin', 'refs/forge/missing')
    // worktreeAdd should NOT be called when the SHA is missing
    expect(fake.worktreeAdd).not.toHaveBeenCalled()
  })

  it('SHA absent: behavior identical to today (no startPoint)', async () => {
    fake = createFakeGitService({
      isInsideWorkTree: vi.fn(() => true),
      branchExists: vi.fn(() => false),
    })
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
      gitService: fake,
    })
    const configured = adapter.configure(makeInfo('no-pin-loop', projectDir))

    await adapter.create(configured, {})

    // startPoint should be undefined (4 args, no 5th)
    expect(fake.worktreeAdd).toHaveBeenCalledWith(
      projectDir,
      configured.directory,
      configured.branch,
      true,
      undefined,
    )
    expect(fake.fetchRef).not.toHaveBeenCalled()
    expect(fake.commitExists).not.toHaveBeenCalled()
  })

  it('SHA pinned with existing branch: no startPoint passed (branch wins)', async () => {
    fake = createFakeGitService({
      isInsideWorkTree: vi.fn(() => true),
      branchExists: vi.fn(() => true), // branch already exists
      commitExists: vi.fn(() => true),
    })
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
      gitService: fake,
    })
    const info = {
      id: 'ws-1',
      type: 'forge' as const,
      name: '',
      branch: null,
      directory: null,
      extra: { loopName: 'existing-pin-loop', projectDirectory: projectDir, startRef: 'abc' },
      projectID: 'p1',
    }
    const configured = adapter.configure(info)

    await adapter.create(configured, {})

    // Branch exists, so createBranch=false and no startPoint
    expect(fake.worktreeAdd).toHaveBeenCalledWith(
      projectDir,
      configured.directory,
      configured.branch,
      false,
      undefined,
    )
    expect(fake.fetchRef).not.toHaveBeenCalled()
  })

  it('remove: deletes sync ref on shared remote for pinned loops on final teardown', async () => {
    fake = createFakeGitService({
      isInsideWorkTree: vi.fn(() => true),
    })
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
      gitService: fake,
    })
    const info = {
      id: 'ws-1',
      type: 'forge' as const,
      name: 'sync-cleanup-loop',
      branch: 'forge/sync-cleanup-loop',
      directory: join(tmpDataDir, 'worktrees', 'sync-cleanup-loop'),
      extra: { loopName: 'sync-cleanup-loop', projectDirectory: projectDir, startRef: 'abc123', syncRef: 'refs/forge/sync-cleanup-loop', gitRemote: 'upstream' },
      projectID: 'p1',
    }

    await adapter.remove(info, {})

    expect(fake.push).toHaveBeenCalledWith(projectDir, 'upstream', ':refs/forge/sync-cleanup-loop', false)
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('deleted sync ref refs/forge/sync-cleanup-loop on upstream'),
    )
  })

  it('remove: does not touch the shared remote when no pin is present', async () => {
    fake = createFakeGitService({
      isInsideWorkTree: vi.fn(() => true),
    })
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
      gitService: fake,
    })
    const info = {
      id: 'ws-1',
      type: 'forge' as const,
      name: 'local-loop',
      branch: 'forge/local-loop',
      directory: join(tmpDataDir, 'worktrees', 'local-loop'),
      extra: { loopName: 'local-loop', projectDirectory: projectDir },
      projectID: 'p1',
    }

    await adapter.remove(info, {})

    expect(fake.push).not.toHaveBeenCalled()
  })

  it('remove: keeps sync ref when teardown preserves the worktree for restart', async () => {
    fake = createFakeGitService({
      isInsideWorkTree: vi.fn(() => true),
    })
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
      gitService: fake,
      getTeardownContext: () => ({ iteration: 1, reasonLabel: 'error', doCommit: false, doRemoveWorktree: false }),
    })
    const info = {
      id: 'ws-1',
      type: 'forge' as const,
      name: 'restartable-loop',
      branch: 'forge/restartable-loop',
      directory: join(tmpDataDir, 'worktrees', 'restartable-loop'),
      extra: { loopName: 'restartable-loop', projectDirectory: projectDir, startRef: 'abc123', syncRef: 'refs/forge/restartable-loop', gitRemote: 'origin' },
      projectID: 'p1',
    }

    await adapter.remove(info, {})

    expect(fake.push).not.toHaveBeenCalled()
  })

  it('hard failure: rejects with stderr when worktreeAdd fails with non-already-exists error', async () => {
    fake = createFakeGitService({
      isInsideWorkTree: vi.fn(() => true),
      branchExists: vi.fn(() => false),
    })
    fake.worktreeAdd = vi.fn<[string, string, string, boolean], GitResult>(() => ({
      ok: false,
      status: 128,
      stdout: '',
      stderr: 'some other git error',
    }))

    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
      gitService: fake,
    })
    const configured = adapter.configure(makeInfo('hard-fail-loop', projectDir))

    await expect(adapter.create(configured, {})).rejects.toThrow(
      /git worktree add failed: some other git error/,
    )
  })
})
