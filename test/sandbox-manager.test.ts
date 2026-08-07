import { describe, test, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { execSync } from 'child_process'
import { createSandboxManager, buildSandboxWorkspaces } from '../src/sandbox/manager'
import { createMockSandboxRuntime, createMockLogger } from './helpers/sandbox-mocks'

describe('SandboxManager', () => {
  describe('cleanupOrphans', () => {
    test('with no whitelist kills all containers', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      const removed = await manager.cleanupOrphans()

      expect(removed).toBe(2)
      const calls = mockRuntime.getRemoveSandboxCalls()
      expect(calls).toContain('forge-foo')
      expect(calls).toContain('forge-bar')
      expect(manager.isActive('foo')).toBe(false)
      expect(manager.isActive('bar')).toBe(false)
    })

    test('with whitelist preserves matching containers', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.start('foo', '/path/foo')

      const removed = await manager.cleanupOrphans(['foo'])

      expect(removed).toBe(1)
      const calls = mockRuntime.getRemoveSandboxCalls()
      expect(calls).toContain('forge-bar')
      expect(calls).not.toContain('forge-foo')
      expect(manager.isActive('foo')).toBe(true)
    })
  })

  describe('restore', () => {
    test('repopulates map when container is running', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      mockRuntime.setRunning('forge-foo', true)
      const startedAt = new Date().toISOString()

      await manager.restore('foo', '/path/foo', startedAt)

      const createCalls = mockRuntime.getCreateSandboxCalls()
      expect(createCalls.length).toBe(0)
      const active = manager.getActive('foo')
      expect(active).not.toBeNull()
      expect(active?.containerName).toBe('forge-foo')
      expect(active?.projectDir).toBe('/path/foo')
    })

    test('repopulates map with original startedAt when provided', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      mockRuntime.setRunning('forge-foo', true)
      const originalStartedAt = '2025-01-01T00:00:00.000Z'

      await manager.restore('foo', '/path/foo', originalStartedAt)

      const active = manager.getActive('foo')
      expect(active).not.toBeNull()
      expect(active?.startedAt).toBe(originalStartedAt)
    })

    test('starts new container when not running', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      mockRuntime.setRunning('forge-foo', false)

      await manager.restore('foo', '/path/foo', new Date().toISOString())

      const createCalls = mockRuntime.getCreateSandboxCalls()
      expect(createCalls.length).toBe(1)
      expect(createCalls[0][0]).toBe('forge-foo')
      expect(createCalls[0][1][0].hostDir).toBe('/path/foo')
      const active = manager.getActive('foo')
      expect(active).not.toBeNull()
      expect(active?.containerName).toBe('forge-foo')
    })

    test('preserves startedAt when starting new container', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      mockRuntime.setRunning('forge-foo', false)
      const originalStartedAt = '2025-01-01T00:00:00.000Z'

      await manager.restore('foo', '/path/foo', originalStartedAt)

      const active = manager.getActive('foo')
      expect(active).not.toBeNull()
      expect(active?.startedAt).toBe(originalStartedAt)
    })
  })

  describe('start', () => {
    test('throws when sbx daemon is not available', async () => {
      const mockRuntime = createMockSandboxRuntime()
      mockRuntime.setAvailable(false)
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await expect(manager.start('test', '/path')).rejects.toThrow('daemon is not running')
    })

    test('throws actionable error when image does not exist, without building', async () => {
      const mockRuntime = createMockSandboxRuntime()
      mockRuntime.setTemplateExists(false)
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'my-custom-image:tag', buildContextDir: '/some/context' },
        logger
      )

      const err = await manager.start('test', '/path').catch(e => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toMatch(/not found/)
      expect((err as Error).message).toMatch(/my-custom-image:tag/)
      expect((err as Error).message).toMatch(/\/some\/context/)
      expect((err as Error).message).toMatch(/"sandbox":\s*\{\s*"enabled":\s*false\s*\}/)
      expect(mockRuntime.getCreateSandboxCalls().length).toBe(0)
    })

    test('includes opted-in image features in the missing-template build command', async () => {
      const mockRuntime = createMockSandboxRuntime()
      mockRuntime.setTemplateExists(false)
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'custom:browser', buildContextDir: '/some/context', browserControl: true },
        createMockLogger(),
      )

      await expect(manager.start('test', '/path')).rejects.toThrow(
        /docker build --build-arg INSTALL_BROWSER_CONTROL=true -t custom:browser/,
      )
    })

    test('returns early when container already running', async () => {
      const mockRuntime = createMockSandboxRuntime()
      mockRuntime.setRunning('forge-test', true)
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      const result = await manager.start('test', '/path')

      expect(mockRuntime.getCreateSandboxCalls().length).toBe(0)
      expect(result).toEqual({ containerName: 'forge-test' })
    })

    test('creates container and populates active map', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      const result = await manager.start('test', '/path')

      expect(mockRuntime.getCreateSandboxCalls().length).toBe(1)
      expect(manager.isActive('test')).toBe(true)
      const active = manager.getActive('test')
      expect(active).not.toBeNull()
      expect(active?.containerName).toBe('forge-test')
    })

    test('mounts linked worktree git metadata writable', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'sandbox-worktree-'))
      try {
        const worktreeDir = join(tempDir, 'worktree')
        execSync('git init', { cwd: tempDir })
        execSync('git config user.email test@example.com', { cwd: tempDir })
        execSync('git config user.name Test', { cwd: tempDir })
        execSync('git commit --allow-empty -m init', { cwd: tempDir })
        execSync(`git worktree add "${worktreeDir}" -b feature-test`, { cwd: tempDir })

        const mockRuntime = createMockSandboxRuntime()
        const logger = createMockLogger()
        const manager = createSandboxManager(
          mockRuntime,
          { image: 'oc-forge-sandbox:latest' },
          logger
        )

        await manager.start('test', worktreeDir)

        const createCalls = mockRuntime.getCreateSandboxCalls()
        expect(createCalls.length).toBe(1)
        const workspaces = createCalls[0][1]
        const gitDir = execSync('git rev-parse --git-dir', { cwd: worktreeDir, encoding: 'utf-8' }).trim()
        const commonDir = execSync('git rev-parse --git-common-dir', { cwd: worktreeDir, encoding: 'utf-8' }).trim()
        const absoluteGitDir = resolve(worktreeDir, gitDir)
        const absoluteCommonDir = resolve(worktreeDir, commonDir)

        // The git common dir workspace survives read-write and covers the whole git region
        // (including the nested worktree git dir), so in-sandbox git writes stay writable.
        const commonWorkspace = workspaces.find(w => w.hostDir === absoluteCommonDir)
        expect(commonWorkspace).toBeDefined()
        expect(commonWorkspace?.readOnly).not.toBe(true)
        // The git dir region is covered read-write by an accepted workspace.
        expect(workspaces.some(w => absoluteGitDir === w.hostDir || absoluteGitDir.startsWith(w.hostDir + '/'))).toBe(true)
        expect(workspaces.some(w => w.readOnly === true)).toBe(false)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    test('git mounts inside sourceProjectDir survive read-write while the overlapping project workspace is dropped', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'sandbox-git-project-'))
      try {
        const projectDir = join(tempDir, 'main-project')
        const worktreeDir = join(tempDir, 'worktree')
        execSync(`git init "${projectDir}"`, { cwd: tempDir })
        execSync('git config user.email test@example.com', { cwd: projectDir })
        execSync('git config user.name Test', { cwd: projectDir })
        execSync('git commit --allow-empty -m init', { cwd: projectDir })
        execSync(`git worktree add "${worktreeDir}" -b feature-test`, { cwd: projectDir })

        const mockRuntime = createMockSandboxRuntime()
        const logger = createMockLogger()
        const manager = createSandboxManager(
          mockRuntime,
          { image: 'oc-forge-sandbox:latest', sourceProjectDir: projectDir, mountProjectReadonly: true },
          logger
        )

        await manager.start('test', worktreeDir)

        const workspaces = mockRuntime.getCreateSandboxCalls()[0][1]
        const commonDir = resolve(worktreeDir, execSync('git rev-parse --git-common-dir', { cwd: worktreeDir, encoding: 'utf-8' }).trim())
        const gitDir = resolve(worktreeDir, execSync('git rev-parse --git-dir', { cwd: worktreeDir, encoding: 'utf-8' }).trim())

        // The git metadata region survives read-write (the common dir covers the nested git dir)...
        expect(workspaces.some(w => w.hostDir === commonDir && w.readOnly !== true)).toBe(true)
        expect(workspaces.some(w => gitDir === w.hostDir || gitDir.startsWith(w.hostDir + '/'))).toBe(true)
        // ...while the read-only project workspace, an ancestor of the git dirs, is dropped.
        expect(workspaces.some(w => w.hostDir === projectDir)).toBe(false)
        expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/dropping workspace/))
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('stop', () => {
    test('removes container and clears active map', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.start('test', '/path')
      await manager.stop('test')

      expect(mockRuntime.getRemoveSandboxCalls()).toContain('forge-test')
      expect(manager.isActive('test')).toBe(false)
    })

    test('clears active map even when removeSandbox throws', async () => {
      const mockRuntime = createMockSandboxRuntime()
      mockRuntime.setRemoveThrow(true)
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.start('test', '/path')
      // Removal failure is surfaced (the container may still be live) so lifecycle owners can
      // record it, while cleanup still clears the stale in-memory map entry.
      await expect(manager.stop('test')).rejects.toThrow(/Failed to remove sandbox/)

      expect(manager.isActive('test')).toBe(false)
    })

    test('uses containerName fallback when not in active map', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.stop('unknown')

      expect(mockRuntime.getRemoveSandboxCalls()).toContain('forge-unknown')
    })
  })

  describe('getActive and isActive', () => {
    test('returns null and false for unknown worktree', () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      expect(manager.getActive('unknown')).toBeNull()
      expect(manager.isActive('unknown')).toBe(false)
    })

    test('returns active sandbox after start', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.start('test', '/path')

      const active = manager.getActive('test')
      expect(active).not.toBeNull()
      expect(manager.isActive('test')).toBe(true)
    })

    test('returns null and false after stop', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.start('test', '/path')
      await manager.stop('test')

      expect(manager.getActive('test')).toBeNull()
      expect(manager.isActive('test')).toBe(false)
    })
  })

  describe('cleanupOrphans additional', () => {
    test('handles empty container list', async () => {
      const mockRuntime = createMockSandboxRuntime()
      mockRuntime.setSandboxes([])
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      const removed = await manager.cleanupOrphans()

      expect(removed).toBe(0)
    })

    test('continues cleanup when removal fails', async () => {
      const mockRuntime = createMockSandboxRuntime()
      mockRuntime.setSandboxes(['forge-first', 'forge-second'])
      mockRuntime.setRemoveThrow(true)
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.cleanupOrphans()

      const calls = mockRuntime.getRemoveSandboxCalls()
      expect(calls).toContain('forge-first')
      expect(calls).toContain('forge-second')
    })
  })

  describe('isLive', () => {
    test('returns false when worktree is not in active map', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      const result = await manager.isLive('unknown')

      expect(result).toBe(false)
    })

    test('returns true when worktree is in map and runtime reports sandbox running', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.start('test', '/path')

      const result = await manager.isLive('test')

      expect(result).toBe(true)
      expect(manager.isActive('test')).toBe(true)
    })

    test('returns false and removes stale map entry when runtime reports sandbox not running', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      // Start a container to add it to the active map
      await manager.start('test', '/path')
      expect(manager.isActive('test')).toBe(true)

      // Simulate the runtime reporting the sandbox is not running
      mockRuntime.setRunning('forge-test', false)

      const result = await manager.isLive('test')

      expect(result).toBe(false)
      // Stale map entry should have been removed
      expect(manager.isActive('test')).toBe(false)
    })

    test('keeps an idle-suspended (stopped) sandbox live instead of evicting it', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.start('test', '/path')
      mockRuntime.setSandboxState('forge-test', 'stopped')

      // sbx suspends idle microVMs; exec resumes them, so stopped is not dead
      expect(await manager.isLive('test')).toBe(true)
      expect(manager.isActive('test')).toBe(true)
    })

    test('keeps the map entry when the state query fails (unknown)', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.start('test', '/path')
      mockRuntime.setSandboxState('forge-test', 'unknown')

      // `unknown` is not evidence the sandbox is gone
      expect(await manager.isLive('test')).toBe(true)
      expect(manager.isActive('test')).toBe(true)
    })
  })

  describe('start adopts pre-existing sandboxes', () => {
    test('adopts a stopped sandbox instead of creating a duplicate (409 source)', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      mockRuntime.setSandboxState('forge-test', 'stopped')

      const result = await manager.start('test', '/path')

      expect(result.containerName).toBe('forge-test')
      // Creating over an existing sandbox is what sbx answers with 409 Conflict
      expect(mockRuntime.getCreateSandboxCalls()).toHaveLength(0)
      expect(mockRuntime.getRemoveSandboxCalls()).toHaveLength(0)
      expect(manager.isActive('test')).toBe(true)
    })

    test('does not create when the state query fails (unknown)', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      mockRuntime.setSandboxState('forge-test', 'unknown')

      await manager.start('test', '/path')

      expect(mockRuntime.getCreateSandboxCalls()).toHaveLength(0)
      expect(mockRuntime.getRemoveSandboxCalls()).toHaveLength(0)
    })

    test('creates only when the sandbox is confirmed missing', async () => {
      const mockRuntime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const manager = createSandboxManager(
        mockRuntime,
        { image: 'oc-forge-sandbox:latest' },
        logger
      )

      await manager.start('test', '/path')

      expect(mockRuntime.getCreateSandboxCalls()).toHaveLength(1)
      expect(mockRuntime.getCreateSandboxCalls()[0][0]).toBe('forge-test')
    })
  })

  describe('buildSandboxWorkspaces', () => {
    test('drops nested workspaces and keeps non-nested mounts', () => {
      const logger = createMockLogger()
      const result = buildSandboxWorkspaces(
        [
          { hostDir: '/a', containerDir: '/a' },
          { hostDir: '/a/sub', containerDir: '/a/sub' },
          { hostDir: '/b', containerDir: '/b' },
        ],
        logger
      )

      expect(result).toHaveLength(2)
      expect(result[0].hostDir).toBe('/a')
      expect(result[1].hostDir).toBe('/b')
      expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/overlaps/))
    })

    test('drops an ancestor mount that arrives after a descendant', () => {
      const logger = createMockLogger()
      const result = buildSandboxWorkspaces(
        [
          { hostDir: '/a/b', containerDir: '/a/b' },
          { hostDir: '/a', containerDir: '/a' },
        ],
        logger
      )

      expect(result).toHaveLength(1)
      expect(result[0].hostDir).toBe('/a/b')
      expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/overlaps/))
    })
  })
})
