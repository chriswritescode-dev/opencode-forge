import { describe, test, expect, vi } from 'vitest'
import { realpathSync } from 'fs'
import { tmpdir } from 'os'
import { runCommand } from '../../src/sandbox/process'
import type { Logger } from '../../src/types'

const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

describe('runCommand', () => {
  test('times out a long-running command with exitCode 124', async () => {
    const result = await runCommand('sleep', ['5'], { logger, timeout: 200 })
    expect(result.exitCode).toBe(124)
  })

  test('pipes stdin to the child and captures stdout', async () => {
    const result = await runCommand('cat', [], { logger, stdin: 'hello' })
    expect(result.stdout).toBe('hello')
    expect(result.exitCode).toBe(0)
  })

  test('an already-aborted signal resolves with a non-zero exit code', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runCommand('sleep', ['5'], { logger, abort: controller.signal })
    expect(result.exitCode).not.toBe(0)
  })

  test('runs the child in the provided cwd', async () => {
    const result = await runCommand('pwd', [], { logger, cwd: tmpdir() })
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(tmpdir()))
  })

  test('passes the provided env to the child', async () => {
    const result = await runCommand('printenv', ['FORGE_RUN_COMMAND_ENV_TEST'], {
      logger,
      env: { ...process.env, FORGE_RUN_COMMAND_ENV_TEST: 'passed' },
    })
    expect(result.stdout.trim()).toBe('passed')
  })

  test('a provided env replaces the parent environment entirely', async () => {
    const result = await runCommand('printenv', ['HOME'], { logger, env: {} })
    expect(result.exitCode).toBe(1)
  })
})
