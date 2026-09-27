import { afterEach, describe, expect, test, vi } from 'vitest'
import type {
  ForgeHostSandboxSetOutput,
  ForgeHostSandboxState,
  ForgeHostSandboxStateOutput,
  ForgeToastInput,
} from '../../src/host/forge-rpc'
import { createHostSandboxToggle, type HostSandboxToggle } from '../../src/tui/host-sandbox'

describe('createHostSandboxToggle', () => {
  const toggles: HostSandboxToggle[] = []

  afterEach(() => {
    for (const toggle of toggles.splice(0)) toggle.dispose()
    vi.useRealTimers()
  })

  interface SetupOptions {
    sessionId: string | null
    configEnabled?: boolean
    readError?: string
  }

  function setup(options: SetupOptions) {
    const toasts: ForgeToastInput[] = []
    let state: ForgeHostSandboxState = {
      configEnabled: options.configEnabled ?? true,
      desired: null,
      applied: null,
      controller: null,
    }
    let revision = 0
    const readState = vi.fn(async (): Promise<ForgeHostSandboxStateOutput> =>
      options.readError ? { error: options.readError } : state)
    const setState = vi.fn(async (sessionId: string, enabled: boolean): Promise<ForgeHostSandboxSetOutput> => {
      const next = `rev-${++revision}`
      state = {
        ...state,
        desired: { version: 1, revision: next, enabled, sessionId, requestedAt: 1 },
      }
      return { revision: next }
    })
    const toggle = createHostSandboxToggle({
      readState,
      setState,
      currentSessionId: () => options.sessionId,
      toast: (input) => toasts.push(input),
    })
    toggles.push(toggle)

    const acknowledge = (): void => {
      const desired = state.desired
      if (!desired) return
      state = {
        ...state,
        applied: {
          version: 1,
          revision: desired.revision,
          enabled: desired.enabled,
          sessionId: desired.sessionId,
          error: null,
          appliedAt: 1,
        },
      }
    }

    return { toasts, toggle, readState, setState, acknowledge }
  }

  test('asks for a session when none is open', async () => {
    const { toasts, toggle } = setup({ sessionId: null })

    await toggle.toggle()

    expect(toasts).toEqual([{ message: 'Open a session first', variant: 'info', duration: 3000 }])
  })

  test('refuses to toggle when the server reports sandboxing disabled by config', async () => {
    const { toasts, toggle } = setup({ sessionId: 'ses_1', configEnabled: false })

    await toggle.toggle()

    expect(toasts[0]).toMatchObject({
      message: 'Host sandbox is disabled by config (sandbox.enabled: false)',
      variant: 'warning',
    })
    expect(toggle.preference()).toBeNull()
  })

  test('requests ON for the current session and reports an event-triggered acknowledgement', async () => {
    const { toasts, toggle, setState, acknowledge } = setup({ sessionId: 'ses_1' })

    const pending = toggle.toggle()
    await vi.waitFor(() => expect(setState).toHaveBeenCalled())
    acknowledge()
    toggle.refresh()
    await pending

    expect(toggle.preference()?.desired).toMatchObject({ enabled: true, sessionId: 'ses_1' })
    expect(toasts.at(-1)?.variant).toBe('success')
    expect(toasts.at(-1)?.message).toContain('Host sandbox enabled for this session')
  })

  test('a second toggle on the same session requests OFF', async () => {
    const { toggle, setState, acknowledge } = setup({ sessionId: 'ses_1' })

    const on = toggle.toggle()
    await vi.waitFor(() => expect(setState).toHaveBeenCalledTimes(1))
    acknowledge()
    toggle.refresh()
    await on

    const off = toggle.toggle()
    await vi.waitFor(() => expect(setState).toHaveBeenCalledTimes(2))
    acknowledge()
    toggle.refresh()
    await off

    expect(toggle.preference()?.desired).toMatchObject({ enabled: false, sessionId: 'ses_1' })
  })

  test('times out when no event-triggered acknowledgement arrives', async () => {
    vi.useFakeTimers()
    const { toasts, toggle, setState } = setup({ sessionId: 'ses_1' })

    const pending = toggle.toggle()
    await vi.advanceTimersByTimeAsync(15_000)
    await pending

    expect(setState).toHaveBeenCalledTimes(1)
    expect(toasts.at(-1)?.message).toContain('Timed out waiting for sandbox acknowledgement')
  })

  test('a superseding toggle cancels the previous waiter without an error toast', async () => {
    const { toasts, toggle, setState, acknowledge } = setup({ sessionId: 'ses_1' })

    const first = toggle.toggle()
    await vi.waitFor(() => expect(setState).toHaveBeenCalledTimes(1))
    const second = toggle.toggle()
    await vi.waitFor(() => expect(setState).toHaveBeenCalledTimes(2))
    acknowledge()
    toggle.refresh()
    await second
    await first

    expect(toasts.some((toast) => toast.variant === 'error')).toBe(false)
    expect(toggle.preference()?.desired).toMatchObject({ sessionId: 'ses_1' })
  })

  test('surfaces a read error and keeps the preference unavailable', async () => {
    const { toasts, toggle } = setup({ sessionId: 'ses_1', readError: 'rpc.unavailable' })

    await toggle.toggle()

    expect(toasts.at(-1)?.message).toBe('Sandbox toggle unavailable: rpc.unavailable')
    expect(toggle.preference()).toMatchObject({ desired: null, applied: null, unavailable: true })
  })
})
