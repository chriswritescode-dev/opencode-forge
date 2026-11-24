import { describe, expect, test, vi } from 'vitest'

vi.mock('solid-js', async () => await import('solid-js/dist/dev.js'))

import { createRoot } from 'solid-js'
import type { ForgeSandboxTemplateBuildOutput, ForgeSandboxTemplateBuildStatus, ForgeToastInput } from '../../src/host/forge-rpc'
import type { ForgeTuiHost } from '../../src/tui/host'
import { CONCURRENT_BUILD_MESSAGE } from '../../src/sandbox/template'
import { createSandboxBuildDialogState, describeSandboxBuildStatus, type SandboxBuildDialogStateOptions } from '../../src/tui/sandbox-build-dialog'

function status(overrides: Partial<ForgeSandboxTemplateBuildStatus> = {}): ForgeSandboxTemplateBuildStatus {
  return {
    phase: 'running',
    image: 'oc-forge-sandbox:latest',
    contextDir: '/server/container',
    tail: [],
    ...overrides,
  }
}

describe('describeSandboxBuildStatus', () => {
  test('confirm view offers the build with the first-build hint', () => {
    expect(describeSandboxBuildStatus({ phase: 'confirm', status: status({ phase: 'idle' }) })).toEqual({
      statusLine: 'Ready to build.',
      detailLine: 'A first build downloads and installs everything; expect several minutes.',
    })
  })

  test('confirm view shows a status read error and still offers the build', () => {
    expect(describeSandboxBuildStatus({ phase: 'confirm', status: null, error: 'no Forge location for this TUI' })).toEqual({
      statusLine: 'Ready to build.',
      detailLine: 'no Forge location for this TUI',
    })
  })

  test('confirm view reports a missing server build context', () => {
    expect(describeSandboxBuildStatus({
      phase: 'confirm',
      status: status({ phase: 'idle', contextExists: false }),
    })).toEqual({
      statusLine: 'Sandbox build context missing on server.',
      detailLine: 'Bundled build context is missing at /server/container. Reinstall opencode-forge.',
    })
  })

  test('confirm view prefers a status read error over the missing context report', () => {
    expect(describeSandboxBuildStatus({
      phase: 'confirm',
      status: status({ phase: 'idle', contextExists: false }),
      error: 'RPC failed',
    })).toEqual({
      statusLine: 'Ready to build.',
      detailLine: 'RPC failed',
    })
  })

  test('running view without a step shows the stage and the server elapsed time', () => {
    expect(describeSandboxBuildStatus({
      phase: 'running',
      status: status({ stage: 'save', elapsedMs: 65_000, lastLine: '# saving image' }),
    })).toEqual({
      statusLine: 'Saving image... 1:05',
      detailLine: '# saving image',
    })
  })

  test('running view with a step shows a progress bar and the step description', () => {
    const text = describeSandboxBuildStatus({
      phase: 'running',
      status: status({
        stage: 'build',
        elapsedMs: 30_000,
        step: { current: 3, total: 6, description: 'apt-get install' },
      }),
    })
    expect(text.statusLine).toBe('[████████████░░░░░░░░░░░░] 50%  Building image 3/6  0:30')
    expect(text.detailLine).toBe('apt-get install')
  })

  test('running view shows a poll error in the detail line without losing progress', () => {
    const text = describeSandboxBuildStatus({
      phase: 'running',
      status: status({ stage: 'load', elapsedMs: 5_000, lastLine: 'loading' }),
      error: 'RPC failed',
    })
    expect(text.statusLine).toBe('Loading into msb... 0:05')
    expect(text.detailLine).toBe('RPC failed')
  })

  test('success view reports the server-measured elapsed time', () => {
    expect(describeSandboxBuildStatus({ phase: 'success', status: status({ phase: 'success', elapsedMs: 123_000 }) })).toEqual({
      statusLine: 'Built and loaded in 2:03.',
      detailLine: '',
    })
  })

  test('error view reports the failure and the server elapsed time', () => {
    expect(describeSandboxBuildStatus({
      phase: 'error',
      status: status({ phase: 'error', elapsedMs: 42_000, failure: 'docker: not found' }),
    })).toEqual({
      statusLine: 'Failed after 0:42: docker: not found',
      detailLine: '',
    })
  })
})

function idleStatus(): ForgeSandboxTemplateBuildStatus {
  return { phase: 'idle', image: 'oc-forge-sandbox:latest', contextDir: '/server/container', tail: [] }
}

function createHost() {
  const toasts: ForgeToastInput[] = []
  const host: ForgeTuiHost = {
    colors: () => ({
      text: '#ffffff',
      textMuted: '#808080',
      error: '#ff0000',
      selectedText: '#000000',
      selectedBackground: '#ffffff',
    }),
    toast: vi.fn((input: ForgeToastInput) => { toasts.push(input) }),
    showDialog: vi.fn(),
    clearDialog: vi.fn(),
    select: async () => undefined,
    prompt: async () => undefined,
  }
  return { host, toasts }
}

function mountSandboxBuildDialogState(options: SandboxBuildDialogStateOptions) {
  let state: ReturnType<typeof createSandboxBuildDialogState> | undefined
  const dispose = createRoot((disposeRoot) => {
    state = createSandboxBuildDialogState(options)
    return disposeRoot
  })
  if (!state) throw new Error('sandbox build dialog state did not mount')
  return { state, dispose }
}

describe('SandboxBuildDialog rejected RPC calls', () => {
  test('an initial status rejection is reported without halting the dialog', async () => {
    const { host } = createHost()
    const readStatus = vi.fn(async (): Promise<ForgeSandboxTemplateBuildOutput> => { throw new Error('status down') })
    const start = vi.fn(async (): Promise<ForgeSandboxTemplateBuildOutput> => idleStatus())
    const { state, dispose } = mountSandboxBuildDialogState({ start, readStatus, toast: host.toast })
    try {
      await vi.waitFor(() => expect(state.statusError()).toBe('status down'))
      expect(readStatus).toHaveBeenCalledTimes(1)
      expect(state.phase()).toBe('confirm')
    } finally {
      dispose()
    }
  })

  test('a status rejection during polling is reported and keeps polling until a later read succeeds', async () => {
    const { host } = createHost()
    const readStatus = vi.fn()
      .mockResolvedValueOnce(status({ phase: 'running', stage: 'build' }))
      .mockRejectedValueOnce(new Error('server restarting'))
      .mockResolvedValue(status({ phase: 'success', elapsedMs: 1000 }))
    const start = vi.fn(async (): Promise<ForgeSandboxTemplateBuildOutput> => idleStatus())
    const { state, dispose } = mountSandboxBuildDialogState({ start, readStatus, toast: host.toast })
    try {
      await vi.waitFor(() => expect(state.status()?.phase).toBe('running'))
      await vi.waitFor(() => expect(state.statusError()).toBe('server restarting'), { timeout: 2000 })
      expect(readStatus.mock.calls.length).toBeGreaterThanOrEqual(2)

      await vi.waitFor(() => expect(state.status()?.phase).toBe('success'), { timeout: 3000 })
      expect(state.statusError()).toBe('')
      expect(readStatus).toHaveBeenCalledTimes(3)
    } finally {
      dispose()
    }
  })

  test('a rejected start reports the error, shows an error toast, and releases the starting guard', async () => {
    const { host, toasts } = createHost()
    const readStatus = vi.fn(async (): Promise<ForgeSandboxTemplateBuildOutput> => idleStatus())
    const start = vi.fn()
      .mockRejectedValueOnce(new Error('RPC unavailable'))
      .mockResolvedValueOnce(status({ phase: 'running', stage: 'build' }))
    const { state, dispose } = mountSandboxBuildDialogState({ start, readStatus, toast: host.toast })
    try {
      await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(1))

      await state.start()

      expect(state.startError()).toBe('RPC unavailable')
      expect(state.phase()).toBe('error')
      expect(toasts.find((toast) => toast.variant === 'error')?.message).toBe('RPC unavailable')

      await state.start()

      expect(start).toHaveBeenCalledTimes(2)
      expect(state.startError()).toBe('')
      expect(state.status()?.phase).toBe('running')
      expect(state.phase()).toBe('running')
    } finally {
      dispose()
    }
  })
})

describe('SandboxBuildDialog start conflict', () => {
  test('follows a build another client already started instead of failing', async () => {
    const { host, toasts } = createHost()
    const readStatus = vi.fn()
      .mockResolvedValueOnce(idleStatus())
      .mockResolvedValue(status({ stage: 'build' }))
    const start = vi.fn(async (): Promise<ForgeSandboxTemplateBuildOutput> => ({ error: CONCURRENT_BUILD_MESSAGE }))
    const { state, dispose } = mountSandboxBuildDialogState({ start, readStatus, toast: host.toast })
    try {
      await vi.waitFor(() => expect(state.status()?.image).toBe('oc-forge-sandbox:latest'))

      void state.start()

      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(readStatus.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 2000 })

      expect(toasts.filter((toast) => toast.variant === 'error')).toEqual([])
      expect(toasts.map((toast) => toast.message)).toContain('Building oc-forge-sandbox:latest...')
    } finally {
      dispose()
    }
  })

  test('reports the start error instead of an earlier finished build', async () => {
    const { host, toasts } = createHost()
    const readStatus = vi.fn()
      .mockResolvedValueOnce(idleStatus())
      .mockResolvedValue(status({ phase: 'success', elapsedMs: 1000 }))
    const start = vi.fn(async (): Promise<ForgeSandboxTemplateBuildOutput> => ({ error: 'Sandbox build context is missing' }))
    const { state, dispose } = mountSandboxBuildDialogState({ start, readStatus, toast: host.toast })
    try {
      await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(1))

      void state.start()

      await vi.waitFor(() => expect(toasts.some((toast) => toast.variant === 'error')).toBe(true))
      expect(toasts.find((toast) => toast.variant === 'error')?.message).toBe('Sandbox build context is missing')
      await new Promise((resolve) => setTimeout(resolve, 700))
      expect(readStatus).toHaveBeenCalledTimes(2)
    } finally {
      dispose()
    }
  })

  test('reports the start error when the follow-up status is idle', async () => {
    const { host, toasts } = createHost()
    const readStatus = vi.fn()
      .mockResolvedValueOnce(idleStatus())
      .mockResolvedValue(idleStatus())
    const start = vi.fn(async (): Promise<ForgeSandboxTemplateBuildOutput> => ({ error: CONCURRENT_BUILD_MESSAGE }))
    const { state, dispose } = mountSandboxBuildDialogState({ start, readStatus, toast: host.toast })
    try {
      await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(1))

      void state.start()

      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(toasts.some((toast) => toast.variant === 'error')).toBe(true))

      const errorToast = toasts.find((toast) => toast.variant === 'error')
      expect(errorToast?.message).toBe(CONCURRENT_BUILD_MESSAGE)

      await new Promise((resolve) => setTimeout(resolve, 700))
      expect(readStatus).toHaveBeenCalledTimes(2)
    } finally {
      dispose()
    }
  })
})
