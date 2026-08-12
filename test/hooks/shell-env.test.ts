import { describe, test, expect, vi } from 'vitest'
import { createShellEnvHook } from '../../src/hooks/shell-env'
import { SHIM_ENV_CONTAINER, SHIM_ENV_HOST_SHELL } from '../../src/sandbox/shell-shim'
import type { Logger } from '../../src/types'
import type { SandboxContext } from '../../src/sandbox/context'

const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

function makeSandboxContext(overrides: Partial<SandboxContext> = {}): SandboxContext {
  return {
    runtime: {} as never,
    containerName: 'forge-loop-a',
    hostDir: '/wt',
    mounts: [],
    ...overrides,
  }
}

describe('createShellEnvHook', () => {
  test('injects the container name when a sandbox context is resolved', async () => {
    const hook = createShellEnvHook({
      resolveSandboxForSession: vi.fn(async () =>
        makeSandboxContext({
          containerName: 'forge-loop-a',
          hostDir: '/wt',
        }),
      ),
      getUserConfiguredShell: () => undefined,
      logger,
    })
    const output = { env: {} as Record<string, string> }

    await hook({ cwd: '/wt', sessionID: 'ses_1' }, output)

    expect(output.env[SHIM_ENV_CONTAINER]).toBe('forge-loop-a')
    expect(output.env[SHIM_ENV_HOST_SHELL]).toBeUndefined()
  })

  test('injects nothing container-related when no sandbox is resolved', async () => {
    const hook = createShellEnvHook({
      resolveSandboxForSession: vi.fn(async () => null),
      getUserConfiguredShell: () => undefined,
      logger,
    })
    const output = { env: {} as Record<string, string> }

    await hook({ cwd: '/anywhere', sessionID: 'ses_host' }, output)

    expect(output.env).toEqual({})
  })

  test('restores the user-configured shell for non-sandbox sessions', async () => {
    const hook = createShellEnvHook({
      resolveSandboxForSession: vi.fn(async () => null),
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
      resolveSandboxForSession: vi.fn(async () => null),
      getUserConfiguredShell: () => undefined,
      logger,
    })
    const output = { env: {} as Record<string, string> }

    await hook({ cwd: '/wt', sessionID: 'ses_2' }, output)

    expect(output.env).toEqual({})
  })

  test('propagates a resolver rejection when the expected sandbox cannot be resolved', async () => {
    const hook = createShellEnvHook({
      resolveSandboxForSession: vi.fn(async () => {
        throw new Error('Sandbox container for loop "loop-c" is unavailable; refusing to run the command on the host.')
      }),
      getUserConfiguredShell: () => '/bin/zsh',
      logger,
    })
    const output = { env: {} as Record<string, string> }

    await expect(hook({ cwd: '/wt', sessionID: 'ses_3' }, output)).rejects.toThrow(/refusing to run the command on the host/)
    expect(output.env).toEqual({})
  })

  test('propagates a resolver rejection when container restore throws', async () => {
    const hook = createShellEnvHook({
      resolveSandboxForSession: vi.fn(async () => {
        throw new Error('docker down')
      }),
      getUserConfiguredShell: () => undefined,
      logger,
    })
    const output = { env: {} as Record<string, string> }

    await expect(hook({ cwd: '/wt', sessionID: 'ses_4' }, output)).rejects.toThrow('docker down')
    expect(output.env).toEqual({})
  })

  test('requests fail-closed resolution with throwOnRestoreError', async () => {
    const resolve = vi.fn(async () => null)
    const hook = createShellEnvHook({
      resolveSandboxForSession: resolve,
      getUserConfiguredShell: () => undefined,
      logger,
    })
    const output = { env: {} as Record<string, string> }

    await hook({ cwd: '/wt', sessionID: 'ses_5' }, output)

    expect(resolve).toHaveBeenCalledWith('ses_5', { throwOnRestoreError: true })
  })

  test('no sessionID falls through to host shell handling', async () => {
    const resolve = vi.fn(async () => null)
    const hook = createShellEnvHook({
      resolveSandboxForSession: resolve,
      getUserConfiguredShell: () => '/bin/bash',
      logger,
    })
    const output = { env: {} as Record<string, string> }

    await hook({ cwd: '/x' }, output)

    expect(resolve).not.toHaveBeenCalled()
    expect(output.env[SHIM_ENV_HOST_SHELL]).toBe('/bin/bash')
  })
})
