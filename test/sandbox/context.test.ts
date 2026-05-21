import { describe, it, expect, vi } from 'vitest'
import { isSandboxEnabled, resolveSandboxContextForLoop } from '../../src/sandbox/context'

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
  it('returns the active sandbox context without restoring', async () => {
    const manager = {
      docker: {} as never,
      restore: vi.fn(),
      getActive: vi.fn().mockReturnValue({ containerName: 'forge-loop', projectDir: '/worktree' }),
    }

    const context = await resolveSandboxContextForLoop(manager, {
      loopName: 'loop',
      active: true,
      sandbox: true,
      worktreeDir: '/worktree',
    })

    expect(context).toEqual({ docker: manager.docker, containerName: 'forge-loop', hostDir: '/worktree' })
    expect(manager.restore).not.toHaveBeenCalled()
  })

  it('restores the sandbox map when a sandbox loop has a running container not in memory', async () => {
    const manager = {
      docker: {} as never,
      restore: vi.fn().mockResolvedValue(undefined),
      getActive: vi.fn()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce({ containerName: 'forge-loop', projectDir: '/worktree' }),
    }

    const context = await resolveSandboxContextForLoop(manager, {
      loopName: 'loop',
      active: true,
      sandbox: true,
      worktreeDir: '/worktree',
    })

    expect(manager.restore).toHaveBeenCalledWith('loop', '/worktree', expect.any(String))
    expect(context).toEqual({ docker: manager.docker, containerName: 'forge-loop', hostDir: '/worktree' })
  })

  it('returns null after restore failure unless configured to throw', async () => {
    const logger = { log: vi.fn() }
    const manager = {
      docker: {} as never,
      restore: vi.fn().mockRejectedValue(new Error('docker unavailable')),
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
