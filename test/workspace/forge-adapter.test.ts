import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createForgeWorkspaceAdapter } from '../../src/workspace/forge-adapter'
import { createSandboxManager } from '../../src/sandbox/manager'
import { createMockSandboxRuntime } from '../helpers/sandbox-mocks'
import { createMockLogger } from '../helpers/logger'
import { join, isAbsolute } from 'path'
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'fs'
import { execSync } from 'child_process'
import { tmpdir } from 'os'

describe('createForgeWorkspaceAdapter', () => {
  let logger: ReturnType<typeof createMockLogger>
  let tmpDataDir: string

  beforeEach(() => {
    logger = createMockLogger()
    tmpDataDir = mkdtempSync(join(tmpdir(), 'forge-adapter-test-'))
  })

  afterEach(() => {
    if (existsSync(tmpDataDir)) {
      rmSync(tmpDataDir, { recursive: true, force: true })
    }
  })

  function makeInfo(loopName: string, projectDirectory?: string) {
    return {
      id: 'ws-1',
      type: 'forge',
      name: '',
      branch: null,
      directory: null,
      extra: (projectDirectory ? { loopName, projectDirectory } : { loopName }) as Record<string, unknown>,
      projectID: 'p1',
    }
  }

  it('configure returns correct info for valid loopName', () => {
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
    })
    const result = adapter.configure(makeInfo('my-loop'))
    expect(result).toEqual({
      id: 'ws-1',
      type: 'forge',
      name: 'my-loop',
      branch: 'forge/my-loop',
      directory: join(tmpDataDir, 'worktrees', 'my-loop'),
      extra: { loopName: 'my-loop', workspaceCreatedAt: expect.any(Number) },
      projectID: 'p1',
    })
  })

  it('configure throws when extra.loopName is missing', () => {
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
    })
    expect(() =>
      adapter.configure({
        id: 'ws-1',
        type: 'forge',
        name: '',
        branch: null,
        directory: null,
        extra: null,
        projectID: 'p1',
      }),
    ).toThrow('forge workspace adapter: extra.loopName is required')
  })

  it('configure throws when extra.loopName is non-string', () => {
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
    })
    expect(() =>
      adapter.configure({
        id: 'ws-1',
        type: 'forge',
        name: '',
        branch: null,
        directory: null,
        extra: { loopName: 42 },
        projectID: 'p1',
      }),
    ).toThrow('forge workspace adapter: extra.loopName is required')
  })

  it('configure slugifies and caps loopName to 60 chars', () => {
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
    })
    const longName = 'My Loop Name With Many Words And Special Characters!@#$'
    const result = adapter.configure(makeInfo(longName))
    expect(result.name.length).toBeLessThanOrEqual(60)
    expect(result.branch).toMatch(/^forge\/.{1,60}$/)
    expect(result.directory).toBe(join(tmpDataDir, 'worktrees', result.name))
  })

  it('create invokes git worktree add and creates worktree directory', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-repo-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
      })
      const configured = adapter.configure(makeInfo('test-loop', tmpRepo))

      await adapter.create(configured)

      expect(existsSync(configured.directory!)).toBe(true)
      const branch = execSync(`git -C ${configured.directory!} rev-parse --abbrev-ref HEAD`, {
        encoding: 'utf-8',
      }).trim()
      expect(branch).toBe('forge/test-loop')
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create adds .forge/ to git exclude idempotently and leaves .codegraph out of it', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-exclude-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
      })
      const configured = adapter.configure(makeInfo('exclude-loop', tmpRepo))

      await adapter.create(configured)
      await adapter.create(configured)

      let excludePath = execSync(`git -C "${configured.directory!}" rev-parse --git-path info/exclude`, {
        encoding: 'utf-8',
      }).trim()
      // git rev-parse --git-path returns an absolute path for linked worktrees
      // and a relative path (e.g. .git/info/exclude) for standalone repos.
      if (!isAbsolute(excludePath)) {
        excludePath = join(configured.directory!, excludePath)
      }
      const lines = readFileSync(excludePath, 'utf-8')
        .split('\n')
        .map((line) => line.trim())
      expect(lines.filter((line) => line === '.forge/')).toHaveLength(1)
      expect(lines.some((line) => line.startsWith('.codegraph'))).toBe(false)
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create branches the worktree from extra.baseRef, not the project HEAD', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-based-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      writeFileSync(join(tmpRepo, 'a.txt'), 'a', 'utf-8')
      execSync('git add a.txt && git commit -m second', { cwd: tmpRepo, encoding: 'utf-8' })
      const baseRef = execSync('git rev-parse HEAD~1', { cwd: tmpRepo, encoding: 'utf-8' }).trim()
      const projectHead = execSync('git rev-parse HEAD', { cwd: tmpRepo, encoding: 'utf-8' }).trim()
      expect(baseRef).not.toBe(projectHead)

      const adapter = createForgeWorkspaceAdapter({ dataDir: tmpDataDir, logger })
      const info = makeInfo('based-loop', tmpRepo)
      info.extra = { ...info.extra, baseRef }
      const configured = adapter.configure(info)

      await adapter.create(configured)

      const wtHead = execSync(`git -C "${configured.directory!}" rev-parse HEAD`, { encoding: 'utf-8' }).trim()
      expect(wtHead).toBe(baseRef)
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('configure uses extra.branch as the workspace branch when present', () => {
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
    })
    const info = makeInfo('custom-branch-loop')
    info.extra = { ...info.extra, branch: 'pm-61-export' }

    const result = adapter.configure(info)

    expect(result.branch).toBe('pm-61-export')
    expect(result.name).toBe('custom-branch-loop')
    expect(result.directory).toBe(join(tmpDataDir, 'worktrees', 'custom-branch-loop'))
  })

  it('create refuses a based branch that diverged from baseRef and leaves it untouched', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-based-diverged-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const initialBranch = execSync('git symbolic-ref --short HEAD', { cwd: tmpRepo, encoding: 'utf-8' }).trim()
      const branchName = 'pm-61-diverged'
      execSync(`git branch ${branchName}`, { cwd: tmpRepo, encoding: 'utf-8' })

      writeFileSync(join(tmpRepo, 'base.txt'), 'base', 'utf-8')
      execSync('git add base.txt && git commit -m second', { cwd: tmpRepo, encoding: 'utf-8' })
      const baseRef = execSync('git rev-parse HEAD', { cwd: tmpRepo, encoding: 'utf-8' }).trim()

      execSync(`git checkout ${branchName}`, { cwd: tmpRepo, encoding: 'utf-8' })
      writeFileSync(join(tmpRepo, 'branch.txt'), 'branch', 'utf-8')
      execSync('git add branch.txt && git commit -m third', { cwd: tmpRepo, encoding: 'utf-8' })
      execSync(`git checkout ${initialBranch}`, { cwd: tmpRepo, encoding: 'utf-8' })

      const branchTipBefore = execSync(`git rev-parse ${branchName}`, { cwd: tmpRepo, encoding: 'utf-8' }).trim()

      const adapter = createForgeWorkspaceAdapter({ dataDir: tmpDataDir, logger })
      const info = makeInfo('based-diverged-loop', tmpRepo)
      info.extra = { ...info.extra, branch: branchName, baseRef }
      const configured = adapter.configure(info)

      await expect(adapter.create(configured)).rejects.toThrow(
        /forge workspace adapter: Branch .* has commits that .* does not contain; refusing to reuse it for a loop based on/,
      )
      expect(existsSync(configured.directory!)).toBe(false)
      const branchTipAfter = execSync(`git rev-parse ${branchName}`, { cwd: tmpRepo, encoding: 'utf-8' }).trim()
      expect(branchTipAfter).toBe(branchTipBefore)
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create reuses an existing based branch that equals baseRef', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-based-equal-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const branchName = 'pm-61-equal'
      execSync(`git branch ${branchName}`, { cwd: tmpRepo, encoding: 'utf-8' })
      const baseRef = execSync('git rev-parse HEAD', { cwd: tmpRepo, encoding: 'utf-8' }).trim()

      const adapter = createForgeWorkspaceAdapter({ dataDir: tmpDataDir, logger })
      const info = makeInfo('based-equal-loop', tmpRepo)
      info.extra = { ...info.extra, branch: branchName, baseRef }
      const configured = adapter.configure(info)

      await adapter.create(configured)

      expect(existsSync(configured.directory!)).toBe(true)
      const wtHead = execSync(`git -C "${configured.directory!}" rev-parse HEAD`, { encoding: 'utf-8' }).trim()
      expect(wtHead).toBe(baseRef)
      const wtBranch = execSync(`git -C "${configured.directory!}" rev-parse --abbrev-ref HEAD`, { encoding: 'utf-8' }).trim()
      expect(wtBranch).toBe(branchName)
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create fast-forwards an existing based branch that is behind baseRef', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-based-behind-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const branchName = 'pm-61-behind'
      execSync(`git branch ${branchName}`, { cwd: tmpRepo, encoding: 'utf-8' })
      writeFileSync(join(tmpRepo, 'second.txt'), 'second', 'utf-8')
      execSync('git add second.txt && git commit -m second', { cwd: tmpRepo, encoding: 'utf-8' })
      const baseRef = execSync('git rev-parse HEAD', { cwd: tmpRepo, encoding: 'utf-8' }).trim()

      const adapter = createForgeWorkspaceAdapter({ dataDir: tmpDataDir, logger })
      const info = makeInfo('based-behind-loop', tmpRepo)
      info.extra = { ...info.extra, branch: branchName, baseRef }
      const configured = adapter.configure(info)

      await adapter.create(configured)

      const wtHead = execSync(`git -C "${configured.directory!}" rev-parse HEAD`, { encoding: 'utf-8' }).trim()
      expect(wtHead).toBe(baseRef)
      const branchTip = execSync(`git rev-parse ${branchName}`, { cwd: tmpRepo, encoding: 'utf-8' }).trim()
      expect(branchTip).toBe(baseRef)
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining(`(fast-forwarded existing branch to ${baseRef})`),
      )
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create creates an explicit branch from HEAD when no baseRef is set', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-branch-new-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const repoHead = execSync('git rev-parse HEAD', { cwd: tmpRepo, encoding: 'utf-8' }).trim()
      const branchName = 'pm-61-new'

      const adapter = createForgeWorkspaceAdapter({ dataDir: tmpDataDir, logger })
      const info = makeInfo('branch-new-loop', tmpRepo)
      info.extra = { ...info.extra, branch: branchName }
      const configured = adapter.configure(info)

      await adapter.create(configured)

      expect(existsSync(configured.directory!)).toBe(true)
      const wtHead = execSync(`git -C "${configured.directory!}" rev-parse HEAD`, { encoding: 'utf-8' }).trim()
      expect(wtHead).toBe(repoHead)
      const wtBranch = execSync(`git -C "${configured.directory!}" rev-parse --abbrev-ref HEAD`, { encoding: 'utf-8' }).trim()
      expect(wtBranch).toBe(branchName)
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create continues an existing explicit branch as-is when no baseRef is set', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-branch-existing-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const initialBranch = execSync('git symbolic-ref --short HEAD', { cwd: tmpRepo, encoding: 'utf-8' }).trim()
      const branchName = 'pm-61-existing'
      execSync(`git checkout -b ${branchName}`, { cwd: tmpRepo, encoding: 'utf-8' })
      writeFileSync(join(tmpRepo, 'work.txt'), 'work', 'utf-8')
      execSync('git add work.txt && git commit -m work', { cwd: tmpRepo, encoding: 'utf-8' })
      const branchTip = execSync('git rev-parse HEAD', { cwd: tmpRepo, encoding: 'utf-8' }).trim()
      execSync(`git checkout ${initialBranch}`, { cwd: tmpRepo, encoding: 'utf-8' })

      const adapter = createForgeWorkspaceAdapter({ dataDir: tmpDataDir, logger })
      const info = makeInfo('branch-existing-loop', tmpRepo)
      info.extra = { ...info.extra, branch: branchName }
      const configured = adapter.configure(info)

      await adapter.create(configured)

      expect(existsSync(configured.directory!)).toBe(true)
      const wtHead = execSync(`git -C "${configured.directory!}" rev-parse HEAD`, { encoding: 'utf-8' }).trim()
      expect(wtHead).toBe(branchTip)
      const wtBranch = execSync(`git -C "${configured.directory!}" rev-parse --abbrev-ref HEAD`, { encoding: 'utf-8' }).trim()
      expect(wtBranch).toBe(branchName)
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create reports a branch checked out in another worktree instead of raw git stderr', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-branch-in-use-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const branchName = 'pm-61-held'
      execSync(`git checkout -q -b ${branchName}`, { cwd: tmpRepo, encoding: 'utf-8' })

      const adapter = createForgeWorkspaceAdapter({ dataDir: tmpDataDir, logger })
      const info = makeInfo('branch-in-use-loop', tmpRepo)
      info.extra = { ...info.extra, branch: branchName }
      const configured = adapter.configure(info)

      const error = await adapter.create(configured).then(
        () => null,
        (err: unknown) => err as Error,
      )

      expect(error?.message).toContain('is checked out in worktree')
      expect(error?.message).toContain(realpathSync(tmpRepo))
      expect(error?.message).toBe(
        `forge workspace adapter: Branch ${branchName} is checked out in worktree ${realpathSync(tmpRepo)}; choose another branch or free it`,
      )
      expect(existsSync(configured.directory!)).toBe(false)
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create uses info.extra.projectDirectory as the git cwd, ignoring deps', async () => {    const realRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-projdir-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: realRepo, encoding: 'utf-8' })
      const adapter = createForgeWorkspaceAdapter({ dataDir: tmpDataDir, logger })
      const configured = adapter.configure({
        id: 'ws-1', type: 'forge', name: '', branch: null, directory: null,
        extra: { loopName: 'proj-loop', projectDirectory: realRepo }, projectID: 'p1',
      })
      await adapter.create(configured)
      expect(existsSync(configured.directory!)).toBe(true)
    } finally {
      rmSync(realRepo, { recursive: true, force: true })
    }
  })

  it('create throws a clear error when extra.projectDirectory is not a git work tree', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'forge-adapter-notrepo-'))
    try {
      const adapter = createForgeWorkspaceAdapter({ dataDir: tmpDataDir, logger })
      const configured = adapter.configure({
        id: 'ws-1', type: 'forge', name: '', branch: null, directory: null,
        extra: { loopName: 'notrepo-loop', projectDirectory: notARepo }, projectID: 'p1',
      })
      await expect(adapter.create(configured)).rejects.toThrow(
        /forge workspace adapter: projectDirectory .* is not a git work tree/,
      )
    } finally {
      rmSync(notARepo, { recursive: true, force: true })
    }
  })

  it('create throws when extra.projectDirectory is missing', async () => {
    const adapter = createForgeWorkspaceAdapter({ dataDir: tmpDataDir, logger })
    const configured = adapter.configure({
      id: 'ws-1', type: 'forge', name: '', branch: null, directory: null,
      extra: { loopName: 'no-proj-loop' }, projectID: 'p1',
    })
    await expect(adapter.create(configured)).rejects.toThrow(
      /forge workspace adapter: extra\.projectDirectory is required/,
    )
  })

  it('create throws when projectDirectory does not exist', async () => {
    const adapter = createForgeWorkspaceAdapter({ dataDir: tmpDataDir, logger })
    const configured = adapter.configure(makeInfo('fail-loop', '/nonexistent-dir'))

    await expect(adapter.create(configured)).rejects.toThrow(
      /projectDirectory .* is not a git work tree/,
    )
  })

  it('create ensures parent worktree directory exists before calling git', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-repo2-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const nestedDataDir = join(tmpDataDir, 'nested', 'deep')
      const adapter = createForgeWorkspaceAdapter({
        dataDir: nestedDataDir,
        logger,
      })
      const configured = adapter.configure(makeInfo('deep-loop', tmpRepo))

      await adapter.create(configured)

      expect(existsSync(configured.directory!)).toBe(true)
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('created worktree'),
      )
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create starts sandbox after creating the worktree', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-repo-sandbox-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const sandboxManager = {
        start: vi.fn().mockResolvedValue({ containerName: 'forge-sandbox-loop' }),
        stop: vi.fn().mockResolvedValue(undefined),
      }
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
        sandboxManager,
      })
      const configured = adapter.configure(makeInfo('sandbox-loop', tmpRepo))

      await adapter.create(configured)

      expect(existsSync(configured.directory!)).toBe(true)
      expect(sandboxManager.start).toHaveBeenCalledWith('sandbox-loop', configured.directory, expect.any(String), undefined)
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create skips sandbox provisioning when forgeLoop.sandboxEnabled is false', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-repo-sandbox-optout-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const sandboxManager = {
        start: vi.fn().mockRejectedValue(new Error('Docker is not available. Please ensure Docker is running.')),
        stop: vi.fn().mockResolvedValue(undefined),
      }
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
        sandboxManager,
      })
      const info = makeInfo('optout-loop', tmpRepo)
      info.extra = { ...info.extra, forgeLoop: { sandboxEnabled: false } }
      const configured = adapter.configure(info)

      await adapter.create(configured)

      expect(existsSync(configured.directory!)).toBe(true)
      expect(sandboxManager.start).not.toHaveBeenCalled()
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create skips sandbox provisioning when extra.loopSandbox.enabled is false', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-repo-loop-sandbox-optout-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const sandboxManager = {
        start: vi.fn().mockRejectedValue(new Error('sandbox must not be provisioned')),
        stop: vi.fn().mockResolvedValue(undefined),
      }
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
        sandboxManager,
      })
      const info = makeInfo('loop-sandbox-optout', tmpRepo)
      info.extra = { ...info.extra, loopSandbox: { enabled: false } }
      const configured = adapter.configure(info)

      await adapter.create(configured)

      expect(existsSync(configured.directory!)).toBe(true)
      expect(sandboxManager.start).not.toHaveBeenCalled()
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create forwards extra.loopSandbox.resources to sandbox start', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-repo-loop-sandbox-resources-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const sandboxManager = {
        start: vi.fn().mockResolvedValue({ containerName: 'forge-loop-sandbox-resources' }),
        stop: vi.fn().mockResolvedValue(undefined),
      }
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
        sandboxManager,
      })
      const info = makeInfo('loop-sandbox-resources', tmpRepo)
      info.extra = { ...info.extra, loopSandbox: { resources: { memory: '4g', cpus: '2' }, allowLan: true } }
      const configured = adapter.configure(info)

      await adapter.create(configured)

      expect(sandboxManager.start).toHaveBeenCalledWith(
        'loop-sandbox-resources',
        configured.directory,
        expect.any(String),
        { resources: { memory: '4g', cpus: '2' }, allowLan: true },
      )
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create cleans up worktree and sandbox when sandbox start fails', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-repo-sandbox-fail-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const sandboxManager = {
        start: vi.fn().mockRejectedValue(new Error('docker unavailable')),
        stop: vi.fn().mockResolvedValue(undefined),
      }
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
        sandboxManager,
      })
      const configured = adapter.configure(makeInfo('sandbox-fail-loop', tmpRepo))

      await expect(adapter.create(configured)).rejects.toThrow('docker unavailable')

      expect(sandboxManager.stop).toHaveBeenCalledWith('sandbox-fail-loop')
      expect(existsSync(configured.directory!)).toBe(false)
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create never removes a sandbox when provisioning fails on an unknown state query', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-repo-unknown-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const runtime = createMockSandboxRuntime()
      runtime.setSandboxState('forge-sandbox-unknown-loop', 'unknown')
      const sandboxManager = createSandboxManager(runtime, { image: 'oc-forge-sandbox:latest' }, logger)
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
        sandboxManager,
      })
      const configured = adapter.configure(makeInfo('sandbox-unknown-loop', tmpRepo))

      await expect(adapter.create(configured)).rejects.toThrow(/state query failed/)

      // The rollback path calls stop(), which must also fail closed: `unknown` says nothing about
      // the sandbox, so `msb rm` is never issued and a possibly-live sandbox is never destroyed.
      expect(runtime.getRemoveSandboxCalls()).toEqual([])
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('remove runs git worktree remove and prune', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-repo3-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
      })
      const configured = adapter.configure(makeInfo('removal-loop', tmpRepo))
      await adapter.create(configured)

      expect(existsSync(configured.directory!)).toBe(true)

      await adapter.remove(configured)

      expect(existsSync(configured.directory!)).toBe(false)
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('removed worktree'),
      )
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('remove is idempotent: skips remove when directory does not exist', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-repo4-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
      })
      const configured = adapter.configure(makeInfo('idempotent-loop', tmpRepo))
      configured.directory = join(tmpDataDir, 'worktrees', 'idempotent-nonexistent')

      await adapter.remove(configured)

      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('worktree directory already removed'),
      )
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('remove commits pending changes before tearing down', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-commit-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
        getTeardownContext: () => ({ iteration: 3, reasonLabel: 'completed', doCommit: true, doRemoveWorktree: false }),
      })
      const configured = adapter.configure(makeInfo('commit-loop', tmpRepo))
      await adapter.create(configured)
      execSync('git config user.email t@t && git config user.name t', { cwd: configured.directory!, encoding: 'utf-8' })

      // Rename the branch so it falls outside `forge/` — that way the commit
      // step preserves the commit history we can assert on after teardown.
      execSync('git branch -m forge/commit-loop custom/work', { cwd: configured.directory!, encoding: 'utf-8' })
      configured.branch = 'custom/work'

      // Create a pending change inside the worktree.
      execSync('echo hello > pending.txt', { cwd: configured.directory!, encoding: 'utf-8' })

      await adapter.remove(configured)

      // The branch is preserved as-is (no rename) and contains the teardown commit.
      const log = execSync('git log custom/work --format=%s', { cwd: tmpRepo, encoding: 'utf-8' })
      expect(log).toMatch(/loop: commit-loop completed after 3 iterations/)
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('committed pending changes'),
      )
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('remove uses default teardown context when none is registered', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-default-ctx-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
      })
      const configured = adapter.configure(makeInfo('default-ctx-loop', tmpRepo))
      await adapter.create(configured)
      execSync('git config user.email t@t && git config user.name t', { cwd: configured.directory!, encoding: 'utf-8' })
      execSync('git branch -m forge/default-ctx-loop custom/default', { cwd: configured.directory!, encoding: 'utf-8' })
      configured.branch = 'custom/default'
      execSync('echo hi > a.txt', { cwd: configured.directory!, encoding: 'utf-8' })

      await adapter.remove(configured)

      const log = execSync('git log custom/default --format=%s', { cwd: tmpRepo, encoding: 'utf-8' })
      expect(log).toMatch(/loop: default-ctx-loop removed after 0 iterations/)
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('remove skips commit when doCommit is false in teardown context', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-no-commit-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
        getTeardownContext: () => ({ iteration: 1, reasonLabel: 'cancelled', doCommit: false, doRemoveWorktree: false }),
      })
      const configured = adapter.configure(makeInfo('no-commit-loop', tmpRepo))
      await adapter.create(configured)
      execSync('git config user.email t@t && git config user.name t', { cwd: configured.directory!, encoding: 'utf-8' })
      execSync('echo hi > a.txt', { cwd: configured.directory!, encoding: 'utf-8' })

      await adapter.remove(configured)

      expect(logger.log).not.toHaveBeenCalledWith(
        expect.stringContaining('committed pending changes'),
      )
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('remove stops the sandbox during teardown', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-sandbox-stop-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const sandboxManager = {
        start: vi.fn().mockResolvedValue({ containerName: 'forge-sandbox-loop' }),
        stop: vi.fn().mockResolvedValue(undefined),
      }
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
        sandboxManager,
      })
      const configured = adapter.configure(makeInfo('sandbox-stop-loop', tmpRepo))
      await adapter.create(configured)

      await adapter.remove(configured)

      expect(sandboxManager.stop).toHaveBeenCalledWith('sandbox-stop-loop')
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create writes opencode.jsonc and adds it to git exclude', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-opencode-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const config = { mcp: { demo: { type: 'local', command: ['x'], enabled: true } } }
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
        worktreeOpencodeConfig: config,
      })
      const configured = adapter.configure(makeInfo('opencode-loop', tmpRepo))

      await adapter.create(configured)

      const configPath = join(configured.directory!, 'opencode.jsonc')
      expect(existsSync(configPath)).toBe(true)
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual(config)

      let excludePath = execSync(`git -C "${configured.directory!}" rev-parse --git-path info/exclude`, {
        encoding: 'utf-8',
      }).trim()
      if (!isAbsolute(excludePath)) {
        excludePath = join(configured.directory!, excludePath)
      }
      const excludeContent = readFileSync(excludePath, 'utf-8')
      expect(excludeContent).toContain('opencode.jsonc')
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create substitutes the sandbox container placeholder when a sandbox is provisioned', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-placeholder-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const sandboxManager = {
        start: vi.fn().mockResolvedValue({ containerName: 'forge-placeholder-loop' }),
        stop: vi.fn().mockResolvedValue(undefined),
      }
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
        sandboxManager,
        worktreeOpencodeConfig: {
          mcp: {
            'chrome-devtools': {
              type: 'local',
              command: ['docker', 'exec', '-i', '{{FORGE_SANDBOX_CONTAINER}}', 'chrome-devtools-mcp'],
              enabled: true,
            },
          },
        },
      })
      const configured = adapter.configure(makeInfo('placeholder-loop', tmpRepo))

      await adapter.create(configured)

      const written = JSON.parse(readFileSync(join(configured.directory!, 'opencode.jsonc'), 'utf-8'))
      expect(written.mcp['chrome-devtools'].command).toEqual([
        'docker', 'exec', '-i', 'forge-placeholder-loop', 'chrome-devtools-mcp',
      ])
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create drops placeholder mcp entries when the loop opts out of the sandbox', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-placeholder-optout-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const sandboxManager = {
        start: vi.fn().mockResolvedValue({ containerName: 'unused' }),
        stop: vi.fn().mockResolvedValue(undefined),
      }
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
        sandboxManager,
        worktreeOpencodeConfig: {
          mcp: {
            'chrome-devtools': {
              type: 'local',
              command: ['docker', 'exec', '-i', '{{FORGE_SANDBOX_CONTAINER}}', 'chrome-devtools-mcp'],
              enabled: true,
            },
          },
        },
      })
      const info = makeInfo('placeholder-optout-loop', tmpRepo)
      info.extra = { ...info.extra, forgeLoop: { sandboxEnabled: false } }
      const configured = adapter.configure(info)

      await adapter.create(configured)

      expect(sandboxManager.start).not.toHaveBeenCalled()
      expect(existsSync(join(configured.directory!, 'opencode.jsonc'))).toBe(false)
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create does not overwrite a committed opencode.jsonc', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-committed-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const sentinel = { sentinel: true }
      writeFileSync(join(tmpRepo, 'opencode.jsonc'), JSON.stringify(sentinel) + '\n')
      execSync('git add opencode.jsonc && git commit -m "add opencode config"', { cwd: tmpRepo, encoding: 'utf-8' })

      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
        worktreeOpencodeConfig: { mcp: { other: {} } },
      })
      const configured = adapter.configure(makeInfo('committed-opencode-loop', tmpRepo))

      await adapter.create(configured)

      const configPath = join(configured.directory!, 'opencode.jsonc')
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual(sentinel)

      // Also verify the committed config was not added to exclude.
      let excludePath = execSync(`git -C "${configured.directory!}" rev-parse --git-path info/exclude`, {
        encoding: 'utf-8',
      }).trim()
      if (!isAbsolute(excludePath)) {
        excludePath = join(configured.directory!, excludePath)
      }
      const excludeContent = readFileSync(excludePath, 'utf-8')
      expect(excludeContent).not.toContain('opencode.jsonc')
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create does not write opencode.jsonc when no config provided', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-no-opencode-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
      })
      const configured = adapter.configure(makeInfo('no-opencode-loop', tmpRepo))

      await adapter.create(configured)

      expect(existsSync(join(configured.directory!, 'opencode.jsonc'))).toBe(false)
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('remove deletes the forge-written opencode.jsonc and keeps it out of the teardown commit', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-opencode-teardown-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
        worktreeOpencodeConfig: { mcp: { demo: { type: 'local', command: ['x'], enabled: true } } },
        getTeardownContext: () => ({ iteration: 1, reasonLabel: 'completed', doCommit: true, doRemoveWorktree: false }),
      })
      const configured = adapter.configure(makeInfo('opencode-teardown-loop', tmpRepo))
      await adapter.create(configured)
      execSync('git config user.email t@t && git config user.name t', { cwd: configured.directory!, encoding: 'utf-8' })
      execSync('git branch -m forge/opencode-teardown-loop custom/work', { cwd: configured.directory!, encoding: 'utf-8' })
      configured.branch = 'custom/work'

      const configPath = join(configured.directory!, 'opencode.jsonc')
      expect(existsSync(configPath)).toBe(true)

      // Simulate the git-exclude having failed, so opencode.jsonc would otherwise
      // be staged by `git add -A`. The teardown deletion must still keep it out.
      let excludePath = execSync(`git -C "${configured.directory!}" rev-parse --git-path info/exclude`, { encoding: 'utf-8' }).trim()
      if (!isAbsolute(excludePath)) excludePath = join(configured.directory!, excludePath)
      writeFileSync(excludePath, '', 'utf-8')

      // A real pending change so the teardown commit has content to record.
      writeFileSync(join(configured.directory!, 'pending.txt'), 'hello', 'utf-8')

      await adapter.remove(configured)

      expect(existsSync(configPath)).toBe(false)
      const tree = execSync('git ls-tree -r --name-only custom/work', { cwd: tmpRepo, encoding: 'utf-8' })
      expect(tree).toContain('pending.txt')
      expect(tree).not.toContain('opencode.jsonc')
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('remove preserves a repo-tracked opencode.jsonc and commits its edits', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-opencode-tracked-'))
    try {
      execSync('git init && git config user.email t@t && git config user.name t && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      writeFileSync(join(tmpRepo, 'opencode.jsonc'), JSON.stringify({ committed: true }) + '\n')
      execSync('git add opencode.jsonc && git commit -m "add opencode config"', { cwd: tmpRepo, encoding: 'utf-8' })

      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
        worktreeOpencodeConfig: { mcp: { other: {} } },
        getTeardownContext: () => ({ iteration: 1, reasonLabel: 'completed', doCommit: true, doRemoveWorktree: false }),
      })
      const configured = adapter.configure(makeInfo('opencode-tracked-loop', tmpRepo))
      await adapter.create(configured)
      execSync('git config user.email t@t && git config user.name t', { cwd: configured.directory!, encoding: 'utf-8' })
      execSync('git branch -m forge/opencode-tracked-loop custom/tracked', { cwd: configured.directory!, encoding: 'utf-8' })
      configured.branch = 'custom/tracked'

      // Loop edits the tracked config; the edit must survive and be committed.
      const configPath = join(configured.directory!, 'opencode.jsonc')
      writeFileSync(configPath, JSON.stringify({ committed: true, edited: true }) + '\n')

      await adapter.remove(configured)

      expect(existsSync(configPath)).toBe(true)
      const show = execSync('git show custom/tracked:opencode.jsonc', { cwd: tmpRepo, encoding: 'utf-8' })
      expect(JSON.parse(show)).toEqual({ committed: true, edited: true })
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })
})
