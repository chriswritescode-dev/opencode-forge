import { describe, test, expect, vi } from 'vitest'
import { emitLoopPermissionConfigWarnings, emitLoopSessionReuseConfigWarnings } from '../../src/utils/loop-permission-warnings'
import type { Logger, PluginConfig } from '../../src/types'

function badConfig(): PluginConfig {
  return { loop: { permissions: { deny: ['*'] } } }
}

function makeSink() {
  const logged: string[] = []
  const onWarnings = vi.fn<(warnings: string[]) => void>()
  const logger: Logger = {
    log: (message: string) => { logged.push(message) },
    error: () => {},
    debug: () => {},
  }
  return { logged, onWarnings, logger }
}

describe('emitLoopPermissionConfigWarnings', () => {
  test('logs and surfaces warnings for a bad config on a root directory', () => {
    const { logged, onWarnings, logger } = makeSink()
    emitLoopPermissionConfigWarnings(badConfig(), '/data', '/project', { logger, onWarnings })

    expect(onWarnings).toHaveBeenCalledTimes(1)
    const warnings = onWarnings.mock.calls[0][0]
    expect(warnings.join(' ')).toContain('loop.permissions.deny entry "*" is ignored')
    expect(logged).toEqual(warnings)
  })

  test('does not re-surface warnings for a forge worktree directory but still logs them', () => {
    const { logged, onWarnings, logger } = makeSink()
    emitLoopPermissionConfigWarnings(badConfig(), '/data', '/data/worktrees/my-loop', { logger, onWarnings })

    expect(onWarnings).not.toHaveBeenCalled()
    expect(logged.length).toBeGreaterThan(0)
    expect(logged[0]).toContain('loop.permissions.deny entry "*" is ignored')
  })

  test('logs and surfaces warnings through the TUI-style sink (console logger, toast sink)', () => {
    const toasts: string[] = []
    const logged: string[] = []
    emitLoopPermissionConfigWarnings(badConfig(), '/data', '/project', {
      logger: {
        log: (message: string) => { logged.push(message) },
        error: () => {},
        debug: () => {},
      },
      onWarnings: (warnings) => { toasts.push(warnings.join(' ')) },
    })

    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('loop.permissions.deny entry "*" is ignored')
    expect(logged.length).toBeGreaterThan(0)
  })

  test('does nothing when there are no warnings', () => {
    const { logged, onWarnings, logger } = makeSink()
    emitLoopPermissionConfigWarnings({}, '/data', '/project', { logger, onWarnings })

    expect(onWarnings).not.toHaveBeenCalled()
    expect(logged).toEqual([])
  })
})

describe('emitLoopSessionReuseConfigWarnings', () => {
  function badSessionReuseConfig(): PluginConfig {
    return { loop: { sessionReuse: { coderContextPercent: 200 } } }
  }

  test('logs and surfaces warnings for a bad config on a root directory', () => {
    const { logged, onWarnings, logger } = makeSink()
    emitLoopSessionReuseConfigWarnings(badSessionReuseConfig(), '/data', '/project', { logger, onWarnings })

    expect(onWarnings).toHaveBeenCalledTimes(1)
    const warnings = onWarnings.mock.calls[0][0]
    expect(warnings.join(' ')).toContain('loop.sessionReuse.coderContextPercent is ignored')
    expect(logged).toEqual(warnings)
  })

  test('does not re-surface warnings for a forge worktree directory but still logs them', () => {
    const { logged, onWarnings, logger } = makeSink()
    emitLoopSessionReuseConfigWarnings(badSessionReuseConfig(), '/data', '/data/worktrees/my-loop', { logger, onWarnings })

    expect(onWarnings).not.toHaveBeenCalled()
    expect(logged.length).toBe(1)
    expect(logged[0]).toContain('loop.sessionReuse.coderContextPercent is ignored')
  })

  test('does nothing when the session reuse config is valid', () => {
    const { logged, onWarnings, logger } = makeSink()
    emitLoopSessionReuseConfigWarnings({ loop: { sessionReuse: { coderContextPercent: 50 } } }, '/data', '/project', { logger, onWarnings })

    expect(onWarnings).not.toHaveBeenCalled()
    expect(logged).toEqual([])
  })
})
