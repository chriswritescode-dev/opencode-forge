import { vi } from 'vitest'
import type { Logger } from '../../src/types'

/** One recorded call made through a capturing logger. */
export interface CapturedLog {
  level: 'log' | 'error' | 'debug'
  message: string
}

/**
 * Creates a mock Logger for tests.
 * Returns vi.fn() spies (structurally a Logger) so callers can both use it as a
 * no-op logger and assert on calls (e.g. `logger.log.mock.calls`).
 */
export function createMockLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

/**
 * Creates a Logger that records every call in order, for tests that assert on log output.
 */
export function createCapturingLogger(): { logger: Logger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = []
  const logger: Logger = {
    log: (msg: string) => logs.push({ level: 'log', message: msg }),
    error: (msg: string) => logs.push({ level: 'error', message: msg }),
    debug: (msg: string) => logs.push({ level: 'debug', message: msg }),
  }
  return { logger, logs }
}
