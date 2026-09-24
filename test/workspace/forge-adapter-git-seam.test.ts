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

  it('configure re-stamps workspaceCreatedAt and pendingAttachStartedAt with the server clock', () => {
    fake = createFakeGitService()
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
      gitService: fake,
    })
    const skewedPast = Date.now() - 60 * 60 * 1000
    const info = {
      id: 'ws-1',
      type: 'forge' as const,
      name: '',
      branch: null,
      directory: null,
      extra: {
        loopName: 'restamp-loop',
        projectDirectory: projectDir,
        workspaceCreatedAt: skewedPast,
        forgeLoop: { initialPromptOwner: 'tui', pendingAttachStartedAt: skewedPast, planText: '# P' },
      },
      projectID: 'p1',
    }

    const before = Date.now()
    const configured = adapter.configure(info) as typeof info & { extra: Record<string, unknown> }
    const extra = configured.extra as { workspaceCreatedAt: number; forgeLoop: { pendingAttachStartedAt: number; planText: string; initialPromptOwner: string } }

    expect(extra.workspaceCreatedAt).toBeGreaterThanOrEqual(before)
    expect(extra.forgeLoop.pendingAttachStartedAt).toBeGreaterThanOrEqual(before)
    expect(extra.forgeLoop.planText).toBe('# P')
    expect(extra.forgeLoop.initialPromptOwner).toBe('tui')
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
