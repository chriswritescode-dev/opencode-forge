import { describe, test, expect, vi } from 'vitest'
import { createSandboxMessageHook } from '../../src/hooks/sandbox-message'
import { SANDBOX_CONTEXT_NOTE } from '../../src/sandbox/context'
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
})
