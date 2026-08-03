import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createLogger } from '../../src/utils/logger'

/**
 * Many processes load this plugin and share one log file, so creating a logger must never
 * truncate or rotate the existing log. Truncating erases the prior failure window outright, and
 * rotating clobbers `.old` once per process start — both destroy the diagnostics a restart is
 * supposed to preserve. This has regressed twice, so the behavior is pinned here.
 */
describe('createLogger init does not destroy an existing log', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'forge-logger-init-'))
    filePath = join(dir, 'forge.log')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('preserves prior content and creates no .old backup', () => {
    writeFileSync(filePath, 'PRIOR FAILURE WINDOW\n', 'utf-8')

    createLogger({ enabled: true, file: filePath })

    expect(readFileSync(filePath, 'utf-8')).toContain('PRIOR FAILURE WINDOW')
    expect(existsSync(filePath + '.old')).toBe(false)
  })

  test('repeated inits (concurrent processes) still preserve the original content', () => {
    writeFileSync(filePath, 'PRIOR FAILURE WINDOW\n', 'utf-8')

    const first = createLogger({ enabled: true, file: filePath })
    first.log('from first instance')
    createLogger({ enabled: true, file: filePath })
    createLogger({ enabled: true, file: filePath })

    const contents = readFileSync(filePath, 'utf-8')
    expect(contents).toContain('PRIOR FAILURE WINDOW')
    expect(contents).toContain('from first instance')
    expect(existsSync(filePath + '.old')).toBe(false)
  })

  test('size-cap rotation moves the log to .old without erasing a concurrent append', () => {
    // Rotation must not recreate the file after the rename: another process sharing this log
    // could have appended in the gap, and a truncating write would erase it.
    const big = 'x'.repeat(11 * 1024 * 1024)
    writeFileSync(filePath, big, 'utf-8')

    const logger = createLogger({ enabled: true, file: filePath })
    logger.log('after rotation')

    expect(existsSync(filePath + '.old')).toBe(true)
    expect(readFileSync(filePath + '.old', 'utf-8').length).toBeGreaterThan(10 * 1024 * 1024)
    const rotated = readFileSync(filePath, 'utf-8')
    expect(rotated).toContain('after rotation')
    expect(rotated.length).toBeLessThan(1024)
  })

  test('a disabled logger leaves the file untouched', () => {
    writeFileSync(filePath, 'PRIOR FAILURE WINDOW\n', 'utf-8')

    createLogger({ enabled: false, file: filePath })

    expect(readFileSync(filePath, 'utf-8')).toBe('PRIOR FAILURE WINDOW\n')
  })
})
