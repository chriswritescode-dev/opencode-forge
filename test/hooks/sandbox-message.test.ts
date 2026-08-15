import { describe, test, expect, vi } from 'vitest'
import { createSandboxMessageHook, SANDBOX_TRACKED_SESSION_LIMIT } from '../../src/hooks/sandbox-message'
import { SANDBOX_CONTEXT_NOTE, SANDBOX_OFF_NOTE } from '../../src/sandbox/context'
import type { SandboxContext } from '../../src/sandbox/context'
import type { Logger } from '../../src/types'

const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

const context = { containerName: 'forge-x', hostDir: '/w', mounts: [] } as unknown as SandboxContext

function makeHook(resolved: SandboxContext | null) {
  return createSandboxMessageHook({ resolveSandboxForSession: async () => resolved, logger })
}

describe('createSandboxMessageHook (chat.system.transform)', () => {
  test('appends sandbox context note when the session resolves to a container', async () => {
    const hook = makeHook(context)
    const output = { system: ['base system prompt'] }

    await hook({ sessionID: 'ses_1' }, output)

    expect(output.system).toContain(SANDBOX_CONTEXT_NOTE)
    expect(output.system).toHaveLength(2)
  })

  test('does not append when the session resolves to no sandbox', async () => {
    const hook = makeHook(null)
    const output = { system: ['base'] }

    await hook({ sessionID: 'ses_1' }, output)

    expect(output.system).toEqual(['base'])
  })

  test('no-ops when sessionID is missing', async () => {
    const resolveSandboxForSession = vi.fn(async () => context)
    const hook = createSandboxMessageHook({ resolveSandboxForSession, logger })
    const output = { system: ['base'] }

    await hook({}, output)

    expect(resolveSandboxForSession).not.toHaveBeenCalled()
    expect(output.system).toEqual(['base'])
  })

  test('swallows resolver errors without throwing or appending', async () => {
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async () => { throw new Error('boom') },
      logger,
    })
    const output = { system: ['base'] }

    await expect(hook({ sessionID: 'ses_1' }, output)).resolves.toBeUndefined()
    expect(output.system).toEqual(['base'])
  })

  test('resolves with throwOnRestoreError so an unrestorable acknowledged sandbox cannot read as off', async () => {
    const resolveSandboxForSession = vi.fn(async () => context)
    const hook = createSandboxMessageHook({ resolveSandboxForSession, logger })
    const output = { system: ['base'] }

    await hook({ sessionID: 'ses_1' }, output)

    expect(resolveSandboxForSession).toHaveBeenCalledWith('ses_1', { throwOnRestoreError: true })
  })

  test('appends the sandbox-off note exactly once per sandboxed -> unsandboxed transition', async () => {
    let state: SandboxContext | null = context
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async () => state,
      logger,
    })

    const sandboxed = { system: ['base'] }
    await hook({ sessionID: 'ses_1' }, sandboxed)
    expect(sandboxed.system).toContain(SANDBOX_CONTEXT_NOTE)

    state = null
    const firstOff = { system: ['base'] }
    await hook({ sessionID: 'ses_1' }, firstOff)
    expect(firstOff.system).toContain(SANDBOX_OFF_NOTE)
    expect(firstOff.system).not.toContain(SANDBOX_CONTEXT_NOTE)

    const secondOff = { system: ['base'] }
    await hook({ sessionID: 'ses_1' }, secondOff)
    expect(secondOff.system).not.toContain(SANDBOX_OFF_NOTE)
  })

  test('re-enabling then disabling the sandbox emits the off note again', async () => {
    let state: SandboxContext | null = context
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async () => state,
      logger,
    })

    const emittedOff = []
    for (const next of [context, null, context, null]) {
      state = next
      const output = { system: ['base'] }
      await hook({ sessionID: 'ses_1' }, output)
      emittedOff.push(output.system.includes(SANDBOX_OFF_NOTE))
    }
    expect(emittedOff).toEqual([false, true, false, true])
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

    await hook({ sessionID: 'ses_a' }, { system: ['base'] })
    await hook({ sessionID: 'ses_b' }, { system: ['base'] })

    states.set('ses_a', null)
    states.set('ses_b', context)
    const aOutput = { system: ['base'] }
    const bOutput = { system: ['base'] }
    await hook({ sessionID: 'ses_a' }, aOutput)
    await hook({ sessionID: 'ses_b' }, bOutput)

    expect(aOutput.system).toContain(SANDBOX_OFF_NOTE)
    expect(bOutput.system).not.toContain(SANDBOX_OFF_NOTE)
    expect(bOutput.system).toContain(SANDBOX_CONTEXT_NOTE)
  })

  test('on resolver error emits no off note and retains the observed state', async () => {
    let mode: 'sandboxed' | 'error' | 'host' = 'sandboxed'
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async () => {
        if (mode === 'error') throw new Error('resolver down')
        return mode === 'sandboxed' ? context : null
      },
      logger,
    })

    await hook({ sessionID: 'ses_1' }, { system: ['base'] })

    mode = 'error'
    const errored = { system: ['base'] }
    await hook({ sessionID: 'ses_1' }, errored)
    expect(errored.system).toEqual(['base'])

    mode = 'host'
    const afterError = { system: ['base'] }
    await hook({ sessionID: 'ses_1' }, afterError)
    expect(afterError.system).toContain(SANDBOX_OFF_NOTE)
  })

  test('bounds tracked sessions: the oldest is evicted past the limit, the newest still gets its off note', async () => {
    const states = new Map<string, SandboxContext | null>()
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async (sessionID) => states.get(sessionID) ?? null,
      logger,
    })

    states.set('ses_oldest', context)
    await hook({ sessionID: 'ses_oldest' }, { system: ['base'] })

    for (let i = 0; i < SANDBOX_TRACKED_SESSION_LIMIT; i++) {
      states.set(`ses_${i}`, context)
      await hook({ sessionID: `ses_${i}` }, { system: ['base'] })
    }

    states.set('ses_oldest', null)
    const evicted = { system: ['base'] }
    await hook({ sessionID: 'ses_oldest' }, evicted)
    expect(evicted.system).not.toContain(SANDBOX_OFF_NOTE)

    const newest = `ses_${SANDBOX_TRACKED_SESSION_LIMIT - 1}`
    states.set(newest, null)
    const retained = { system: ['base'] }
    await hook({ sessionID: newest }, retained)
    expect(retained.system).toContain(SANDBOX_OFF_NOTE)
  })
})
