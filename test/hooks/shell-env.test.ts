import { describe, test, expect, vi } from 'vitest'
import { createShellEnvHook } from '../../src/hooks/shell-env'
import { SHIM_ENV_CONTAINER, SHIM_ENV_EXEC_USER, SHIM_ENV_HOST_SHELL } from '../../src/sandbox/shell-shim'
import type { Logger } from '../../src/types'

const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

function makeSandboxManager(active: { containerName: string; projectDir: string } | null, opts?: { ensureRunningError?: Error }) {
  return {
    docker: {} as never,
    restore: vi.fn(async () => {}),
    getActive: vi.fn(() => (active ? { ...active, mounts: [] } : null)),
    ensureRunning: vi.fn(async () => {
      if (opts?.ensureRunningError) throw opts.ensureRunningError
      return active?.containerName ?? ''
    }),
  }
}

describe('createShellEnvHook', () => {
  test('injects container and exec user for an active sandbox loop session', async () => {
    const hook = createShellEnvHook({
      resolveActiveLoopForSession: vi.fn(async () => ({ loopName: 'loop-a', active: true, sandbox: true, worktreeDir: '/wt' })),
      sandboxManager: makeSandboxManager({ containerName: 'forge-loop-a', projectDir: '/wt' }),
      execUser: '501:20',
      getUserConfiguredShell: () => undefined,
      logger,
    })
    const output = { env: {} as Record<string, string> }

    await hook({ cwd: '/wt', sessionID: 'ses_1' }, output)

    expect(output.env[SHIM_ENV_CONTAINER]).toBe('forge-loop-a')
    expect(output.env[SHIM_ENV_EXEC_USER]).toBe('501:20')
    expect(output.env[SHIM_ENV_HOST_SHELL]).toBeUndefined()
  })

  test('injects nothing container-related for a non-loop session', async () => {
    const hook = createShellEnvHook({
      resolveActiveLoopForSession: vi.fn(async () => null),
      sandboxManager: makeSandboxManager({ containerName: 'forge-x', projectDir: '/wt' }),
      execUser: '501:20',
      getUserConfiguredShell: () => undefined,
      logger,
    })
    const output = { env: {} as Record<string, string> }

    await hook({ cwd: '/anywhere', sessionID: 'ses_host' }, output)

    expect(output.env).toEqual({})
  })

  test('restores the user-configured shell for non-sandbox sessions', async () => {
    const hook = createShellEnvHook({
      resolveActiveLoopForSession: vi.fn(async () => null),
      sandboxManager: null,
      getUserConfiguredShell: () => '/opt/homebrew/bin/fish',
      logger,
    })
    const output = { env: {} as Record<string, string> }

    await hook({ cwd: '/anywhere', sessionID: 'ses_host' }, output)

    expect(output.env[SHIM_ENV_HOST_SHELL]).toBe('/opt/homebrew/bin/fish')
    expect(output.env[SHIM_ENV_CONTAINER]).toBeUndefined()
  })

  test('worktree-only loop sessions fall through to the host shell branch', async () => {
    const hook = createShellEnvHook({
      resolveActiveLoopForSession: vi.fn(async () => ({ loopName: 'loop-b', active: true, sandbox: false })),
      sandboxManager: makeSandboxManager(null),
      getUserConfiguredShell: () => undefined,
      logger,
    })
    const output = { env: {} as Record<string, string> }

    await hook({ cwd: '/wt', sessionID: 'ses_2' }, output)

    expect(output.env).toEqual({})
  })

  test('fails closed when the sandbox container cannot be resolved for an active sandbox loop', async () => {
    const hook = createShellEnvHook({
      resolveActiveLoopForSession: vi.fn(async () => ({ loopName: 'loop-c', active: true, sandbox: true, worktreeDir: '/wt' })),
      sandboxManager: makeSandboxManager(null),
      getUserConfiguredShell: () => '/bin/zsh',
      logger,
    })
    const output = { env: {} as Record<string, string> }

    await expect(hook({ cwd: '/wt', sessionID: 'ses_3' }, output)).rejects.toThrow(/refusing to run the command on the host/)
    expect(output.env).toEqual({})
  })

  test('fails closed when container restore throws', async () => {
    const hook = createShellEnvHook({
      resolveActiveLoopForSession: vi.fn(async () => ({ loopName: 'loop-d', active: true, sandbox: true, worktreeDir: '/wt' })),
      sandboxManager: makeSandboxManager({ containerName: 'forge-loop-d', projectDir: '/wt' }, { ensureRunningError: new Error('docker down') }),
      getUserConfiguredShell: () => undefined,
      logger,
    })
    const output = { env: {} as Record<string, string> }

    await expect(hook({ cwd: '/wt', sessionID: 'ses_4' }, output)).rejects.toThrow('docker down')
    expect(output.env).toEqual({})
  })

  test('no sessionID falls through to host shell handling', async () => {
    const resolve = vi.fn(async () => null)
    const hook = createShellEnvHook({
      resolveActiveLoopForSession: resolve,
      sandboxManager: null,
      getUserConfiguredShell: () => '/bin/bash',
      logger,
    })
    const output = { env: {} as Record<string, string> }

    await hook({ cwd: '/x' }, output)

    expect(resolve).not.toHaveBeenCalled()
    expect(output.env[SHIM_ENV_HOST_SHELL]).toBe('/bin/bash')
  })
})
