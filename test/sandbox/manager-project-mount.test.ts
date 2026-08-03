import { describe, test, expect } from 'vitest'
import { createSandboxManager, type SandboxManagerConfig } from '../../src/sandbox/manager'
import { createMockLogger, createMockSandboxRuntime } from '../helpers/sandbox-mocks'

describe('SandboxManager project mount', () => {
  test('adds project mount when sourceProjectDir differs from worktreeDir', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      sourceProjectDir: '/tmp',
      mountProjectReadonly: true,
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const calls = runtime.getCreateSandboxCalls()
    expect(calls.length).toBe(1)
    const workspaces = calls[0][1]
    expect(workspaces).toContainEqual({ hostDir: '/tmp', readOnly: true })
  })

  test('does not add project mount when mountProjectReadonly is false', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      sourceProjectDir: '/home/user/main-project',
      mountProjectReadonly: false,
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const workspaces = runtime.getCreateSandboxCalls()[0][1]
    expect(workspaces).toHaveLength(1)
    expect(workspaces.some((w) => w.hostDir === '/home/user/main-project')).toBe(false)
  })

  test('does not add project mount when sourceProjectDir equals worktreeDir', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      sourceProjectDir: '/home/user/project',
      mountProjectReadonly: true,
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/project')

    const workspaces = runtime.getCreateSandboxCalls()[0][1]
    expect(workspaces).toHaveLength(1)
    expect(workspaces.some((w) => w.hostDir === '/home/user/project' && w.readOnly === true)).toBe(false)
  })

  test('does not add project mount when sourceProjectDir is not configured', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/project')

    const workspaces = runtime.getCreateSandboxCalls()[0][1]
    expect(workspaces).toHaveLength(1)
  })

  test('does not pass a stale source project directory to sbx', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const manager = createSandboxManager(runtime, {
      image: 'oc-forge-sandbox:latest',
      sourceProjectDir: '/definitely/missing/source-project',
      mountProjectReadonly: true,
    }, logger)

    await manager.start('test', '/home/user/worktrees/feature')

    expect(runtime.getCreateSandboxCalls()[0][1]).toEqual([
      { hostDir: '/home/user/worktrees/feature', readOnly: undefined },
    ])
  })

  test('mounts list on active sandbox includes both worktree and project mounts', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      sourceProjectDir: '/tmp',
      mountProjectReadonly: true,
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(2)
    expect(active?.mounts[0]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/home/user/worktrees/feature' })
    expect(active?.mounts[1]).toEqual({ hostDir: '/tmp', containerDir: '/tmp', readOnly: true })
  })

  test('mounts list only has worktree mount when project mount is disabled', async () => {
    const runtime = createMockSandboxRuntime()
    const logger = createMockLogger()
    const config: SandboxManagerConfig = {
      image: 'oc-forge-sandbox:latest',
      sourceProjectDir: '/main-project',
      mountProjectReadonly: false,
    }

    const manager = createSandboxManager(runtime, config, logger)
    await manager.start('test', '/home/user/worktrees/feature')

    const active = manager.getActive('test')
    expect(active?.mounts).toHaveLength(1)
    expect(active?.mounts[0]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/home/user/worktrees/feature' })
  })

  describe('reconnect paths', () => {
    test('start() with already-running sandbox preserves project mount in mounts list', async () => {
      const runtime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        sourceProjectDir: '/tmp',
        mountProjectReadonly: true,
      }

      const manager = createSandboxManager(runtime, config, logger)

      // Start sandbox first (creates it)
      await manager.start('test', '/home/user/worktrees/feature')
      expect(runtime.getCreateSandboxCalls().length).toBe(1)

      // Simulate reconnect: sandbox already running
      const result = await manager.start('test', '/home/user/worktrees/feature')

      // Should not have created a new sandbox
      expect(runtime.getCreateSandboxCalls().length).toBe(1)
      // Mounts should include both worktree and project
      const active = manager.getActive('test')
      expect(active?.mounts).toHaveLength(2)
      expect(active?.mounts[0]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/home/user/worktrees/feature' })
      expect(active?.mounts[1]).toEqual({ hostDir: '/tmp', containerDir: '/tmp', readOnly: true })
    })

    test('start() with already-running sandbox does not add project mount when disabled', async () => {
      const runtime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        sourceProjectDir: '/tmp',
        mountProjectReadonly: false,
      }

      const manager = createSandboxManager(runtime, config, logger)

      await manager.start('test', '/home/user/worktrees/feature')
      await manager.start('test', '/home/user/worktrees/feature')

      const active = manager.getActive('test')
      expect(active?.mounts).toHaveLength(1)
      expect(active?.mounts[0]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/home/user/worktrees/feature' })
    })

    test('restore() with already-running sandbox preserves project mount in mounts list', async () => {
      const runtime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        sourceProjectDir: '/tmp',
        mountProjectReadonly: true,
      }

      const manager = createSandboxManager(runtime, config, logger)

      // Simulate sandbox already running (e.g. after plugin restart)
      runtime.setRunning('forge-foo', true)
      await manager.restore('foo', '/home/user/worktrees/feature', '2025-01-01T00:00:00.000Z')

      // Should not have created a new sandbox
      expect(runtime.getCreateSandboxCalls().length).toBe(0)
      // Mounts should include both worktree and project
      const active = manager.getActive('foo')
      expect(active?.mounts).toHaveLength(2)
      expect(active?.mounts[0]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/home/user/worktrees/feature' })
      expect(active?.mounts[1]).toEqual({ hostDir: '/tmp', containerDir: '/tmp', readOnly: true })
    })

    test('restore() with already-running sandbox does not add project mount when disabled', async () => {
      const runtime = createMockSandboxRuntime()
      const logger = createMockLogger()
      const config: SandboxManagerConfig = {
        image: 'oc-forge-sandbox:latest',
        sourceProjectDir: '/main-project',
        mountProjectReadonly: false,
      }

      const manager = createSandboxManager(runtime, config, logger)

      runtime.setRunning('forge-foo', true)
      await manager.restore('foo', '/home/user/worktrees/feature', '2025-01-01T00:00:00.000Z')

      const active = manager.getActive('foo')
      expect(active?.mounts).toHaveLength(1)
      expect(active?.mounts[0]).toEqual({ hostDir: '/home/user/worktrees/feature', containerDir: '/home/user/worktrees/feature' })
    })
  })
})
