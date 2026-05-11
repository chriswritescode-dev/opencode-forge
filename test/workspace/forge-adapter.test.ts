import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createForgeWorkspaceAdapter, type ForgeAdapterDeps } from '../../src/workspace/forge-adapter'
import { join } from 'path'
import { mkdtempSync, existsSync, rmSync } from 'fs'
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

  function makeInfo(loopName: string) {
    return {
      id: 'ws-1',
      type: 'forge',
      name: '',
      branch: null,
      directory: null,
      extra: { loopName },
      projectID: 'p1',
    }
  }

  it('configure returns correct info for valid loopName', () => {
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      projectRoot: '/tmp/project',
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
      projectRoot: '/tmp/project',
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
      projectRoot: '/tmp/project',
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
      projectRoot: '/tmp/project',
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
        projectRoot: tmpRepo,
        logger,
      })
      const configured = adapter.configure(makeInfo('test-loop'))

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

  it('create propagates failure when git command fails', async () => {
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      projectRoot: '/nonexistent-dir',
      logger,
    })
    const configured = adapter.configure(makeInfo('fail-loop'))

    await expect(adapter.create(configured, {})).rejects.toThrow(
      /git worktree add failed/,
    )
  })

  it('create ensures parent worktree directory exists before calling git', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'forge-adapter-repo2-'))
    try {
      execSync('git init && git commit --allow-empty -m init', { cwd: tmpRepo, encoding: 'utf-8' })
      const nestedDataDir = join(tmpDataDir, 'nested', 'deep')
      const adapter = createForgeWorkspaceAdapter({
        dataDir: nestedDataDir,
        projectRoot: tmpRepo,
        logger,
      })
      const configured = adapter.configure(makeInfo('deep-loop'))

      await adapter.create(configured, {})

      expect(existsSync(configured.directory)).toBe(true)
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('created worktree'),
      )
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
        projectRoot: tmpRepo,
        logger,
      })
      const configured = adapter.configure(makeInfo('removal-loop'))
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
        projectRoot: tmpRepo,
        logger,
      })
      const configured = adapter.configure(makeInfo('idempotent-loop'))
      configured.directory = join(tmpDataDir, 'worktrees', 'idempotent-nonexistent')

      await adapter.remove(configured)

      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('removed worktree'),
      )
    } finally {
      if (existsSync(tmpRepo)) rmSync(tmpRepo, { recursive: true, force: true })
    }
  })

  it('target returns local directory', () => {
    const adapter = createForgeWorkspaceAdapter({
      dataDir: tmpDataDir,
      projectRoot: '/tmp/project',
      logger,
    })
    const configured = adapter.configure(makeInfo('target-loop'))
    const target = adapter.target(configured)
    expect(target).toEqual({ type: 'local', directory: configured.directory })
  })
})
