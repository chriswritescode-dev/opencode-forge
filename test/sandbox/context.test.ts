import { describe, it, expect, vi } from 'vitest'
import { isSandboxEnabled, resolveSandboxContextForLoop } from '../../src/sandbox/context'
import type { SandboxMount } from '../../src/sandbox/path'

describe('isSandboxEnabled', () => {
  it('returns true when sandboxManager is provided regardless of legacy mode value', () => {
    expect(isSandboxEnabled({ sandbox: { mode: 'docker' as const } }, {} as unknown)).toBe(true)
  })

  it('returns false when sandboxManager is missing', () => {
    expect(isSandboxEnabled({ sandbox: { mode: 'docker' as const } }, undefined)).toBe(false)
  })

  it('returns false when sandbox config is absent', () => {
    expect(isSandboxEnabled({}, undefined)).toBe(false)
  })
})

describe('resolveSandboxContextForLoop', () => {
  it('returns the active sandbox context', async () => {
    const mounts: SandboxMount[] = [{ hostDir: '/worktree', containerDir: '/workspace' }]
    const manager = {
      docker: {} as never,
      restore: vi.fn(),
      ensureRunning: vi.fn().mockResolvedValue('forge-loop'),
      getActive: vi.fn().mockReturnValue({ containerName: 'forge-loop', projectDir: '/worktree', mounts }),
    }

    const context = await resolveSandboxContextForLoop(manager, {
      loopName: 'loop',
      active: true,
      sandbox: true,
      worktreeDir: '/worktree',
    })

    expect(context).toEqual({ docker: manager.docker, containerName: 'forge-loop', hostDir: '/worktree', mounts })
    expect(manager.ensureRunning).toHaveBeenCalledWith('loop', '/worktree')
  })

  it('returns null without calling ensureRunning when no worktreeDir', async () => {
    const mounts: SandboxMount[] = [{ hostDir: '/worktree', containerDir: '/workspace' }]
    const manager = {
      docker: {} as never,
      restore: vi.fn(),
      ensureRunning: vi.fn(),
      getActive: vi.fn().mockReturnValue({ containerName: 'forge-loop', projectDir: '/worktree', mounts }),
    }

    const context = await resolveSandboxContextForLoop(manager, {
      loopName: 'loop',
      active: true,
      sandbox: true,
    })

    expect(context).toEqual({ docker: manager.docker, containerName: 'forge-loop', hostDir: '/worktree', mounts })
    expect(manager.ensureRunning).not.toHaveBeenCalled()
  })

  it('returns null after ensureRunning failure unless configured to throw', async () => {
    const logger = { log: vi.fn() }
    const manager = {
      docker: {} as never,
      restore: vi.fn(),
      ensureRunning: vi.fn().mockRejectedValue(new Error('docker unavailable')),
      getActive: vi.fn().mockReturnValue(null),
    }

    const context = await resolveSandboxContextForLoop(manager, {
      loopName: 'loop',
      active: true,
      sandbox: true,
      worktreeDir: '/worktree',
    }, logger)

    expect(context).toBeNull()
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('docker unavailable'))
    await expect(resolveSandboxContextForLoop(manager, {
      loopName: 'loop',
      active: true,
      sandbox: true,
      worktreeDir: '/worktree',
    }, logger, { throwOnRestoreError: true })).rejects.toThrow('docker unavailable')
  })
})
