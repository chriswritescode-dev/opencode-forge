import { describe, test, expect, vi } from 'vitest'
import {
  createSandboxMessageHook,
  SANDBOX_INSTRUCTION_KEY,
  SANDBOX_TRACKED_SESSION_LIMIT,
  type SessionInstructionEntries,
} from '../../src/hooks/sandbox-message'
import {
  SANDBOX_CONTEXT_NOTE,
  SANDBOX_OFF_NOTE,
  SANDBOX_SWITCHED_ON_NOTE,
  formatSwitchArtifactsLine,
} from '../../src/sandbox/context'
import type { SandboxContext } from '../../src/sandbox/context'
import type { Logger } from '../../src/types'

const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

const context = { containerName: 'forge-x', hostDir: '/w', mounts: [] } as unknown as SandboxContext

interface RecordedPut {
  sessionID: string
  key: string
  value: string
}

function createEntries(options: { existing?: boolean; failPut?: boolean } = {}) {
  const puts: RecordedPut[] = []
  const lists: string[] = []
  const state = { existing: options.existing ?? false, failPut: options.failPut ?? false }
  const entries: SessionInstructionEntries = {
    list: async (sessionID) => {
      lists.push(sessionID)
      return state.existing ? [{ key: SANDBOX_INSTRUCTION_KEY }] : []
    },
    put: async (input) => {
      if (state.failPut) throw new Error('put failed')
      puts.push(input)
    },
  }
  return { entries, puts, lists, state }
}

function makeHook(resolved: SandboxContext | null) {
  return createSandboxMessageHook({ resolveSandboxForSession: async () => resolved, logger })
}

describe('createSandboxMessageHook (session instruction entries)', () => {
  test('puts the steady-state sandbox note on the first observation and nothing after that', async () => {
    const hook = makeHook(context)
    const { entries, puts } = createEntries()

    await hook('ses_1', entries)
    expect(puts).toHaveLength(1)
    expect(puts[0]!.sessionID).toBe('ses_1')
    expect(puts[0]!.key).toBe(SANDBOX_INSTRUCTION_KEY)
    expect(puts[0]!.value).toContain(SANDBOX_CONTEXT_NOTE)
    expect(puts[0]!.value).not.toContain('Environment changed')

    await hook('ses_1', entries)
    expect(puts).toHaveLength(1)
  })

  test('puts the host -> container note when a tracked host session enters a sandbox', async () => {
    let state: SandboxContext | null = null
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async () => state,
      probe: {
        describeHost: async () => 'Darwin 24.6.0 arm64 | macOS 15.6',
        describeSandbox: async () => 'Linux 6.1.0 aarch64 | Debian GNU/Linux 12',
      },
      logger,
    })
    const { entries, puts } = createEntries({ existing: true })

    await hook('ses_1', entries)
    expect(puts).toHaveLength(1)
    expect(puts[0]!.value).toContain(SANDBOX_OFF_NOTE)

    state = context
    await hook('ses_1', entries)
    expect(puts).toHaveLength(2)
    expect(puts[1]!.value).toContain(
      '[Sandbox] Environment changed: host (Darwin 24.6.0 arm64 | macOS 15.6) -> container (Linux 6.1.0 aarch64 | Debian GNU/Linux 12).',
    )
    expect(puts[1]!.value).toContain(formatSwitchArtifactsLine('host', 'container'))
    expect(puts[1]!.value).toContain(SANDBOX_SWITCHED_ON_NOTE)
    expect(puts[1]!.value).toContain(SANDBOX_CONTEXT_NOTE)
  })

  test('puts the off note once when the sandbox goes away and nothing on later host observations', async () => {
    let state: SandboxContext | null = context
    const describeHost = vi.fn(async () => 'Darwin 24.6.0 arm64 | macOS 15.6')
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async () => state,
      probe: { describeHost, describeSandbox: async () => 'Linux 6.1.0 aarch64' },
      logger,
    })
    const { entries, puts } = createEntries()

    await hook('ses_1', entries)
    expect(puts).toHaveLength(1)

    state = null
    await hook('ses_1', entries)
    expect(puts).toHaveLength(2)
    expect(puts[1]!.value).toContain(SANDBOX_OFF_NOTE)
    expect(puts[1]!.value).toContain(
      '[Sandbox] Environment changed: container (Linux 6.1.0 aarch64) -> host (Darwin 24.6.0 arm64 | macOS 15.6).',
    )
    expect(puts[1]!.value).toContain(formatSwitchArtifactsLine('container', 'host'))

    describeHost.mockClear()
    await hook('ses_1', entries)
    expect(puts).toHaveLength(2)
    expect(describeHost).not.toHaveBeenCalled()
  })

  test('puts the restarted note exactly once after a settings change', async () => {
    const base = { ...context, instanceId: 'i-1', settings: { cpus: 4, memoryMib: 8192, allowLan: false } } as SandboxContext
    let state: SandboxContext = base
    const hook = createSandboxMessageHook({ resolveSandboxForSession: async () => state, logger })
    const { entries, puts } = createEntries()

    await hook('ses_1', entries)
    expect(puts[0]!.value).toContain('Resources: 4 CPUs, 8 GiB memory')
    expect(puts[0]!.value).not.toMatch(/restarted|recreated/)

    state = { ...base, settings: { cpus: 6, memoryMib: 12288, allowLan: false } }
    await hook('ses_1', entries)
    expect(puts).toHaveLength(2)
    expect(puts[1]!.value).toContain('The sandbox was restarted to apply new resource settings')
    expect(puts[1]!.value).toContain('Resources: 6 CPUs, 12 GiB memory')

    await hook('ses_1', entries)
    expect(puts).toHaveLength(2)
  })

  test('puts the recreated note exactly once after the sandbox instance changes', async () => {
    const base = { ...context, instanceId: 'i-1' } as SandboxContext
    let state: SandboxContext = base
    const hook = createSandboxMessageHook({ resolveSandboxForSession: async () => state, logger })
    const { entries, puts } = createEntries()

    await hook('ses_1', entries)
    expect(puts).toHaveLength(1)

    state = { ...base, instanceId: 'i-2' }
    await hook('ses_1', entries)
    expect(puts).toHaveLength(2)
    expect(puts[1]!.value).toContain('The sandbox was recreated')

    await hook('ses_1', entries)
    expect(puts).toHaveLength(2)
  })

  test('treats a different sandbox name as a new sandbox rather than a recreation', async () => {
    let state = {
      ...context,
      instanceId: 'i-1',
      settings: { cpus: 4, memoryMib: 8192, allowLan: false },
    } as SandboxContext
    const hook = createSandboxMessageHook({ resolveSandboxForSession: async () => state, logger })
    const { entries, puts } = createEntries()

    await hook('ses_1', entries)
    state = {
      ...context,
      containerName: 'forge-other',
      instanceId: 'i-2',
      settings: { cpus: 6, memoryMib: 12288, allowLan: false },
    } as SandboxContext
    await hook('ses_1', entries)

    expect(puts).toHaveLength(2)
    expect(puts[1]!.value).not.toContain('was recreated')
    expect(puts[1]!.value).not.toContain('was restarted')
    expect(puts[1]!.value).toContain('Resources: 6 CPUs, 12 GiB memory')
  })

  test('puts nothing and probes nothing for an untracked host session with no existing entry', async () => {
    const describeHost = vi.fn(async () => 'Darwin 24.6.0 arm64 | macOS 15.6')
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async () => null,
      probe: { describeHost, describeSandbox: async () => null },
      logger,
    })
    const { entries, puts, lists } = createEntries()

    await hook('ses_1', entries)
    await hook('ses_1', entries)

    expect(puts).toHaveLength(0)
    expect(describeHost).not.toHaveBeenCalled()
    expect(lists).toEqual(['ses_1'])
  })

  test('puts the off note for an untracked host session that already carries the entry', async () => {
    const describeHost = vi.fn(async () => 'Darwin 24.6.0 arm64 | macOS 15.6')
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async () => null,
      probe: { describeHost, describeSandbox: async () => null },
      logger,
    })
    const { entries, puts } = createEntries({ existing: true })

    await hook('ses_1', entries)
    expect(puts).toHaveLength(1)
    expect(puts[0]!.value).toContain(SANDBOX_OFF_NOTE)
    expect(puts[0]!.value).toContain(
      '[Sandbox] Environment changed: container (unknown) -> host (Darwin 24.6.0 arm64 | macOS 15.6).',
    )
    expect(describeHost).toHaveBeenCalledTimes(1)

    await hook('ses_1', entries)
    expect(puts).toHaveLength(1)
  })

  test('logs a failed put and retries it on the next call', async () => {
    const errorLogger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
    const hook = createSandboxMessageHook({ resolveSandboxForSession: async () => context, logger: errorLogger })
    const { entries, puts, state } = createEntries({ failPut: true })

    await expect(hook('ses_1', entries)).resolves.toBeUndefined()
    expect(puts).toHaveLength(0)
    expect(errorLogger.error).toHaveBeenCalled()

    state.failPut = false
    await hook('ses_1', entries)
    expect(puts).toHaveLength(1)
    expect(puts[0]!.value).toContain(SANDBOX_CONTEXT_NOTE)
  })

  test('puts nothing and resolves when the resolver fails', async () => {
    const errorLogger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async () => {
        throw new Error('boom')
      },
      logger: errorLogger,
    })
    const { entries, puts } = createEntries()

    await expect(hook('ses_1', entries)).resolves.toBeUndefined()
    expect(puts).toHaveLength(0)
    expect(errorLogger.error).toHaveBeenCalled()
  })

  test('resolves with throwOnRestoreError so an unrestorable acknowledged sandbox cannot read as off', async () => {
    const resolveSandboxForSession = vi.fn(async () => context)
    const hook = createSandboxMessageHook({ resolveSandboxForSession, logger })
    const { entries } = createEntries()

    await hook('ses_1', entries)

    expect(resolveSandboxForSession).toHaveBeenCalledWith('ses_1', { throwOnRestoreError: true })
  })

  test('retains the tracked sandbox across a resolver error and reports the off note afterwards', async () => {
    let mode: 'sandboxed' | 'error' | 'host' = 'sandboxed'
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async () => {
        if (mode === 'error') throw new Error('resolver down')
        return mode === 'sandboxed' ? context : null
      },
      logger,
    })
    const { entries, puts } = createEntries()

    await hook('ses_1', entries)
    expect(puts).toHaveLength(1)

    mode = 'error'
    await hook('ses_1', entries)
    expect(puts).toHaveLength(1)

    mode = 'host'
    await hook('ses_1', entries)
    expect(puts).toHaveLength(2)
    expect(puts[1]!.value).toContain(SANDBOX_OFF_NOTE)
  })

  test('falls back to the unprobed notes when neither environment can be probed', async () => {
    let state: SandboxContext | null = context
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async () => state,
      probe: { describeHost: async () => null, describeSandbox: async () => null },
      logger,
    })
    const { entries, puts } = createEntries()

    await hook('ses_1', entries)
    expect(puts[0]!.value).toContain(SANDBOX_CONTEXT_NOTE)

    state = null
    await hook('ses_1', entries)
    expect(puts[1]!.value).toBe(`${formatSwitchArtifactsLine('container', 'host')}\n${SANDBOX_OFF_NOTE}`)
  })

  test('reports a partially probed transition rather than dropping the change', async () => {
    let state: SandboxContext | null = null
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async () => state,
      probe: { describeHost: async () => null, describeSandbox: async () => 'Linux 6.1.0 aarch64' },
      logger,
    })
    const { entries, puts } = createEntries({ existing: true })

    await hook('ses_1', entries)
    expect(puts).toHaveLength(1)

    state = context
    await hook('ses_1', entries)

    expect(puts[1]!.value).toContain('host (unknown) -> container (Linux 6.1.0 aarch64).')
  })

  test('tracks each session independently', async () => {
    const states = new Map<string, SandboxContext | null>([
      ['ses_a', context],
      ['ses_b', null],
    ])
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async (sessionID) => states.get(sessionID) ?? null,
      logger,
    })
    const { entries, puts } = createEntries()

    await hook('ses_a', entries)
    await hook('ses_b', entries)
    expect(puts.map((put) => put.sessionID)).toEqual(['ses_a'])

    states.set('ses_a', null)
    states.set('ses_b', context)
    await hook('ses_a', entries)
    await hook('ses_b', entries)

    expect(puts.map((put) => put.sessionID)).toEqual(['ses_a', 'ses_a', 'ses_b'])
    expect(puts[1]!.value).toContain(SANDBOX_OFF_NOTE)
    expect(puts[2]!.value).toContain(SANDBOX_CONTEXT_NOTE)
  })

  test('bounds tracked sessions: the oldest is evicted past the limit, the newest still reports its off note', async () => {
    const states = new Map<string, SandboxContext | null>()
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async (sessionID) => states.get(sessionID) ?? null,
      logger,
    })
    const { entries, puts } = createEntries()

    states.set('ses_oldest', context)
    await hook('ses_oldest', entries)

    for (let i = 0; i < SANDBOX_TRACKED_SESSION_LIMIT; i++) {
      states.set(`ses_${i}`, context)
      await hook(`ses_${i}`, entries)
    }
    puts.length = 0

    states.set('ses_oldest', null)
    await hook('ses_oldest', entries)
    expect(puts).toHaveLength(0)

    const newest = `ses_${SANDBOX_TRACKED_SESSION_LIMIT - 1}`
    states.set(newest, null)
    await hook(newest, entries)
    expect(puts).toHaveLength(1)
    expect(puts[0]!.value).toContain(SANDBOX_OFF_NOTE)
  })
})
