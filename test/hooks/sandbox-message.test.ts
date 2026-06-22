import { describe, test, expect, vi } from 'vitest'
import { createSandboxMessageHook } from '../../src/hooks/sandbox-message'
import { SANDBOX_SHELL_GUIDANCE } from '../../src/loop/prompts'
import type { Logger } from '../../src/types'

const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger

function makeHook(resolved: unknown) {
  const sessionLoopResolver = {
    resolveActiveLoopForSession: vi.fn(async () => resolved),
  } as any
  return createSandboxMessageHook({ sessionLoopResolver, logger })
}

describe('createSandboxMessageHook (chat.system.transform)', () => {
  test('appends sh guidance to system prompt for an active sandbox loop session', async () => {
    const hook = makeHook({ loopName: 'l', active: true, sandbox: true })
    const output = { system: ['base system prompt'] }

    await hook({ sessionID: 'ses_1' }, output)

    expect(output.system).toContain(SANDBOX_SHELL_GUIDANCE)
    expect(output.system).toHaveLength(2)
  })

  test('does not append for a non-sandbox (worktree-only) loop session', async () => {
    const hook = makeHook({ loopName: 'l', active: true, sandbox: false })
    const output = { system: ['base'] }

    await hook({ sessionID: 'ses_1' }, output)

    expect(output.system).toEqual(['base'])
  })

  test('does not append for an inactive loop session', async () => {
    const hook = makeHook({ loopName: 'l', active: false, sandbox: true })
    const output = { system: ['base'] }

    await hook({ sessionID: 'ses_1' }, output)

    expect(output.system).toEqual(['base'])
  })

  test('does not append for a session that resolves to no loop', async () => {
    const hook = makeHook(null)
    const output = { system: ['base'] }

    await hook({ sessionID: 'ses_1' }, output)

    expect(output.system).toEqual(['base'])
  })

  test('no-ops when sessionID is missing', async () => {
    const resolver = vi.fn(async () => ({ active: true, sandbox: true }))
    const hook = createSandboxMessageHook({
      sessionLoopResolver: { resolveActiveLoopForSession: resolver } as any,
      logger,
    })
    const output = { system: ['base'] }

    await hook({}, output)

    expect(resolver).not.toHaveBeenCalled()
    expect(output.system).toEqual(['base'])
  })

  test('swallows resolver errors without throwing or appending', async () => {
    const sessionLoopResolver = {
      resolveActiveLoopForSession: vi.fn(async () => { throw new Error('boom') }),
    } as any
    const hook = createSandboxMessageHook({ sessionLoopResolver, logger })
    const output = { system: ['base'] }

    await expect(hook({ sessionID: 'ses_1' }, output)).resolves.toBeUndefined()
    expect(output.system).toEqual(['base'])
  })
})
