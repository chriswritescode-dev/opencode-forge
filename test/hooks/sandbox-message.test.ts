import { describe, test, expect, vi } from 'vitest'
import {
  createSandboxMessageHook,
  SANDBOX_BLOCK_CLOSE,
  SANDBOX_BLOCK_OPEN,
  SANDBOX_TRACKED_SESSION_LIMIT,
} from '../../src/hooks/sandbox-message'
import { SANDBOX_CONTEXT_NOTE, SANDBOX_OFF_NOTE } from '../../src/sandbox/context'
import type { SandboxContext } from '../../src/sandbox/context'
import type { Logger } from '../../src/types'

const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

const context = { containerName: 'forge-x', hostDir: '/w', mounts: [] } as unknown as SandboxContext

function makeHook(resolved: SandboxContext | null) {
  return createSandboxMessageHook({ resolveSandboxForSession: async () => resolved, logger })
}

function countBlock(entry: string, marker: string): number {
  return entry.split(marker).length - 1
}

function systemText(output: { system: string[] }): string {
  return output.system.join('\n\n')
}

describe('createSandboxMessageHook (chat.system.transform)', () => {
  test('merges the sandbox context note into the existing system prompt entry', async () => {
    const hook = makeHook(context)
    const output = { system: ['base system prompt'] }

    await hook({ sessionID: 'ses_1' }, output)

    expect(output.system).toHaveLength(1)
    expect(output.system[0]).toContain('base system prompt')
    expect(output.system[0]).toContain(SANDBOX_CONTEXT_NOTE)
    expect(output.system[0]).toContain(SANDBOX_BLOCK_OPEN)
    expect(output.system[0]).toContain(SANDBOX_BLOCK_CLOSE)
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

  test('merges the sandbox-off note exactly once per sandboxed -> unsandboxed transition', async () => {
    let state: SandboxContext | null = context
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async () => state,
      logger,
    })

    const sandboxed = { system: ['base'] }
    await hook({ sessionID: 'ses_1' }, sandboxed)
    expect(systemText(sandboxed)).toContain(SANDBOX_CONTEXT_NOTE)

    state = null
    const firstOff = { system: ['base'] }
    await hook({ sessionID: 'ses_1' }, firstOff)
    expect(systemText(firstOff)).toContain(SANDBOX_OFF_NOTE)
    expect(systemText(firstOff)).not.toContain(SANDBOX_CONTEXT_NOTE)

    const secondOff = { system: ['base'] }
    await hook({ sessionID: 'ses_1' }, secondOff)
    expect(systemText(secondOff)).not.toContain(SANDBOX_OFF_NOTE)
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
      emittedOff.push(systemText(output).includes(SANDBOX_OFF_NOTE))
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

    expect(systemText(aOutput)).toContain(SANDBOX_OFF_NOTE)
    expect(systemText(bOutput)).not.toContain(SANDBOX_OFF_NOTE)
    expect(systemText(bOutput)).toContain(SANDBOX_CONTEXT_NOTE)
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
    expect(systemText(afterError)).toContain(SANDBOX_OFF_NOTE)
  })

  test('leads the container note with the probed host -> container change, on every request', async () => {
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async () => context,
      probe: {
        describeHost: async () => 'Darwin 24.6.0 arm64 | macOS 15.6',
        describeSandbox: async () => 'Linux 6.1.0 aarch64 | Debian GNU/Linux 12',
      },
      logger,
    })

    for (const _ of [0, 1]) {
      const output = { system: ['base'] }
      await hook({ sessionID: 'ses_1' }, output)
      expect(output.system[0]).toContain(
        '[Sandbox] Environment changed: host (Darwin 24.6.0 arm64 | macOS 15.6) -> container (Linux 6.1.0 aarch64 | Debian GNU/Linux 12).'
      )
      expect(output.system[0]).toContain(SANDBOX_CONTEXT_NOTE)
    }
  })

  test('leads the off note with the container it left -> the probed host', async () => {
    let state: SandboxContext | null = context
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async () => state,
      probe: {
        describeHost: async () => 'Darwin 24.6.0 arm64 | macOS 15.6',
        describeSandbox: async () => 'Linux 6.1.0 aarch64 | Debian GNU/Linux 12',
      },
      logger,
    })

    await hook({ sessionID: 'ses_1' }, { system: ['base'] })

    state = null
    const output = { system: ['base'] }
    await hook({ sessionID: 'ses_1' }, output)

    expect(output.system[0]).toContain(
      '[Sandbox] Environment changed: container (Linux 6.1.0 aarch64 | Debian GNU/Linux 12) -> host (Darwin 24.6.0 arm64 | macOS 15.6).'
    )
    expect(output.system[0]).toContain(SANDBOX_OFF_NOTE)
  })

  test('falls back to the plain notes when neither environment can be probed', async () => {
    let state: SandboxContext | null = context
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async () => state,
      probe: { describeHost: async () => null, describeSandbox: async () => null },
      logger,
    })

    const on = { system: ['base'] }
    await hook({ sessionID: 'ses_1' }, on)
    expect(systemText(on)).toContain(SANDBOX_CONTEXT_NOTE)

    state = null
    const off = { system: ['base'] }
    await hook({ sessionID: 'ses_1' }, off)
    expect(systemText(off)).toContain(SANDBOX_OFF_NOTE)
  })

  test('reports a partially probed transition rather than dropping the change', async () => {
    const hook = createSandboxMessageHook({
      resolveSandboxForSession: async () => context,
      probe: {
        describeHost: async () => null,
        describeSandbox: async () => 'Linux 6.1.0 aarch64',
      },
      logger,
    })

    const output = { system: ['base'] }
    await hook({ sessionID: 'ses_1' }, output)

    expect(output.system[0]).toContain('host (unknown) -> container (Linux 6.1.0 aarch64).')
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
    expect(systemText(evicted)).not.toContain(SANDBOX_OFF_NOTE)

    const newest = `ses_${SANDBOX_TRACKED_SESSION_LIMIT - 1}`
    states.set(newest, null)
    const retained = { system: ['base'] }
    await hook({ sessionID: newest }, retained)
    expect(systemText(retained)).toContain(SANDBOX_OFF_NOTE)
  })

  test('replaces the owned block in place across repeated invocations without accumulating', async () => {
    const hook = makeHook(context)
    const output = { system: ['base', 'mode instructions'] }

    await hook({ sessionID: 'ses_1' }, output)
    await hook({ sessionID: 'ses_1' }, output)

    expect(output.system).toHaveLength(2)
    expect(output.system[0]).toBe('base')
    expect(countBlock(output.system[1]!, SANDBOX_BLOCK_OPEN)).toBe(1)
    expect(countBlock(output.system[1]!, SANDBOX_BLOCK_CLOSE)).toBe(1)
  })

  test('replaces the on guidance with the off note on a reused array, then clears it when no note applies', async () => {
    let state: SandboxContext | null = context
    const hook = createSandboxMessageHook({ resolveSandboxForSession: async () => state, logger })
    const output = { system: ['base'] }

    await hook({ sessionID: 'ses_1' }, output)
    expect(output.system[0]).toContain(SANDBOX_CONTEXT_NOTE)

    state = null
    await hook({ sessionID: 'ses_1' }, output)
    expect(output.system[0]).toContain(SANDBOX_OFF_NOTE)
    expect(output.system[0]).not.toContain(SANDBOX_CONTEXT_NOTE)
    expect(countBlock(output.system[0]!, SANDBOX_BLOCK_OPEN)).toBe(1)

    await hook({ sessionID: 'ses_1' }, output)
    expect(output.system).toEqual(['base\n\n'])
  })

  test('removes only the owned block on cleanup, preserving prefix and suffix byte-for-byte', async () => {
    const hook = makeHook(null)
    const prefix = 'base\tprompt\n\n'
    const suffix = '\n\tanother plugin suffix'
    const output = {
      system: [`${prefix}${SANDBOX_BLOCK_OPEN}\nstale guidance\n${SANDBOX_BLOCK_CLOSE}${suffix}`],
    }

    await hook({ sessionID: 'ses_1' }, output)

    expect(output.system).toEqual([`${prefix}${suffix}`])
  })

  test('preserves a same-entry suffix written by another plugin across on, off, and clear', async () => {
    let state: SandboxContext | null = context
    const hook = createSandboxMessageHook({ resolveSandboxForSession: async () => state, logger })
    const output = { system: ['base', 'mode instructions'] }

    await hook({ sessionID: 'ses_1' }, output)
    output.system[1] += '\n\nanother plugin suffix'

    await hook({ sessionID: 'ses_1' }, output)
    expect(output.system[1]).toContain('mode instructions')
    expect(output.system[1]!.endsWith('another plugin suffix')).toBe(true)
    expect(countBlock(output.system[1]!, SANDBOX_BLOCK_OPEN)).toBe(1)

    state = null
    await hook({ sessionID: 'ses_1' }, output)
    expect(output.system[1]).toContain(SANDBOX_OFF_NOTE)
    expect(output.system[1]!.endsWith('another plugin suffix')).toBe(true)
    expect(countBlock(output.system[1]!, SANDBOX_BLOCK_OPEN)).toBe(1)

    await hook({ sessionID: 'ses_1' }, output)
    expect(output.system[1]).toBe('mode instructions\n\n\n\nanother plugin suffix')
  })

  test('preserves a project-md-context block in the same entry', async () => {
    let state: SandboxContext | null = context
    const hook = createSandboxMessageHook({ resolveSandboxForSession: async () => state, logger })
    const projectMdBlock = '<project-md-context>\nproject.md context\n</project-md-context>'
    const output = { system: ['base', projectMdBlock] }

    await hook({ sessionID: 'ses_1' }, output)
    expect(output.system[1]).toContain(projectMdBlock)
    expect(output.system[1]).toContain(SANDBOX_CONTEXT_NOTE)

    state = null
    await hook({ sessionID: 'ses_1' }, output)
    expect(output.system[1]).toContain(projectMdBlock)
    expect(output.system[1]).toContain(SANDBOX_OFF_NOTE)

    await hook({ sessionID: 'ses_1' }, output)
    expect(output.system[1]).toBe(`${projectMdBlock}\n\n`)
  })

  test('handles an empty array and an empty string entry', async () => {
    const hook = makeHook(context)

    const emptyArray = { system: [] as string[] }
    await hook({ sessionID: 'ses_1' }, emptyArray)
    expect(emptyArray.system).toHaveLength(1)
    expect(emptyArray.system[0]).toContain(SANDBOX_CONTEXT_NOTE)

    const emptyString = { system: [''] }
    await hook({ sessionID: 'ses_1' }, emptyString)
    expect(emptyString.system).toHaveLength(1)
    expect(emptyString.system[0]).toContain(SANDBOX_CONTEXT_NOTE)
  })

  test('removes a stale owned block and leaves an empty array empty when no note applies', async () => {
    const hook = makeHook(null)
    const output = {
      system: [`base\n\n${SANDBOX_BLOCK_OPEN}\nstale guidance\n${SANDBOX_BLOCK_CLOSE}`],
    }

    await hook({ sessionID: 'ses_1' }, output)
    expect(output.system).toEqual(['base\n\n'])

    const empty = { system: [] as string[] }
    await hook({ sessionID: 'ses_1' }, empty)
    expect(empty.system).toEqual([])
  })
})
