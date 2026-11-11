import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  isSandboxEnvName,
  readSandboxEnvNames,
  readSandboxEnvValues,
  readSandboxSecrets,
  resolveSandboxEnv,
} from '../../src/sandbox/env'
import { createMockLogger } from '../helpers/logger'

const tempDirs: string[] = []

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-env-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('isSandboxEnvName', () => {
  test('accepts valid variable names', () => {
    expect(isSandboxEnvName('DATABASE_URL')).toBe(true)
    expect(isSandboxEnvName('_private')).toBe(true)
    expect(isSandboxEnvName('a1')).toBe(true)
  })

  test('rejects invalid syntax', () => {
    expect(isSandboxEnvName('')).toBe(false)
    expect(isSandboxEnvName('1ABC')).toBe(false)
    expect(isSandboxEnvName('BAD-NAME')).toBe(false)
    expect(isSandboxEnvName('BAD NAME')).toBe(false)
  })

  test('rejects reserved and msb names', () => {
    expect(isSandboxEnvName('PATH')).toBe(false)
    expect(isSandboxEnvName('HOME')).toBe(false)
    expect(isSandboxEnvName('MSB_TOKEN')).toBe(false)
  })
})

describe('readSandboxEnvValues', () => {
  test('keeps valid entries and sorts keys', () => {
    const values = readSandboxEnvValues({ ZED: 'z', ALPHA: 'a', MIDDLE: 'm' })
    expect(Object.keys(values)).toEqual(['ALPHA', 'MIDDLE', 'ZED'])
    expect(values).toEqual({ ALPHA: 'a', MIDDLE: 'm', ZED: 'z' })
  })

  test('drops invalid names, non-string values, and NUL characters', () => {
    const logger = createMockLogger()
    const values = readSandboxEnvValues(
      { PATH: '/bin', 'BAD-NAME': 'x', NUM: 1, NUL: 'a\0b', KEEP: 'yes' },
      logger,
    )
    expect(values).toEqual({ KEEP: 'yes' })
    expect(logger.log.mock.calls.map(([message]) => message)).toEqual([
      'Sandbox: ignoring invalid env name "BAD-NAME"',
      'Sandbox: ignoring invalid env name "PATH"',
    ])
  })

  test('returns an empty record for non-record input', () => {
    expect(readSandboxEnvValues(undefined)).toEqual({})
    expect(readSandboxEnvValues(['A=1'])).toEqual({})
    expect(readSandboxEnvValues('A=1')).toEqual({})
  })
})

describe('readSandboxEnvNames', () => {
  test('trims, dedupes, and sorts names', () => {
    expect(readSandboxEnvNames([' B ', 'A', 'B', 'A'])).toEqual(['A', 'B'])
  })

  test('drops invalid names and logs them', () => {
    const logger = createMockLogger()
    const names = readSandboxEnvNames([' DATABASE_URL ', 'PATH', 'MSB_X', '1BAD', '', 42], logger)
    expect(names).toEqual(['DATABASE_URL'])
    expect(logger.log.mock.calls.map(([message]) => message)).toEqual([
      'Sandbox: ignoring invalid env name "PATH"',
      'Sandbox: ignoring invalid env name "MSB_X"',
      'Sandbox: ignoring invalid env name "1BAD"',
      'Sandbox: ignoring invalid env name ""',
    ])
  })

  test('returns an empty array for non-array input', () => {
    expect(readSandboxEnvNames(undefined)).toEqual([])
    expect(readSandboxEnvNames({ A: true })).toEqual([])
  })
})

describe('readSandboxSecrets', () => {
  test('parses a dotenv file with comments and quoted values', () => {
    const dir = createTempDir()
    const path = join(dir, 'forge-secrets.env')
    writeFileSync(
      path,
      ['# comment', 'DATABASE_URL="postgres://localhost/db"', "API_KEY='secret'", 'BAD-NAME=drop', 'EMPTY='].join('\n'),
    )
    const logger = createMockLogger()

    expect(readSandboxSecrets(path, logger)).toEqual({
      API_KEY: 'secret',
      DATABASE_URL: 'postgres://localhost/db',
      EMPTY: '',
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  test('returns an empty record for a missing file', () => {
    const logger = createMockLogger()
    expect(readSandboxSecrets(join(createTempDir(), 'absent.env'), logger)).toEqual({})
    expect(logger.error).not.toHaveBeenCalled()
  })

  test.skipIf(process.platform === 'win32')('warns when the file is readable by other users', () => {
    const dir = createTempDir()
    const path = join(dir, 'forge-secrets.env')
    writeFileSync(path, 'TOKEN=abc\n')

    chmodSync(path, 0o644)
    const looseLogger = createMockLogger()
    expect(readSandboxSecrets(path, looseLogger)).toEqual({ TOKEN: 'abc' })
    expect(looseLogger.log).toHaveBeenCalledWith(
      `Sandbox: secrets file ${path} is readable by other users; run chmod 600 on it`,
    )

    chmodSync(path, 0o600)
    const strictLogger = createMockLogger()
    expect(readSandboxSecrets(path, strictLogger)).toEqual({ TOKEN: 'abc' })
    expect(strictLogger.log).not.toHaveBeenCalled()
  })
})

describe('resolveSandboxEnv', () => {
  test('host environment beats the secrets file', () => {
    expect(
      resolveSandboxEnv({
        config: { network: { env: ['DATABASE_URL'] } },
        hostEnv: { DATABASE_URL: 'host' },
        secrets: { DATABASE_URL: 'secret' },
      }),
    ).toEqual({ DATABASE_URL: 'host' })
  })

  test('uses the secrets file when the host is unset', () => {
    expect(
      resolveSandboxEnv({
        config: { network: { env: ['DATABASE_URL'] } },
        hostEnv: {},
        secrets: { DATABASE_URL: 'secret' },
      }),
    ).toEqual({ DATABASE_URL: 'secret' })
  })

  test('skips and logs names set in neither source', () => {
    const logger = createMockLogger()
    expect(
      resolveSandboxEnv({ project: { network: { env: ['MISSING_VAR'] } }, hostEnv: {}, logger }),
    ).toEqual({})
    expect(logger.log).toHaveBeenCalledWith(
      'Sandbox: skipping env MISSING_VAR: not set in the host environment or the secrets file',
    )
  })

  test('project literal beats the global literal', () => {
    const logger = createMockLogger()
    expect(
      resolveSandboxEnv({ config: { env: { NODE_ENV: 'global' } }, project: { env: { NODE_ENV: 'project' } }, logger }),
    ).toEqual({ NODE_ENV: 'project' })
    expect(logger.log).not.toHaveBeenCalled()
  })

  test('literal beats passthrough', () => {
    expect(
      resolveSandboxEnv({
        config: { env: { NODE_ENV: 'literal' }, network: { env: ['NODE_ENV'] } },
        hostEnv: { NODE_ENV: 'host' },
      }),
    ).toEqual({ NODE_ENV: 'literal' })
  })

  test('returns keys in sorted order', () => {
    const resolved = resolveSandboxEnv({
      config: { env: { ZED: 'z' }, network: { env: ['ZEBRA'] } },
      project: { env: { ALPHA: 'a' }, network: { env: ['DATABASE_URL'] } },
      hostEnv: { ZEBRA: 'z', DATABASE_URL: 'db' },
    })
    expect(Object.keys(resolved)).toEqual(['ALPHA', 'DATABASE_URL', 'ZEBRA', 'ZED'])
  })
})
