import { describe, test, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join, resolve, relative } from 'path'
import { tmpdir } from 'os'
import { resolveCustomMounts } from '../../src/sandbox/manager'
import type { SandboxMountConfig } from '../../src/types'
import { createMockLogger } from '../helpers/sandbox-mocks'

describe('resolveCustomMounts', () => {
  let tmpDir: string | undefined

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = undefined
    }
  })

  function withTempDir(): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'forge-mount-'))
    return tmpDir
  }

  test('omitted readonly defaults to read-only', () => {
    const dir = withTempDir()
    const logger = createMockLogger()
    const raw: SandboxMountConfig[] = [
      { host: dir },
    ]
    const result = resolveCustomMounts(raw, new Set(['/workspace']), logger)
    expect(result).toEqual([
      { hostDir: resolve(dir), containerDir: resolve(dir), readOnly: true },
    ])
    expect(logger.log).not.toHaveBeenCalled()
  })

  test('explicit read-write entry (readonly: false)', () => {
    const dir = withTempDir()
    const logger = createMockLogger()
    const raw: SandboxMountConfig[] = [
      { host: dir, readonly: false },
    ]
    const result = resolveCustomMounts(raw, new Set(['/workspace']), logger)
    expect(result).toEqual([
      { hostDir: resolve(dir), containerDir: resolve(dir), readOnly: false },
    ])
    expect(logger.log).not.toHaveBeenCalled()
  })

  test('valid read-only entry', () => {
    const dir = withTempDir()
    const logger = createMockLogger()
    const raw: SandboxMountConfig[] = [
      { host: dir, readonly: true },
    ]
    const result = resolveCustomMounts(raw, new Set(['/workspace']), logger)
    expect(result).toEqual([
      { hostDir: resolve(dir), containerDir: resolve(dir), readOnly: true },
    ])
  })

  test('undefined input returns empty array', () => {
    const logger = createMockLogger()
    const result = resolveCustomMounts(undefined, new Set(['/workspace']), logger)
    expect(result).toEqual([])
    expect(logger.log).not.toHaveBeenCalled()
  })

  test('empty array input returns empty array', () => {
    const logger = createMockLogger()
    const result = resolveCustomMounts([], new Set(['/workspace']), logger)
    expect(result).toEqual([])
    expect(logger.log).not.toHaveBeenCalled()
  })

  test('missing host directory is skipped', () => {
    const logger = createMockLogger()
    const raw: SandboxMountConfig[] = [
      { host: '/definitely/not/here' },
    ]
    const result = resolveCustomMounts(raw, new Set(['/workspace']), logger)
    expect(result).toEqual([])
    expect(logger.log).toHaveBeenCalledTimes(1)
    expect(logger.log.mock.calls[0][0]).toContain('host path does not exist')
  })

  test('collision with reserved host path is skipped', () => {
    const dir = withTempDir()
    const logger = createMockLogger()
    const raw: SandboxMountConfig[] = [
      { host: dir },
    ]
    const result = resolveCustomMounts(raw, new Set([resolve(dir)]), logger)
    expect(result).toEqual([])
    expect(logger.log).toHaveBeenCalledTimes(1)
    expect(logger.log.mock.calls[0][0]).toContain('already in use')
  })

  test('nested collision with reserved host path is skipped', () => {
    const dir = withTempDir()
    const nested = join(dir, 'cache')
    mkdirSync(nested, { recursive: true })
    const logger = createMockLogger()
    const raw: SandboxMountConfig[] = [
      { host: nested, readonly: false },
    ]
    const result = resolveCustomMounts(raw, new Set([resolve(dir)]), logger)
    expect(result).toEqual([])
    expect(logger.log).toHaveBeenCalledTimes(1)
    expect(logger.log.mock.calls[0][0]).toContain('already in use')
  })

  test('duplicate host path among entries skips the second', () => {
    const dir1 = withTempDir()
    const logger = createMockLogger()
    const raw: SandboxMountConfig[] = [
      { host: dir1 },
      { host: dir1 },
    ]
    const result = resolveCustomMounts(raw, new Set(['/workspace']), logger)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ hostDir: resolve(dir1), containerDir: resolve(dir1), readOnly: true })
    expect(logger.log).toHaveBeenCalledTimes(1)
    expect(logger.log.mock.calls[0][0]).toContain('already in use')
  })

  test('missing host field is skipped', () => {
    const dir = withTempDir()
    const logger = createMockLogger()
    const raw: SandboxMountConfig[] = [
      { host: '' } as SandboxMountConfig,
      { host: dir },
    ]
    const result = resolveCustomMounts(raw, new Set(['/workspace']), logger)
    expect(result).toHaveLength(1)
    expect(logger.log).toHaveBeenCalledTimes(1)
    expect(logger.log.mock.calls[0][0]).toContain('missing host path')
  })

  test('relative host path that exists in cwd is skipped', () => {
    const dir = withTempDir()
    const rel = relative(process.cwd(), dir)
    const logger = createMockLogger()
    const raw: SandboxMountConfig[] = [
      { host: rel },
    ]
    const result = resolveCustomMounts(raw, new Set(['/workspace']), logger)
    expect(result).toEqual([])
    expect(logger.log).toHaveBeenCalledTimes(1)
    expect(logger.log.mock.calls[0][0]).toContain('host path must be absolute')
    expect(logger.log.mock.calls[0][0]).toContain(rel)
  })
})
