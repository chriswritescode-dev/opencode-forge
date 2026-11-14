import { afterEach, describe, expect, test, vi } from 'vitest'
import type {
  ForgeHostSandboxSetInput,
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
    hostSessionsDefault?: boolean
    readError?: string
    sessions?: Record<string, boolean>
    parentSessionId?: string
  }

  function setup(options: SetupOptions) {
    const toasts: ForgeToastInput[] = []
    let state: ForgeHostSandboxState = {
      configEnabled: options.configEnabled ?? true,
      hostSessionsDefault: options.hostSessionsDefault ?? true,
      desired: options.sessions
        ? { version: 2, revision: 'rev-0', sessions: { ...options.sessions }, requestedAt: 1 }
        : null,
      applied: null,
      controller: null,
    }
    let revision = 0
    let readsAtSetRequest = 0
    const readState = vi.fn(async (): Promise<ForgeHostSandboxStateOutput> =>
      options.readError ? { error: options.readError } : state)
    const setState = vi.fn(async (input: ForgeHostSandboxSetInput): Promise<ForgeHostSandboxSetOutput> => {
      readsAtSetRequest = readState.mock.calls.length
      const next = `rev-${++revision}`
      const current = state.desired
      const sessions = { ...(current?.sessions ?? {}) }
      if (input.enabled !== undefined) sessions[input.sessionId] = input.enabled
      const overrides = input.overrides ?? current?.overrides
      state = {
        ...state,
        desired: {
          version: 2,
          revision: next,
          sessions,
          requestedAt: 1,
          ...(overrides ? { overrides } : {}),
        },
      }
      return { revision: next }
    })
    const toggle = createHostSandboxToggle({
      readState,
      setState,
      currentSessionId: () => options.sessionId,
      getParentSessionId: (id) => (id === options.sessionId ? options.parentSessionId : undefined),
      toast: (input) => toasts.push(input),
    })
    toggles.push(toggle)

    const acknowledge = (outcome: { error?: string; running?: boolean } = {}): void => {
      const desired = state.desired
      if (!desired) return
      const wanted = Object.values(desired.sessions).some(Boolean) || state.hostSessionsDefault
      state = {
        ...state,
        applied: {
          version: 2,
          revision: desired.revision,
          running: outcome.running ?? wanted,
          error: outcome.error ?? null,
          appliedAt: 1,
        },
      }
    }

    const awaitInitialState = async (): Promise<void> => {
      await vi.waitFor(() => expect(toggle.preference()).not.toBeNull())
    }

    return { toasts, toggle, readState, setState, acknowledge, awaitInitialState, readsAtSetRequest: () => readsAtSetRequest }
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

  test('opts the session out of the shared sandbox when the project default is on', async () => {
    const { toasts, toggle, setState, acknowledge } = setup({ sessionId: 'ses_1' })

    const pending = toggle.toggle()
    await vi.waitFor(() => expect(setState).toHaveBeenCalledTimes(1))
    acknowledge()
    toggle.refresh()
    await pending

    expect(setState).toHaveBeenCalledWith({ sessionId: 'ses_1', enabled: false })
    expect(toggle.preference()?.desired?.sessions).toEqual({ ses_1: false })
    expect(toasts.at(-1)).toMatchObject({
      variant: 'success',
      message: 'Sandbox off for this session; its agent shell, glob, and grep calls run on the host. Other sessions keep the shared sandbox.',
    })
  })

  test('joins the shared sandbox when the project default is off', async () => {
    const { toasts, toggle, setState, acknowledge } = setup({ sessionId: 'ses_1', hostSessionsDefault: false })

    const pending = toggle.toggle()
    await vi.waitFor(() => expect(setState).toHaveBeenCalledTimes(1))
    acknowledge()
    toggle.refresh()
    await pending

    expect(setState).toHaveBeenCalledWith({ sessionId: 'ses_1', enabled: true })
    expect(toasts.at(-1)).toMatchObject({
      variant: 'success',
      message: 'Sandbox on for this session. Agent shell, glob, and grep calls run in the project\'s shared sandbox; commands you run yourself stay on the host.',
    })
  })

  test('toggles a child of an opted-out parent back into the shared sandbox', async () => {
    const { toasts, toggle, setState, acknowledge } = setup({
      sessionId: 'ses_child',
      hostSessionsDefault: true,
      sessions: { ses_parent: false },
      parentSessionId: 'ses_parent',
    })

    const pending = toggle.toggle()
    await vi.waitFor(() => expect(setState).toHaveBeenCalledTimes(1))
    acknowledge()
    toggle.refresh()
    await pending

    expect(setState).toHaveBeenCalledWith({ sessionId: 'ses_child', enabled: true })
    expect(toggle.preference()?.desired?.sessions).toEqual({ ses_parent: false, ses_child: true })
    expect(toasts.at(-1)).toMatchObject({
      variant: 'success',
      message: 'Sandbox on for this session. Agent shell, glob, and grep calls run in the project\'s shared sandbox; commands you run yourself stay on the host.',
    })
  })

  test('toggles back on after a session opted out', async () => {
    const { toggle, setState, acknowledge, awaitInitialState } = setup({ sessionId: 'ses_1' })
    await awaitInitialState()

    const off = toggle.toggle()
    await vi.waitFor(() => expect(setState).toHaveBeenCalledTimes(1))
    acknowledge()
    toggle.refresh()
    await off

    const on = toggle.toggle()
    await vi.waitFor(() => expect(setState).toHaveBeenCalledTimes(2))
    acknowledge()
    toggle.refresh()
    await on

    expect(setState).toHaveBeenLastCalledWith({ sessionId: 'ses_1', enabled: true })
    expect(toggle.preference()?.desired?.sessions).toEqual({ ses_1: true })
  })

  test('decides from the loaded preference without re-reading the server', async () => {
    const { toggle, readState, setState, awaitInitialState, readsAtSetRequest } = setup({ sessionId: 'ses_1' })
    await awaitInitialState()
    expect(readState).toHaveBeenCalledTimes(1)

    const pending = toggle.toggle()
    await vi.waitFor(() => expect(setState).toHaveBeenCalledTimes(1))

    expect(readsAtSetRequest()).toBe(1)
    toggle.dispose()
    await pending
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
    const { toasts, toggle, setState, acknowledge, awaitInitialState } = setup({ sessionId: 'ses_1' })
    await awaitInitialState()

    const first = toggle.toggle()
    await vi.waitFor(() => expect(setState).toHaveBeenCalledTimes(1))
    const second = toggle.toggle()
    await vi.waitFor(() => expect(setState).toHaveBeenCalledTimes(2))
    acknowledge()
    toggle.refresh()
    await second
    await first

    expect(toasts.some((toast) => toast.variant === 'error')).toBe(false)
    expect(toggle.preference()?.desired?.sessions).toEqual({ ses_1: false })
  })

  test('acknowledges an opt-out even when the shared sandbox reports an error', async () => {
    const { toasts, toggle, setState, acknowledge } = setup({ sessionId: 'ses_1' })

    const pending = toggle.toggle()
    await vi.waitFor(() => expect(setState).toHaveBeenCalledTimes(1))
    acknowledge({ error: 'msb failed to start' })
    toggle.refresh()
    await pending

    expect(toasts.some((toast) => toast.variant === 'error')).toBe(false)
    expect(toasts.at(-1)?.message).toContain('Sandbox off for this session')
  })

  test('rejects when joining the shared sandbox fails to start', async () => {
    const { toasts, toggle, setState, acknowledge } = setup({ sessionId: 'ses_1', hostSessionsDefault: false })

    const pending = toggle.toggle()
    await vi.waitFor(() => expect(setState).toHaveBeenCalledTimes(1))
    acknowledge({ error: 'msb failed to start' })
    toggle.refresh()
    await pending

    expect(toasts.at(-1)).toMatchObject({ variant: 'error' })
    expect(toasts.at(-1)?.message).toContain('Sandbox toggle failed: msb failed to start')
  })

  test('setOverrides reports the shared sandbox settings as applied', async () => {
    const { toasts, toggle, setState, acknowledge, awaitInitialState } = setup({ sessionId: 'ses_1' })
    await awaitInitialState()

    const change = toggle.setOverrides({ resources: { memory: '12g' }, allowLan: true })
    await vi.waitFor(() => expect(setState).toHaveBeenCalledTimes(1))
    acknowledge()
    toggle.refresh()
    await change

    expect(setState).toHaveBeenLastCalledWith({ sessionId: 'ses_1', overrides: { resources: { memory: '12g' }, allowLan: true } })
    expect(toggle.preference()?.desired).toMatchObject({ sessions: {}, overrides: { allowLan: true } })
    expect(toasts.at(-1)).toMatchObject({ variant: 'success', message: 'Shared sandbox settings applied' })
  })

  test('setOverrides saves settings for the next shared sandbox start when it is not running', async () => {
    const { toasts, toggle, setState, acknowledge, awaitInitialState } = setup({
      sessionId: 'ses_1',
      hostSessionsDefault: false,
    })
    await awaitInitialState()

    const change = toggle.setOverrides({ resources: { cpus: '6' } })
    await vi.waitFor(() => expect(setState).toHaveBeenCalledTimes(1))
    acknowledge()
    toggle.refresh()
    await change

    expect(toasts.at(-1)).toMatchObject({
      variant: 'success',
      message: 'Sandbox settings saved; they apply when the shared sandbox next starts',
    })
  })

  test('surfaces a read error and keeps the preference unavailable', async () => {
    const { toasts, toggle } = setup({ sessionId: 'ses_1', readError: 'rpc.unavailable' })

    await toggle.toggle()

    expect(toasts.at(-1)?.message).toBe('Sandbox toggle unavailable: rpc.unavailable')
    expect(toggle.preference()).toMatchObject({ desired: null, applied: null, unavailable: true, hostSessionsDefault: true })
  })
})
