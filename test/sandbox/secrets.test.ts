import { describe, test, expect, afterEach } from 'vitest'
import { homedir } from 'os'
import { join, resolve } from 'path'
import {
  describeInvalidLoopSecrets,
  fetchSandboxSecretValues,
  resolveSandboxSecret,
  resolveSandboxSecretFilePath,
  sandboxSecretProviders,
  type SandboxSecretValuesRequest,
} from '../../src/sandbox/secrets'

const PROVIDER_ID = 'test-provider'

function request(names: string[]): SandboxSecretValuesRequest {
  return {
    projectId: 'proj-1',
    sandbox: 'loop-a',
    directory: '/home/user/worktrees/loop-a',
    names,
  }
}

describe('fetchSandboxSecretValues', () => {
  afterEach(() => {
    sandboxSecretProviders().delete(PROVIDER_ID)
  })

  test('returns only the requested names', async () => {
    sandboxSecretProviders().set(PROVIDER_ID, () => ({ FIRST: 'one', SECOND: 'two', EXTRA: 'three' }))

    await expect(fetchSandboxSecretValues(PROVIDER_ID, request(['FIRST', 'SECOND'])))
      .resolves.toEqual({ FIRST: 'one', SECOND: 'two' })
  })

  test('passes the request through to the provider', async () => {
    const seen: SandboxSecretValuesRequest[] = []
    sandboxSecretProviders().set(PROVIDER_ID, (incoming) => {
      seen.push(incoming)
      return { ONLY: 'value' }
    })

    await fetchSandboxSecretValues(PROVIDER_ID, request(['ONLY']))

    expect(seen).toEqual([request(['ONLY'])])
  })

  test('rejects an unregistered provider', async () => {
    await expect(fetchSandboxSecretValues('missing-provider', request(['KEY']))).rejects.toThrow(
      'Sandbox secret provider "missing-provider" is not registered; the plugin that supplies these secrets must be loaded in this OpenCode process',
    )
  })

  test('rejects a provider that does not answer in time', async () => {
    sandboxSecretProviders().set(PROVIDER_ID, () => new Promise<Record<string, string>>(() => {}))

    await expect(fetchSandboxSecretValues(PROVIDER_ID, request(['KEY']), 10)).rejects.toThrow(
      'Sandbox secret provider "test-provider" did not answer within 10ms',
    )
  })

  test('rejects a provider that throws', async () => {
    sandboxSecretProviders().set(PROVIDER_ID, () => {
      throw new Error('vault is sealed')
    })

    await expect(fetchSandboxSecretValues(PROVIDER_ID, request(['KEY']))).rejects.toThrow(
      'Sandbox secret provider "test-provider" failed: vault is sealed',
    )
  })

  test('rejects a provider that rejects', async () => {
    sandboxSecretProviders().set(PROVIDER_ID, async () => {
      throw new Error('no session')
    })

    await expect(fetchSandboxSecretValues(PROVIDER_ID, request(['KEY']))).rejects.toThrow(
      'Sandbox secret provider "test-provider" failed: no session',
    )
  })

  test('rejects a result that is not a string-to-string record', async () => {
    sandboxSecretProviders().set(PROVIDER_ID, () => ({ KEY: 42 }) as unknown as Record<string, string>)

    await expect(fetchSandboxSecretValues(PROVIDER_ID, request(['KEY']))).rejects.toThrow(
      'Sandbox secret provider "test-provider" returned an invalid result',
    )
  })

  test('rejects a result with a missing name', async () => {
    sandboxSecretProviders().set(PROVIDER_ID, () => ({ FIRST: 'one' }))

    await expect(fetchSandboxSecretValues(PROVIDER_ID, request(['FIRST', 'SECOND', 'THIRD']))).rejects.toThrow(
      'Sandbox secret provider "test-provider" returned no value for SECOND, THIRD',
    )
  })

  test('rejects a result with an empty value', async () => {
    sandboxSecretProviders().set(PROVIDER_ID, () => ({ FIRST: '' }))

    await expect(fetchSandboxSecretValues(PROVIDER_ID, request(['FIRST']))).rejects.toThrow(
      'Sandbox secret provider "test-provider" returned no value for FIRST',
    )
  })

  test('never mentions a value in a failure message', async () => {
    sandboxSecretProviders().set(PROVIDER_ID, () => ({ FIRST: 'leaky-value' }))

    const error = await fetchSandboxSecretValues(PROVIDER_ID, request(['FIRST', 'SECOND'])).catch((err: Error) => err)

    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error).message)).not.toContain('leaky-value')
  })
})

describe('resolveSandboxSecret file', () => {
  test('keeps a trimmed file path on the resolved secret', () => {
    expect(resolveSandboxSecret({
      env: 'TOKEN',
      file: '  ~/.config/opencode/.secrets/token  ',
      hosts: ['api.example.com'],
    })).toEqual({
      secret: {
        env: 'TOKEN',
        file: '~/.config/opencode/.secrets/token',
        hosts: ['api.example.com'],
      },
    })
  })

  test('rejects a file path that is empty after trimming', () => {
    expect(resolveSandboxSecret({ env: 'TOKEN', file: '   ', hosts: ['api.example.com'] }))
      .toEqual({ env: 'TOKEN', reason: 'file must not be empty' })
  })

  test('resolves ~ and ~/ paths under the home directory', () => {
    expect(resolveSandboxSecretFilePath('~')).toBe(homedir())
    expect(resolveSandboxSecretFilePath('~/token')).toBe(join(homedir(), 'token'))
    expect(resolveSandboxSecretFilePath('~/.config/opencode/token')).toBe(join(homedir(), '.config/opencode/token'))
  })

  test('leaves an absolute path as is', () => {
    expect(resolveSandboxSecretFilePath('/run/secrets/token')).toBe('/run/secrets/token')
  })

  test('resolves a relative path against the opencode config directory', () => {
    const saved = process.env['XDG_CONFIG_HOME']
    process.env['XDG_CONFIG_HOME'] = '/tmp/forge-secret-xdg'
    try {
      expect(resolveSandboxSecretFilePath('.secrets/token'))
        .toBe(resolve('/tmp/forge-secret-xdg/opencode', '.secrets/token'))
    } finally {
      if (saved === undefined) delete process.env['XDG_CONFIG_HOME']
      else process.env['XDG_CONFIG_HOME'] = saved
    }
  })
})

describe('describeInvalidLoopSecrets', () => {
  const registeredId = 'registered-provider'

  afterEach(() => {
    sandboxSecretProviders().delete(registeredId)
  })

  test('accepts absent or empty settings', () => {
    expect(describeInvalidLoopSecrets(undefined)).toBeUndefined()
    expect(describeInvalidLoopSecrets({})).toBeUndefined()
    expect(describeInvalidLoopSecrets({ secrets: [] })).toBeUndefined()
  })

  test('describes a rejected definition with its env name', () => {
    expect(describeInvalidLoopSecrets({ secrets: [{ env: 'TOKEN', hosts: [] }] }))
      .toBe('Invalid sandbox secret TOKEN: no allowed hosts')
  })

  test('describes a rejected definition without an env name', () => {
    expect(describeInvalidLoopSecrets({ secrets: [{ env: '  ', hosts: ['api.example.com'] }] }))
      .toBe('Invalid sandbox secret: missing env name')
  })

  test('rejects a per-loop entry that reads its value from a file', () => {
    expect(describeInvalidLoopSecrets({
      secrets: [{ env: 'TOKEN', file: '/run/secrets/token', hosts: ['api.example.com'] }],
    })).toBe('Invalid sandbox secret TOKEN: file is only supported in sandbox.network.secrets')
  })

  test('describes a duplicate env name', () => {
    expect(describeInvalidLoopSecrets({
      secrets: [
        { env: 'TOKEN', hosts: ['api.example.com'] },
        { env: 'TOKEN', hosts: ['other.example.com'] },
      ],
    })).toBe('Duplicate sandbox secret TOKEN')
  })

  test('describes an unregistered provider only when there is at least one secret', () => {
    expect(describeInvalidLoopSecrets({ secrets: [{ env: 'TOKEN', hosts: ['api.example.com'] }], secretProvider: 'nope' }))
      .toBe('Sandbox secret provider "nope" is not registered')
    expect(describeInvalidLoopSecrets({ secretProvider: 'nope' })).toBeUndefined()
  })

  test('accepts a registered provider', () => {
    sandboxSecretProviders().set(registeredId, () => ({ TOKEN: 'value' }))

    expect(describeInvalidLoopSecrets({
      secrets: [{ env: 'TOKEN', hosts: ['api.example.com'] }],
      secretProvider: registeredId,
    })).toBeUndefined()
  })
})
