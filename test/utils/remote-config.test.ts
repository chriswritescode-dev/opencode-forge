import { test, expect, describe } from 'vitest'
import { resolveRemoteServer, listRemoteNames, isModeAllowedForTarget } from '../../src/utils/remote-config'
import type { PluginConfig } from '../../src/types'

describe('resolveRemoteServer', () => {
  test('returns null for unknown name when config.remotes is undefined', () => {
    const config: PluginConfig = {}
    expect(resolveRemoteServer(config, 'unknown')).toBeNull()
  })

  test('returns null for unknown name when config.remotes is empty', () => {
    const config: PluginConfig = { remotes: [] }
    expect(resolveRemoteServer(config, 'unknown')).toBeNull()
  })

  test('fills defaults: username, gitRemote, sandbox', () => {
    const config: PluginConfig = {
      remotes: [{ name: 'server1', url: 'http://localhost:4096' }],
    }
    const resolved = resolveRemoteServer(config, 'server1')
    expect(resolved).toEqual({
      name: 'server1',
      url: 'http://localhost:4096',
      username: 'opencode',
      gitRemote: 'origin',
      sandbox: true,
    })
  })

  test('preserves explicit values', () => {
    const config: PluginConfig = {
      remotes: [
        {
          name: 'server1',
          url: 'http://localhost:4096',
          username: 'admin',
          gitRemote: 'upstream',
          sandbox: false,
        },
      ],
    }
    const resolved = resolveRemoteServer(config, 'server1')
    expect(resolved).toEqual({
      name: 'server1',
      url: 'http://localhost:4096',
      username: 'admin',
      gitRemote: 'upstream',
      sandbox: false,
    })
  })

  test('preserves password when set', () => {
    const config: PluginConfig = {
      remotes: [{ name: 'server1', url: 'http://localhost:4096', password: 'secret' }],
    }
    const resolved = resolveRemoteServer(config, 'server1')
    expect(resolved).toEqual({
      name: 'server1',
      url: 'http://localhost:4096',
      password: 'secret',
      username: 'opencode',
      gitRemote: 'origin',
      sandbox: true,
    })
  })

  test('returns null for entry with empty name', () => {
    const config: PluginConfig = {
      remotes: [{ name: '', url: 'http://localhost:4096' }] as PluginConfig['remotes'],
    }
    expect(resolveRemoteServer(config, '')).toBeNull()
  })

  test('returns null for entry with empty url', () => {
    const config: PluginConfig = {
      remotes: [{ name: 'server1', url: '' }] as PluginConfig['remotes'],
    }
    expect(resolveRemoteServer(config, 'server1')).toBeNull()
  })

  test('does not throw for entry with missing name', () => {
    const config: PluginConfig = {
      remotes: [{ url: 'http://host:4096' }] as PluginConfig['remotes'],
    }
    expect(() => resolveRemoteServer(config, 'missing-name')).not.toThrow()
    expect(resolveRemoteServer(config, 'missing-name')).toBeNull()
  })

  test('does not throw for entry with missing url', () => {
    const config: PluginConfig = {
      remotes: [{ name: 'server1' }] as PluginConfig['remotes'],
    }
    expect(() => resolveRemoteServer(config, 'server1')).not.toThrow()
    expect(resolveRemoteServer(config, 'server1')).toBeNull()
  })

  test('does not throw for entry with non-string name', () => {
    const config: PluginConfig = {
      remotes: [{ name: 123, url: 'http://host:4096' }] as unknown as PluginConfig['remotes'],
    }
    expect(() => resolveRemoteServer(config, '123')).not.toThrow()
    expect(resolveRemoteServer(config, '123')).toBeNull()
  })

  test('does not throw for entry with non-string url', () => {
    const config: PluginConfig = {
      remotes: [{ name: 'server1', url: null }] as unknown as PluginConfig['remotes'],
    }
    expect(() => resolveRemoteServer(config, 'server1')).not.toThrow()
    expect(resolveRemoteServer(config, 'server1')).toBeNull()
  })

  test('does not throw for entry with null', () => {
    const config: PluginConfig = {
      remotes: [null] as unknown as PluginConfig['remotes'],
    }
    expect(() => resolveRemoteServer(config, 'any')).not.toThrow()
    expect(resolveRemoteServer(config, 'any')).toBeNull()
  })
})

describe('listRemoteNames', () => {
  test('returns empty array when remotes is undefined', () => {
    const config: PluginConfig = {}
    expect(listRemoteNames(config)).toEqual([])
  })

  test('returns empty array when remotes is empty', () => {
    const config: PluginConfig = { remotes: [] }
    expect(listRemoteNames(config)).toEqual([])
  })

  test('returns names in declared order', () => {
    const config: PluginConfig = {
      remotes: [
        { name: 'alpha', url: 'http://a:4096' },
        { name: 'beta', url: 'http://b:4096' },
        { name: 'gamma', url: 'http://c:4096' },
      ],
    }
    expect(listRemoteNames(config)).toEqual(['alpha', 'beta', 'gamma'])
  })

  test('excludes entries with missing/empty name or url', () => {
    const config: PluginConfig = {
      remotes: [
        { name: 'valid', url: 'http://valid:4096' },
        { name: '', url: 'http://empty-name:4096' },
        { name: 'empty-url', url: '' },
      ] as PluginConfig['remotes'],
    }
    expect(listRemoteNames(config)).toEqual(['valid'])
  })

  test('does not throw for entry with missing name', () => {
    const config: PluginConfig = {
      remotes: [
        { name: 'valid', url: 'http://valid:4096' },
        { url: 'http://no-name:4096' },
      ] as PluginConfig['remotes'],
    }
    expect(() => listRemoteNames(config)).not.toThrow()
    expect(listRemoteNames(config)).toEqual(['valid'])
  })

  test('does not throw for entry with missing url', () => {
    const config: PluginConfig = {
      remotes: [
        { name: 'valid', url: 'http://valid:4096' },
        { name: 'no-url' },
      ] as PluginConfig['remotes'],
    }
    expect(() => listRemoteNames(config)).not.toThrow()
    expect(listRemoteNames(config)).toEqual(['valid'])
  })

  test('does not throw for entry with non-string name', () => {
    const config: PluginConfig = {
      remotes: [
        { name: 'valid', url: 'http://valid:4096' },
        { name: 42, url: 'http://bad-name:4096' },
      ] as unknown as PluginConfig['remotes'],
    }
    expect(() => listRemoteNames(config)).not.toThrow()
    expect(listRemoteNames(config)).toEqual(['valid'])
  })

  test('does not throw for entry with non-string url', () => {
    const config: PluginConfig = {
      remotes: [
        { name: 'valid', url: 'http://valid:4096' },
        { name: 'bad-url', url: false },
      ] as unknown as PluginConfig['remotes'],
    }
    expect(() => listRemoteNames(config)).not.toThrow()
    expect(listRemoteNames(config)).toEqual(['valid'])
  })

  test('does not throw for null entry in array', () => {
    const config: PluginConfig = {
      remotes: [
        { name: 'valid', url: 'http://valid:4096' },
        null,
      ] as unknown as PluginConfig['remotes'],
    }
    expect(() => listRemoteNames(config)).not.toThrow()
    expect(listRemoteNames(config)).toEqual(['valid'])
  })
})

describe('isModeAllowedForTarget', () => {
  test('local target allows all labels', () => {
    expect(isModeAllowedForTarget('local', 'New session')).toBe(true)
    expect(isModeAllowedForTarget('local', 'Execute here')).toBe(true)
    expect(isModeAllowedForTarget('local', 'Loop')).toBe(true)
  })

  test('remote target only allows Loop', () => {
    expect(isModeAllowedForTarget('server1', 'New session')).toBe(false)
    expect(isModeAllowedForTarget('server1', 'Execute here')).toBe(false)
    expect(isModeAllowedForTarget('server1', 'Loop')).toBe(true)
  })

  test('multiple remote targets all only allow Loop', () => {
    expect(isModeAllowedForTarget('alpha', 'Loop')).toBe(true)
    expect(isModeAllowedForTarget('alpha', 'New session')).toBe(false)
    expect(isModeAllowedForTarget('beta', 'Loop')).toBe(true)
    expect(isModeAllowedForTarget('beta', 'Execute here')).toBe(false)
  })

  test('empty mode label with remote target returns false', () => {
    expect(isModeAllowedForTarget('server1', '')).toBe(false)
  })

  test('empty mode label with local target returns true', () => {
    expect(isModeAllowedForTarget('local', '')).toBe(true)
  })
})
