import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ForgeAutoApproveState, ForgeToastInput } from '../../src/host/forge-rpc'
import { createSessionAutoApproveToggle, type SessionAutoApproveToggle } from '../../src/tui/session-auto-approve'

describe('createSessionAutoApproveToggle', () => {
  const toggles: SessionAutoApproveToggle[] = []

  afterEach(() => {
    for (const toggle of toggles.splice(0)) toggle.dispose()
  })

  interface SetupOptions {
    sessionId?: string | null
    initial?: ForgeAutoApproveState
    sandboxed?: boolean
    readState?: (sessionId: string) => Promise<ForgeAutoApproveState>
    setState?: (sessionId: string, enabled: boolean) => Promise<ForgeAutoApproveState>
  }

  function setup(options: SetupOptions = {}) {
    let sessionId = options.sessionId === undefined ? 'ses_1' : options.sessionId
    let current: ForgeAutoApproveState = options.initial ?? { enabled: false, inherited: false }
    const toasts: ForgeToastInput[] = []
    const writes: Array<{ sessionId: string; enabled: boolean }> = []
    const toggle = createSessionAutoApproveToggle({
      currentSessionId: () => sessionId,
      readState: options.readState ?? (async () => current),
      setState: options.setState ?? (async (id, enabled) => {
        writes.push({ sessionId: id, enabled })
        current = { enabled, inherited: false }
        return current
      }),
      isSandboxedSession: () => options.sandboxed ?? true,
      toast: (input) => toasts.push(input),
    })
    toggles.push(toggle)
    return {
      toasts,
      writes,
      toggle,
      setSessionId: (id: string | null) => { sessionId = id },
      setState: (state: ForgeAutoApproveState) => { current = state },
    }
  }

  test('enables then disables auto-approve for the current session', async () => {
    const { toasts, writes, toggle } = setup({ sessionId: 'ses_1', sandboxed: true })

    await toggle.toggle()

    expect(writes).toEqual([{ sessionId: 'ses_1', enabled: true }])
    expect(toggle.enabled()).toBe(true)
    expect(toasts.at(-1)?.variant).toBe('success')
    expect(toasts.at(-1)?.message).toContain('Auto-approve enabled for this session and its subagents')

    await toggle.toggle()

    expect(writes).toEqual([
      { sessionId: 'ses_1', enabled: true },
      { sessionId: 'ses_1', enabled: false },
    ])
    expect(toggle.enabled()).toBe(false)
    expect(toasts.at(-1)).toMatchObject({ message: 'Auto-approve disabled for this session', variant: 'success' })
  })

  test('asks for a session when none is open', async () => {
    const { toasts, writes, toggle } = setup({ sessionId: null })

    await toggle.toggle()

    expect(toasts).toEqual([{ message: 'Open a session first', variant: 'info', duration: 3000 }])
    expect(writes).toEqual([])
  })

  test('refuses to toggle an inherited flag and points at the owner', async () => {
    const { toasts, writes, toggle } = setup({
      sessionId: 'ses_child',
      readState: async () => ({ enabled: true, inherited: true, ownerSessionId: 'ses_parent' }),
    })

    await toggle.toggle()

    expect(writes).toEqual([])
    expect(toasts.at(-1)).toMatchObject({
      message: 'Auto-approve is inherited from parent session ses_parent; toggle it there',
      variant: 'info',
      duration: 5000,
    })
  })

  test('surfaces a server error from the write', async () => {
    const { toasts, toggle } = setup({
      sessionId: 'ses_1',
      setState: async () => ({ error: 'Loop sessions already auto-approve everything not denied' }),
    })

    await toggle.toggle()

    expect(toasts.at(-1)).toMatchObject({
      message: 'Loop sessions already auto-approve everything not denied',
      variant: 'warning',
      duration: 5000,
    })
  })

  test('warns when the state read reports an error', async () => {
    const { toasts, writes, toggle } = setup({
      sessionId: 'ses_1',
      readState: async () => ({ error: 'no Forge location for this TUI' }),
    })

    await toggle.toggle()

    expect(writes).toEqual([])
    expect(toasts.at(-1)).toMatchObject({
      message: 'Auto-approve unavailable: no Forge location for this TUI',
      variant: 'warning',
      duration: 5000,
    })
  })

  test('does not write or toast when the route changes during the state read', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { toasts, writes, toggle, setSessionId } = setup({
      sessionId: 'ses_1',
      readState: async () => {
        await gate
        return { enabled: false, inherited: false }
      },
    })

    const pending = toggle.toggle()
    setSessionId('ses_2')
    release?.()
    await pending

    expect(writes).toEqual([])
    expect(toasts).toEqual([])
  })

  test('does not update the signal when the route changes during the write', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const writes: Array<{ sessionId: string; enabled: boolean }> = []
    const { toggle, setSessionId } = setup({
      sessionId: 'ses_1',
      setState: async (id, enabled) => {
        writes.push({ sessionId: id, enabled })
        await gate
        return { enabled, inherited: false }
      },
    })

    const pending = toggle.toggle()
    await vi.waitFor(() => expect(writes).toEqual([{ sessionId: 'ses_1', enabled: true }]))
    setSessionId('ses_2')
    release?.()
    await pending

    expect(toggle.enabled()).toBe(false)
  })

  test('reflects an inherited enabled state from the poll', async () => {
    const { toggle } = setup({
      sessionId: 'ses_1',
      readState: async () => ({ enabled: true, inherited: true, ownerSessionId: 'ses_parent' }),
    })

    await vi.waitFor(() => expect(toggle.enabled()).toBe(true))
  })

  test('ignores a poll result once the route has changed', async () => {
    const reads: string[] = []
    const { toggle, setSessionId } = setup({
      sessionId: 'ses_1',
      readState: async (id) => {
        reads.push(id)
        return { enabled: true, inherited: false }
      },
    })

    setSessionId('ses_2')
    await vi.waitFor(() => expect(reads).toEqual(['ses_1']))
    await Promise.resolve()

    expect(toggle.enabled()).toBe(false)
  })

  test('warns that approved commands run on the host when the sandbox is off', async () => {
    const { toasts, toggle } = setup({ sessionId: 'ses_1', sandboxed: false })

    await toggle.toggle()

    expect(toasts.at(-1)?.variant).toBe('warning')
    expect(toasts.at(-1)?.message).toContain('Host sandbox is off')
  })

  test('reports success without the host warning when the sandbox is on', async () => {
    const { toasts, toggle } = setup({ sessionId: 'ses_1', sandboxed: true })

    await toggle.toggle()

    expect(toasts.at(-1)?.variant).toBe('success')
    expect(toasts.at(-1)?.message).not.toContain('Host sandbox is off')
  })
})
