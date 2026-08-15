import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  SANDBOX_CONTEXT_NOTE,
  SANDBOX_OFF_NOTE,
  isSandboxEnabled,
  isSandboxConfigEnabled,
  resolveSandboxContextForLoop,
  resolveSandboxMountConfigs,
} from '../../src/sandbox/context'
import { resolveCustomMounts } from '../../src/sandbox/manager'
import { createMockLogger } from '../helpers/sandbox-mocks'
import type { SandboxMount } from '../../src/sandbox/path'

describe('SANDBOX_CONTEXT_NOTE', () => {
  it('keeps the container-routing caveat and gives accurate lifetime/scratch guidance', () => {
    expect(SANDBOX_CONTEXT_NOTE).toContain('bash tool commands execute in that container, not on the host')
    expect(SANDBOX_CONTEXT_NOTE).toContain('foreground')
    expect(SANDBOX_CONTEXT_NOTE).toMatch(/timeout/i)
    expect(SANDBOX_CONTEXT_NOTE).toMatch(/reboots/i)
    expect(SANDBOX_CONTEXT_NOTE).toContain('files on disk')
    expect(SANDBOX_CONTEXT_NOTE).not.toContain('stops shortly after each command')
  })

  it('does not name any specific scratch directory (agents use opencode\'s advertised default)', () => {
    expect(SANDBOX_CONTEXT_NOTE).not.toContain('/tmp/oc-forge')
  })

  it('requires installing missing or incompatible environment tooling rather than focusing on code alone', () => {
    expect(SANDBOX_CONTEXT_NOTE).not.toContain('Focus on what the code does')
    expect(SANDBOX_CONTEXT_NOTE).not.toContain('false positives')
    expect(SANDBOX_CONTEXT_NOTE).toMatch(/missing or incompatible/i)
    expect(SANDBOX_CONTEXT_NOTE).toMatch(/install or reinstall/i)
    expect(SANDBOX_CONTEXT_NOTE).toMatch(/rerun the intended checks/i)
    expect(SANDBOX_CONTEXT_NOTE).toMatch(/not misreport/i)
  })
})

describe('SANDBOX_OFF_NOTE', () => {
  it('warns that execution returned to the host and container state must not be assumed available', () => {
    expect(SANDBOX_OFF_NOTE).toMatch(/returned to the host/i)
    expect(SANDBOX_OFF_NOTE).toMatch(/must not be assumed/i)
    expect(SANDBOX_OFF_NOTE).toMatch(/tools, packages, processes/i)
    expect(SANDBOX_OFF_NOTE).toMatch(/in-memory state/i)
  })

  it('tells the agent to install or reinstall required host tooling before rerunning checks', () => {
    expect(SANDBOX_OFF_NOTE).toMatch(/install or reinstall/i)
    expect(SANDBOX_OFF_NOTE).toMatch(/host tooling/i)
    expect(SANDBOX_OFF_NOTE).toMatch(/rerun/i)
  })
})

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

  it('returns false when sandbox is explicitly disabled even if a manager is present', () => {
    expect(isSandboxEnabled({ sandbox: { mode: 'docker' as const, enabled: false } }, {} as unknown)).toBe(false)
  })

  it('returns true when sandbox is explicitly enabled and a manager is present', () => {
    expect(isSandboxEnabled({ sandbox: { mode: 'docker' as const, enabled: true } }, {} as unknown)).toBe(true)
  })

  it('tolerates an undefined config', () => {
    expect(isSandboxEnabled(undefined, {} as unknown)).toBe(true)
    expect(isSandboxEnabled(undefined, undefined)).toBe(false)
  })
})

describe('isSandboxConfigEnabled', () => {
  it('is true by default (config absent or enabled not set)', () => {
    expect(isSandboxConfigEnabled(undefined)).toBe(true)
    expect(isSandboxConfigEnabled({})).toBe(true)
    expect(isSandboxConfigEnabled({ sandbox: { mode: 'docker' as const } })).toBe(true)
  })

  it('is false only when explicitly disabled', () => {
    expect(isSandboxConfigEnabled({ sandbox: { mode: 'docker' as const, enabled: false } })).toBe(false)
    expect(isSandboxConfigEnabled({ sandbox: { mode: 'docker' as const, enabled: true } })).toBe(true)
  })
})

describe('resolveSandboxMountConfigs', () => {
  it('is empty when neither sandbox.mounts nor loop.allowExternalDirectories is set', () => {
    expect(resolveSandboxMountConfigs(undefined)).toEqual([])
    expect(resolveSandboxMountConfigs({})).toEqual([])
  })

  it('mounts loop.allowExternalDirectories read-only so container search sees what host read sees', () => {
    expect(resolveSandboxMountConfigs({ loop: { allowExternalDirectories: ['/vault', '/notes'] } })).toEqual([
      { host: '/vault', readonly: true },
      { host: '/notes', readonly: true },
    ])
  })

  it('lists explicit sandbox.mounts first so a user entry wins the resolver collision check', () => {
    const vault = mkdtempSync(join(tmpdir(), 'forge-allow-external-'))
    try {
      const resolved = resolveSandboxMountConfigs({
        sandbox: { mounts: [{ host: vault, readonly: false }] },
        loop: { allowExternalDirectories: [vault] },
      })
      expect(resolved).toEqual([
        { host: vault, readonly: false },
        { host: vault, readonly: true },
      ])
      expect(resolveCustomMounts(resolved, new Set(), createMockLogger())).toEqual([
        { hostDir: resolve(vault), containerDir: resolve(vault), readOnly: false },
      ])
    } finally {
      rmSync(vault, { recursive: true, force: true })
    }
  })
})

describe('resolveSandboxContextForLoop', () => {
  it('returns the active sandbox context', async () => {
    const mounts: SandboxMount[] = [{ hostDir: '/worktree', containerDir: '/worktree' }]
    const manager = {
      runtime: {} as never,
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

    expect(context).toEqual({ runtime: manager.runtime, containerName: 'forge-loop', hostDir: '/worktree', mounts })
    expect(manager.ensureRunning).toHaveBeenCalledWith('loop', '/worktree')
  })

  it('returns null without calling ensureRunning when no worktreeDir', async () => {
    const mounts: SandboxMount[] = [{ hostDir: '/worktree', containerDir: '/worktree' }]
    const manager = {
      runtime: {} as never,
      restore: vi.fn(),
      ensureRunning: vi.fn(),
      getActive: vi.fn().mockReturnValue({ containerName: 'forge-loop', projectDir: '/worktree', mounts }),
    }

    const context = await resolveSandboxContextForLoop(manager, {
      loopName: 'loop',
      active: true,
      sandbox: true,
    })

    expect(context).toEqual({ runtime: manager.runtime, containerName: 'forge-loop', hostDir: '/worktree', mounts })
    expect(manager.ensureRunning).not.toHaveBeenCalled()
  })

  it('returns null after ensureRunning failure unless configured to throw', async () => {
    const logger = { log: vi.fn(), error: vi.fn() }
    const manager = {
      runtime: {} as never,
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
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('docker unavailable'))
    await expect(resolveSandboxContextForLoop(manager, {
      loopName: 'loop',
      active: true,
      sandbox: true,
      worktreeDir: '/worktree',
    }, logger, { throwOnRestoreError: true })).rejects.toThrow('docker unavailable')
  })
})
