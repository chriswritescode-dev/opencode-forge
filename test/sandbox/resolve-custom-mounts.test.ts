import { describe, test, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join, resolve } from 'path'
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
    // Ensure the directory actually exists (mkdtempSync already creates it)
    return tmpDir
  }

  test('omitted readonly defaults to read-only', () => {
    const dir = withTempDir()
    const logger = createMockLogger()
    const raw: SandboxMountConfig[] = [
      { host: dir, container: '/data' },
    ]
    const result = resolveCustomMounts(raw, new Set(['/workspace']), logger)
    expect(result).toEqual([
      { hostDir: resolve(dir), containerDir: '/data', readOnly: true },
    ])
    expect(logger.log).not.toHaveBeenCalled()
  })

  test('explicit read-write entry (readonly: false)', () => {
    const dir = withTempDir()
    const logger = createMockLogger()
    const raw: SandboxMountConfig[] = [
      { host: dir, container: '/data', readonly: false },
    ]
    const result = resolveCustomMounts(raw, new Set(['/workspace']), logger)
    expect(result).toEqual([
      { hostDir: resolve(dir), containerDir: '/data', readOnly: false },
    ])
    expect(logger.log).not.toHaveBeenCalled()
  })

  test('valid read-only entry', () => {
    const dir = withTempDir()
    const logger = createMockLogger()
    const raw: SandboxMountConfig[] = [
      { host: dir, container: '/mnt', readonly: true },
    ]
    const result = resolveCustomMounts(raw, new Set(['/workspace']), logger)
    expect(result).toEqual([
      { hostDir: resolve(dir), containerDir: '/mnt', readOnly: true },
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
      { host: '/definitely/not/here', container: '/data' },
    ]
    const result = resolveCustomMounts(raw, new Set(['/workspace']), logger)
    expect(result).toEqual([])
    expect(logger.log).toHaveBeenCalledTimes(1)
    expect(logger.log.mock.calls[0][0]).toContain('host path does not exist')
  })

  test('non-absolute container path is skipped', () => {
    const dir = withTempDir()
    const logger = createMockLogger()
    const raw: SandboxMountConfig[] = [
      { host: dir, container: 'data' },
    ]
    const result = resolveCustomMounts(raw, new Set(['/workspace']), logger)
    expect(result).toEqual([])
    expect(logger.log).toHaveBeenCalledTimes(1)
    expect(logger.log.mock.calls[0][0]).toContain('must be absolute')
  })

  test('collision with reserved container path is skipped', () => {
    const dir = withTempDir()
    const logger = createMockLogger()
    const raw: SandboxMountConfig[] = [
      { host: dir, container: '/workspace' },
    ]
    const result = resolveCustomMounts(raw, new Set(['/workspace']), logger)
    expect(result).toEqual([])
    expect(logger.log).toHaveBeenCalledTimes(1)
    expect(logger.log.mock.calls[0][0]).toContain('already in use')
  })

  test('duplicate container path among entries skips the second', () => {
    const dir1 = withTempDir()
    const dir2 = mkdtempSync(join(tmpdir(), 'forge-mount-'))
    const logger = createMockLogger()
    const raw: SandboxMountConfig[] = [
      { host: dir1, container: '/shared' },
      { host: dir2, container: '/shared' },
    ]
    const result = resolveCustomMounts(raw, new Set(['/workspace']), logger)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ hostDir: resolve(dir1), containerDir: '/shared', readOnly: true })
    expect(logger.log).toHaveBeenCalledTimes(1)
    expect(logger.log.mock.calls[0][0]).toContain('already in use')
    // Clean up the second temp dir
    rmSync(dir2, { recursive: true, force: true })
  })

  test('missing host or container field is skipped', () => {
    const dir = withTempDir()
    const logger = createMockLogger()
    const raw: SandboxMountConfig[] = [
      { host: '', container: '/data' } as SandboxMountConfig,
      { host: dir, container: '' } as SandboxMountConfig,
    ]
    const result = resolveCustomMounts(raw, new Set(['/workspace']), logger)
    expect(result).toEqual([])
    expect(logger.log).toHaveBeenCalledTimes(2)
    expect(logger.log.mock.calls[0][0]).toContain('missing host/container')
    expect(logger.log.mock.calls[1][0]).toContain('missing host/container')
  })
})
