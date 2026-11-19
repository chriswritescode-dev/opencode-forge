import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  MACOS_SANDBOX_CONTEXT_NOTE,
  SANDBOX_CONTEXT_NOTE,
  SANDBOX_OFF_NOTE,
  SANDBOX_SWITCHED_ON_NOTE,
  buildSandboxContextNote,
  buildSandboxOffNote,
  formatSwitchArtifactsLine,
  isSandboxEnabled,
  isSandboxConfigEnabled,
  isHostSessionsDefaultEnabled,
  resolveSandboxContextForLoop,
  resolveSandboxMountConfigs,
} from '../../src/sandbox/context'
import { resolveCustomMounts } from '../../src/sandbox/manager'
import { SANDBOX_CACHE_DIR, SANDBOX_WORKSPACE_QUOTA } from '../../src/sandbox/msb'
import { createMockLogger } from '../helpers/logger'
import type { SandboxMount } from '../../src/sandbox/path'

describe('SANDBOX_CONTEXT_NOTE', () => {
  it('keeps the container-routing caveat and asserts no unconfigured sandbox lifetime behavior', () => {
    expect(SANDBOX_CONTEXT_NOTE).toContain('bash tool commands execute in that container, not on the host')
    expect(SANDBOX_CONTEXT_NOTE).not.toContain('stops shortly after each command')
    // Forge never passes msb's opt-in `--idle-timeout`, so sandboxes do not stop themselves
    // while idle; only explicit forge lifecycle stops and host restarts end a sandbox.
    expect(SANDBOX_CONTEXT_NOTE).not.toMatch(/while idle/i)
    expect(SANDBOX_CONTEXT_NOTE).not.toMatch(/reboots/i)
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

  it('advertises the in-image tooling an agent cannot discover on its own', () => {
    expect(SANDBOX_CONTEXT_NOTE).toContain('forge-dockerd-start')
    expect(SANDBOX_CONTEXT_NOTE).toContain('Chromium (Playwright\'s browser build) is installed as chromium for headless browser automation; launch it with chromium --headless --no-sandbox --disable-dev-shm-usage.')
    expect(SANDBOX_CONTEXT_NOTE).toContain(`mounted at ${SANDBOX_CACHE_DIR}`)
    expect(SANDBOX_CONTEXT_NOTE).toContain('run forge-cache-prune to reclaim space when the disk fills')
    expect(SANDBOX_CONTEXT_NOTE).toMatch(/preserving installed toolchains/)
    expect(SANDBOX_CONTEXT_NOTE).not.toMatch(/re-downloadable/i)
  })

  it('explains the workspace guest-write quota so df and ENOSPC are not mistaken for the host disk', () => {
    expect(SANDBOX_CONTEXT_NOTE).toContain(`guest-write quota of ${SANDBOX_WORKSPACE_QUOTA}`)
    expect(SANDBOX_CONTEXT_NOTE).toContain('df on it reports that budget rather than the host disk')
    expect(SANDBOX_CONTEXT_NOTE).toContain('No space left on device')
    expect(SANDBOX_CONTEXT_NOTE).toContain('ask the user to recreate the sandbox')
  })
})

describe('MACOS_SANDBOX_CONTEXT_NOTE', () => {
  it('describes the shared macOS VM and its limits', () => {
    expect(MACOS_SANDBOX_CONTEXT_NOTE).toContain('shared macOS virtual machine')
    expect(MACOS_SANDBOX_CONTEXT_NOTE).toContain('bash, glob, and grep execute there')
    expect(MACOS_SANDBOX_CONTEXT_NOTE).toContain('never stop processes you did not start')
    expect(MACOS_SANDBOX_CONTEXT_NOTE).toContain('Homebrew')
    expect(MACOS_SANDBOX_CONTEXT_NOTE).toContain('Network egress is limited to the configured allow-list')
    expect(MACOS_SANDBOX_CONTEXT_NOTE).toContain('owned by the host user')
  })

  it('omits the container-only tooling guidance', () => {
    expect(MACOS_SANDBOX_CONTEXT_NOTE).not.toContain('forge-dockerd-start')
    expect(MACOS_SANDBOX_CONTEXT_NOTE).not.toContain('forge-cache-prune')
    expect(MACOS_SANDBOX_CONTEXT_NOTE).not.toContain(SANDBOX_CACHE_DIR)
    expect(MACOS_SANDBOX_CONTEXT_NOTE).not.toContain(SANDBOX_WORKSPACE_QUOTA)
    expect(MACOS_SANDBOX_CONTEXT_NOTE).not.toMatch(/chromium/i)
    expect(MACOS_SANDBOX_CONTEXT_NOTE).not.toMatch(/docker/i)
    expect(MACOS_SANDBOX_CONTEXT_NOTE).not.toMatch(/\bapt\b/i)
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

describe('buildSandboxContextNote', () => {
  const settings = { cpus: 4, memoryMib: 8192, allowLan: false }

  it('announces a switch with the transition, the switch artifacts warning, the switched-on note, settings, and the container guidance', () => {
    const note = buildSandboxContextNote(
      { switched: true, from: 'Darwin 24.6.0 arm64', to: 'Linux 6.1.0 aarch64' },
      { settings, change: 'recreated' },
    )

    expect(note.split('\n').slice(0, 4)).toEqual([
      '[Sandbox] Environment changed: host (Darwin 24.6.0 arm64) -> container (Linux 6.1.0 aarch64).',
      formatSwitchArtifactsLine('host', 'container'),
      SANDBOX_SWITCHED_ON_NOTE,
      '[Sandbox] Resources: 4 CPUs, 8 GiB memory. LAN (private network) access: blocked.',
    ])
    expect(note).toContain(SANDBOX_CONTEXT_NOTE)
    expect(note).not.toContain('was recreated')
  })

  it('still announces the switch when neither environment could be probed', () => {
    const note = buildSandboxContextNote({ switched: true, from: null, to: null })

    expect(note).not.toContain('Environment changed')
    expect(note.split('\n')[0]).toBe(formatSwitchArtifactsLine('host', 'container'))
    expect(note.split('\n')[1]).toBe(SANDBOX_SWITCHED_ON_NOTE)
    expect(note).toContain(SANDBOX_CONTEXT_NOTE)
  })

  it('reports a partially probed switch with an unknown side', () => {
    const note = buildSandboxContextNote({ switched: true, from: null, to: 'Linux 6.1.0 aarch64' })

    expect(note.split('\n')[0]).toBe(
      '[Sandbox] Environment changed: host (unknown) -> container (Linux 6.1.0 aarch64).'
    )
    expect(note).toContain(SANDBOX_SWITCHED_ON_NOTE)
  })

  it('describes steady state with the container environment, a change, settings, and the guidance', () => {
    const note = buildSandboxContextNote({ switched: false, to: 'Linux 6.1.0 aarch64' }, { settings, change: 'restarted' })

    expect(note.split('\n').slice(0, 3)).toEqual([
      '[Sandbox] Environment: container (Linux 6.1.0 aarch64).',
      '[Sandbox] The sandbox was restarted to apply new resource settings. Its files and disks are unchanged, but processes started earlier (including the Docker daemon and any containers) are no longer running; restart the ones you still need.',
      '[Sandbox] Resources: 4 CPUs, 8 GiB memory. LAN (private network) access: blocked.',
    ])
    expect(note).toContain(SANDBOX_CONTEXT_NOTE)
    expect(note).not.toContain('Environment changed')
    expect(note).not.toContain(SANDBOX_SWITCHED_ON_NOTE)
    expect(note).not.toContain('just switched')
  })

  it('omits the container line in steady state when the container probe is null', () => {
    const note = buildSandboxContextNote({ switched: false, to: null })

    expect(note.split('\n')[0]).not.toContain('[Sandbox] Environment:')
    expect(note.split('\n')[0]).toBe('[Sandbox] This session runs inside a container: bash tool commands execute in that container, not on the host. OS-specific commands or tools may differ from the host system.')
    expect(note).toContain(SANDBOX_CONTEXT_NOTE)
  })

  it('announces a switch to the macOS VM with the macOS labels and guidance', () => {
    const note = buildSandboxContextNote(
      { switched: true, from: null, to: 'macOS 15.6 arm64' },
      { settings, kind: 'macos' },
    )

    expect(note.split('\n').slice(0, 4)).toEqual([
      '[Sandbox] Environment changed: host (unknown) -> macOS VM (macOS 15.6 arm64).',
      formatSwitchArtifactsLine('host', 'macOS VM'),
      SANDBOX_SWITCHED_ON_NOTE,
      '[Sandbox] Resources: 4 CPUs, 8 GiB memory. LAN (private network) access: blocked.',
    ])
    expect(note).toContain(MACOS_SANDBOX_CONTEXT_NOTE)
    expect(note).not.toContain(SANDBOX_CONTEXT_NOTE)
  })

  it('describes macOS steady state with the macOS VM label', () => {
    const note = buildSandboxContextNote({ switched: false, to: 'macOS 15.6 arm64' }, { settings, kind: 'macos' })

    expect(note.split('\n')[0]).toBe('[Sandbox] Environment: macOS VM (macOS 15.6 arm64).')
    expect(note).toContain(MACOS_SANDBOX_CONTEXT_NOTE)
  })

  it('keeps msb output byte-identical whether or not the kind is passed', () => {
    const environment = { switched: true, from: 'Darwin 24.6.0 arm64', to: 'Linux 6.1.0 aarch64' } as const
    const options = { settings, change: 'restarted' as const }

    expect(buildSandboxContextNote(environment, { ...options, kind: 'msb' })).toBe(
      buildSandboxContextNote(environment, options),
    )
    expect(buildSandboxContextNote({ switched: false, to: null }, { ...options, kind: 'msb' })).toBe(
      buildSandboxContextNote({ switched: false, to: null }, options),
    )
  })
})

describe('buildSandboxOffNote', () => {
  it('leads with the container -> host switch artifacts line when a transition is known', () => {
    const note = buildSandboxOffNote({ from: 'Linux 6.1.0 aarch64', to: 'Darwin 24.6.0 arm64' })

    expect(note.split('\n').slice(0, 3)).toEqual([
      '[Sandbox] Environment changed: container (Linux 6.1.0 aarch64) -> host (Darwin 24.6.0 arm64).',
      formatSwitchArtifactsLine('container', 'host'),
      SANDBOX_OFF_NOTE.split('\n')[0],
    ])
    expect(note).toContain(SANDBOX_OFF_NOTE)
  })

  it('starts with the container -> host switch artifacts line when no transition is known', () => {
    const note = buildSandboxOffNote()

    expect(note.split('\n')[0]).toBe(formatSwitchArtifactsLine('container', 'host'))
    expect(note).toContain(SANDBOX_OFF_NOTE)
  })

  it('names the macOS VM as the sandbox side of the switch', () => {
    const note = buildSandboxOffNote({ from: 'macOS 15.6 arm64', to: 'Darwin 24.6.0 arm64' }, { kind: 'macos' })

    expect(note.split('\n').slice(0, 3)).toEqual([
      '[Sandbox] Environment changed: macOS VM (macOS 15.6 arm64) -> host (Darwin 24.6.0 arm64).',
      formatSwitchArtifactsLine('macOS VM', 'host'),
      SANDBOX_OFF_NOTE.split('\n')[0],
    ])
    expect(note).toContain(SANDBOX_OFF_NOTE)
  })
})

describe('formatSwitchArtifactsLine', () => {
  it('names the switch and tells the agent to delete and reinstall dependency directories', () => {
    expect(formatSwitchArtifactsLine('host', 'container')).toBe(
      '[Sandbox] The environment just switched from the host to the container. Dependency directories and native build output already in the shared project directory (for example node_modules) were most likely installed for the host and will not work in the container: delete them and reinstall or rebuild before running builds, tests, or the app.',
    )
  })
})

describe('shared workspace artifacts', () => {
  it.each([
    ['SANDBOX_CONTEXT_NOTE', SANDBOX_CONTEXT_NOTE],
    ['SANDBOX_OFF_NOTE', SANDBOX_OFF_NOTE],
  ])('%s tells the agent to delete and rebuild dependency output from the other environment', (_, note) => {
    expect(note).toMatch(/project directory is shared/i)
    expect(note).toMatch(/node_modules/)
    expect(note).toMatch(/delete them and reinstall or rebuild/i)
  })
})

describe('isSandboxEnabled', () => {
  it('returns true when sandboxManager is provided regardless of legacy mode value', () => {
    expect(isSandboxEnabled({ sandbox: { mode: 'msb' as const } }, {} as unknown)).toBe(true)
  })

  it('returns false when sandboxManager is missing', () => {
    expect(isSandboxEnabled({ sandbox: { mode: 'msb' as const } }, undefined)).toBe(false)
  })

  it('returns false when sandbox config is absent', () => {
    expect(isSandboxEnabled({}, undefined)).toBe(false)
  })

  it('returns false when sandbox is explicitly disabled even if a manager is present', () => {
    expect(isSandboxEnabled({ sandbox: { mode: 'msb' as const, enabled: false } }, {} as unknown)).toBe(false)
  })

  it('returns true when sandbox is explicitly enabled and a manager is present', () => {
    expect(isSandboxEnabled({ sandbox: { mode: 'msb' as const, enabled: true } }, {} as unknown)).toBe(true)
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
    expect(isSandboxConfigEnabled({ sandbox: { mode: 'msb' as const } })).toBe(true)
  })

  it('is false only when explicitly disabled', () => {
    expect(isSandboxConfigEnabled({ sandbox: { mode: 'msb' as const, enabled: false } })).toBe(false)
    expect(isSandboxConfigEnabled({ sandbox: { mode: 'msb' as const, enabled: true } })).toBe(true)
  })
})

describe('isHostSessionsDefaultEnabled', () => {
  it('is on by default (config absent or hostSessions not set)', () => {
    expect(isHostSessionsDefaultEnabled(undefined)).toBe(true)
    expect(isHostSessionsDefaultEnabled({})).toBe(true)
    expect(isHostSessionsDefaultEnabled({ sandbox: { mode: 'msb' as const } })).toBe(true)
    expect(isHostSessionsDefaultEnabled({ sandbox: { mode: 'msb' as const, hostSessions: true } })).toBe(true)
  })

  it('is off when hostSessions is explicitly disabled', () => {
    expect(isHostSessionsDefaultEnabled({ sandbox: { mode: 'msb' as const, hostSessions: false } })).toBe(false)
  })

  it('is off when sandboxing itself is disabled, even without an explicit hostSessions value', () => {
    expect(isHostSessionsDefaultEnabled({ sandbox: { mode: 'msb' as const, enabled: false } })).toBe(false)
    expect(isHostSessionsDefaultEnabled({ sandbox: { mode: 'msb' as const, enabled: false, hostSessions: true } })).toBe(false)
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
    const logger = createMockLogger()
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
