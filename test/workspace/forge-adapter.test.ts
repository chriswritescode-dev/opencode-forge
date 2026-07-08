import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createForgeWorkspaceAdapter, type ForgeAdapterDeps } from '../../src/workspace/forge-adapter'
import { join, isAbsolute } from 'path'
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { tmpdir } from 'os'

function createMockLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

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
      extra: projectDirectory ? { loopName, projectDirectory } : { loopName },
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
      extra: { loopName: 'my-loop' },
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
      execSync('git init && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
      })
      const configured = adapter.configure(makeInfo('test-loop', tmpRepo))

      await adapter.create(configured, {})

      expect(existsSync(configured.directory)).toBe(true)
      const branch = execSync(`git -C ${configured.directory} rev-parse --abbrev-ref HEAD`, {
        encoding: 'utf-8',
      }).trim()
      expect(branch).toBe('forge/test-loop')
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create adds .forge/ to git exclude in the worktree', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-exclude-'))
    try {
      execSync('git init && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
      })
      const configured = adapter.configure(makeInfo('exclude-loop', tmpRepo))

      await adapter.create(configured, {})

      let excludePath = execSync(`git -C "${configured.directory}" rev-parse --git-path info/exclude`, {
        encoding: 'utf-8',
      }).trim()
      // git rev-parse --git-path returns an absolute path for linked worktrees
      // and a relative path (e.g. .git/info/exclude) for standalone repos.
      if (!isAbsolute(excludePath)) {
        excludePath = join(configured.directory, excludePath)
      }
      const content = readFileSync(excludePath, 'utf-8')
      expect(content).toContain('.forge/')
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create uses info.extra.projectDirectory as the git cwd, ignoring deps', async () => {
    const realRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-projdir-'))
    try {
      execSync('git init && git commit --allow-empty -m init', { cwd: realRepo, encoding: 'utf-8' })
      const adapter = createForgeWorkspaceAdapter({ dataDir: tmpDataDir, logger })
      const configured = adapter.configure({
        id: 'ws-1', type: 'forge', name: '', branch: null, directory: null,
        extra: { loopName: 'proj-loop', projectDirectory: realRepo }, projectID: 'p1',
      })
      await adapter.create(configured, {})
      expect(existsSync(configured.directory)).toBe(true)
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
      await expect(adapter.create(configured, {})).rejects.toThrow(
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
    await expect(adapter.create(configured, {})).rejects.toThrow(
      /forge workspace adapter: extra\.projectDirectory is required/,
    )
  })

  it('create throws when projectDirectory does not exist', async () => {
    const adapter = createForgeWorkspaceAdapter({ dataDir: tmpDataDir, logger })
    const configured = adapter.configure(makeInfo('fail-loop', '/nonexistent-dir'))

    await expect(adapter.create(configured, {})).rejects.toThrow(
      /projectDirectory .* is not a git work tree/,
    )
  })

  it('create ensures parent worktree directory exists before calling git', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-repo2-'))
    try {
      execSync('git init && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const nestedDataDir = join(tmpDataDir, 'nested', 'deep')
      const adapter = createForgeWorkspaceAdapter({
        dataDir: nestedDataDir,
        logger,
      })
      const configured = adapter.configure(makeInfo('deep-loop', tmpRepo))

      await adapter.create(configured, {})

      expect(existsSync(configured.directory)).toBe(true)
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
      execSync('git init && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
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

      await adapter.create(configured, {})

      expect(existsSync(configured.directory)).toBe(true)
      expect(sandboxManager.start).toHaveBeenCalledWith('sandbox-loop', configured.directory, expect.any(String))
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create skips sandbox provisioning when forgeLoop.sandboxEnabled is false', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-repo-sandbox-optout-'))
    try {
      execSync('git init && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
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

      await adapter.create(configured, {})

      expect(existsSync(configured.directory)).toBe(true)
      expect(sandboxManager.start).not.toHaveBeenCalled()
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('create cleans up worktree and sandbox when sandbox start fails', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-repo-sandbox-fail-'))
    try {
      execSync('git init && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
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

      await expect(adapter.create(configured, {})).rejects.toThrow('docker unavailable')

      expect(sandboxManager.stop).toHaveBeenCalledWith('sandbox-fail-loop')
      expect(existsSync(configured.directory)).toBe(false)
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('remove runs git worktree remove and prune', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-repo3-'))
    try {
      execSync('git init && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
      })
      const configured = adapter.configure(makeInfo('removal-loop', tmpRepo))
      await adapter.create(configured, {})

      expect(existsSync(configured.directory)).toBe(true)

      await adapter.remove(configured)

      expect(existsSync(configured.directory)).toBe(false)
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
      execSync('git init && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
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
        getTeardownContext: () => ({ iteration: 3, reasonLabel: 'completed', doCommit: true }),
      })
      const configured = adapter.configure(makeInfo('commit-loop', tmpRepo))
      await adapter.create(configured, {})
      execSync('git config user.email t@t && git config user.name t', { cwd: configured.directory, encoding: 'utf-8' })

      // Rename the branch so it falls outside `forge/` — that way the commit
      // step preserves the commit history we can assert on after teardown.
      execSync('git branch -m forge/commit-loop custom/work', { cwd: configured.directory, encoding: 'utf-8' })
      configured.branch = 'custom/work'

      // Create a pending change inside the worktree.
      execSync('echo hello > pending.txt', { cwd: configured.directory, encoding: 'utf-8' })

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
      await adapter.create(configured, {})
      execSync('git config user.email t@t && git config user.name t', { cwd: configured.directory, encoding: 'utf-8' })
      execSync('git branch -m forge/default-ctx-loop custom/default', { cwd: configured.directory, encoding: 'utf-8' })
      configured.branch = 'custom/default'
      execSync('echo hi > a.txt', { cwd: configured.directory, encoding: 'utf-8' })

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
        getTeardownContext: () => ({ iteration: 1, reasonLabel: 'cancelled', doCommit: false }),
      })
      const configured = adapter.configure(makeInfo('no-commit-loop', tmpRepo))
      await adapter.create(configured, {})
      execSync('git config user.email t@t && git config user.name t', { cwd: configured.directory, encoding: 'utf-8' })
      execSync('echo hi > a.txt', { cwd: configured.directory, encoding: 'utf-8' })

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
      await adapter.create(configured, {})

      await adapter.remove(configured)

      expect(sandboxManager.stop).toHaveBeenCalledWith('sandbox-stop-loop')
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('target returns local directory', () => {
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      logger,
    })
    const configured = adapter.configure(makeInfo('target-loop'))
    const target = adapter.target(configured)
    expect(target).toEqual({ type: 'local', directory: configured.directory })
  })

  it('create writes opencode.jsonc and adds it to git exclude', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-opencode-'))
    try {
      execSync('git init && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const config = { mcp: { demo: { type: 'local', command: ['x'], enabled: true } } }
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
        worktreeOpencodeConfig: config,
      })
      const configured = adapter.configure(makeInfo('opencode-loop', tmpRepo))

      await adapter.create(configured, {})

      const configPath = join(configured.directory, 'opencode.jsonc')
      expect(existsSync(configPath)).toBe(true)
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual(config)

      let excludePath = execSync(`git -C "${configured.directory}" rev-parse --git-path info/exclude`, {
        encoding: 'utf-8',
      }).trim()
      if (!isAbsolute(excludePath)) {
        excludePath = join(configured.directory, excludePath)
      }
      const excludeContent = readFileSync(excludePath, 'utf-8')
      expect(excludeContent).toContain('opencode.jsonc')
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

      await adapter.create(configured, {})

      const configPath = join(configured.directory, 'opencode.jsonc')
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual(sentinel)

      // Also verify the committed config was not added to exclude.
      let excludePath = execSync(`git -C "${configured.directory}" rev-parse --git-path info/exclude`, {
        encoding: 'utf-8',
      }).trim()
      if (!isAbsolute(excludePath)) {
        excludePath = join(configured.directory, excludePath)
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
      execSync('git init && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const adapter = createForgeWorkspaceAdapter({
        dataDir: tmpDataDir,
        logger,
      })
      const configured = adapter.configure(makeInfo('no-opencode-loop', tmpRepo))

      await adapter.create(configured, {})

      expect(existsSync(join(configured.directory, 'opencode.jsonc'))).toBe(false)
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
        getTeardownContext: () => ({ iteration: 1, reasonLabel: 'completed', doCommit: true }),
      })
      const configured = adapter.configure(makeInfo('opencode-teardown-loop', tmpRepo))
      await adapter.create(configured, {})
      execSync('git config user.email t@t && git config user.name t', { cwd: configured.directory, encoding: 'utf-8' })
      execSync('git branch -m forge/opencode-teardown-loop custom/work', { cwd: configured.directory, encoding: 'utf-8' })
      configured.branch = 'custom/work'

      const configPath = join(configured.directory, 'opencode.jsonc')
      expect(existsSync(configPath)).toBe(true)

      // Simulate the git-exclude having failed, so opencode.jsonc would otherwise
      // be staged by `git add -A`. The teardown deletion must still keep it out.
      let excludePath = execSync(`git -C "${configured.directory}" rev-parse --git-path info/exclude`, { encoding: 'utf-8' }).trim()
      if (!isAbsolute(excludePath)) excludePath = join(configured.directory, excludePath)
      writeFileSync(excludePath, '', 'utf-8')

      // A real pending change so the teardown commit has content to record.
      writeFileSync(join(configured.directory, 'pending.txt'), 'hello', 'utf-8')

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
        getTeardownContext: () => ({ iteration: 1, reasonLabel: 'completed', doCommit: true }),
      })
      const configured = adapter.configure(makeInfo('opencode-tracked-loop', tmpRepo))
      await adapter.create(configured, {})
      execSync('git config user.email t@t && git config user.name t', { cwd: configured.directory, encoding: 'utf-8' })
      execSync('git branch -m forge/opencode-tracked-loop custom/tracked', { cwd: configured.directory, encoding: 'utf-8' })
      configured.branch = 'custom/tracked'

      // Loop edits the tracked config; the edit must survive and be committed.
      const configPath = join(configured.directory, 'opencode.jsonc')
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
