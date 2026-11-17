import { describe, expect, test, vi } from 'vitest'

vi.mock('solid-js', async () => await import('solid-js/dist/dev.js'))

import { createComponent, testRender } from '@opentui/solid'
import type { ForgeSandboxTemplateBuildOutput, ForgeSandboxTemplateBuildStatus, ForgeToastInput } from '../../src/host/forge-rpc'
import type { ForgeTuiHost } from '../../src/tui/host'
import { CONCURRENT_BUILD_MESSAGE } from '../../src/sandbox/template'
import { describeSandboxBuildStatus, SandboxBuildDialog } from '../../src/tui/sandbox-build-dialog'

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

describe('SandboxBuildDialog start conflict', () => {
  test('follows a build another client already started instead of failing', async () => {
    const { host, toasts } = createHost()
    const readStatus = vi.fn()
      .mockResolvedValueOnce(idleStatus())
      .mockResolvedValue(status({ stage: 'build' }))
    const start = vi.fn(async (): Promise<ForgeSandboxTemplateBuildOutput> => ({ error: CONCURRENT_BUILD_MESSAGE }))
    const dialog = await testRender(() => createComponent(SandboxBuildDialog, { host, start, readStatus }))
    try {
      await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(dialog.renderer.currentFocusedRenderable).not.toBeNull())

      dialog.mockInput.pressEnter()

      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(readStatus.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 2000 })

      expect(toasts.filter((toast) => toast.variant === 'error')).toEqual([])
      expect(toasts.map((toast) => toast.message)).toContain('Building oc-forge-sandbox:latest...')
    } finally {
      dialog.renderer.destroy()
    }
  })

  test('shows the outcome of a build that finished before the follow-up read without polling', async () => {
    const { host, toasts } = createHost()
    const readStatus = vi.fn()
      .mockResolvedValueOnce(idleStatus())
      .mockResolvedValue(status({ phase: 'success', elapsedMs: 1000 }))
    const start = vi.fn(async (): Promise<ForgeSandboxTemplateBuildOutput> => ({ error: CONCURRENT_BUILD_MESSAGE }))
    const dialog = await testRender(() => createComponent(SandboxBuildDialog, { host, start, readStatus }))
    try {
      await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(dialog.renderer.currentFocusedRenderable).not.toBeNull())

      dialog.mockInput.pressEnter()

      await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(2))
      await new Promise((resolve) => setTimeout(resolve, 700))

      expect(readStatus).toHaveBeenCalledTimes(2)
      expect(toasts.filter((toast) => toast.variant === 'error')).toEqual([])
    } finally {
      dialog.renderer.destroy()
    }
  })

  test('reports the start error when the follow-up status is idle', async () => {
    const { host, toasts } = createHost()
    const readStatus = vi.fn()
      .mockResolvedValueOnce(idleStatus())
      .mockResolvedValue(idleStatus())
    const start = vi.fn(async (): Promise<ForgeSandboxTemplateBuildOutput> => ({ error: CONCURRENT_BUILD_MESSAGE }))
    const dialog = await testRender(() => createComponent(SandboxBuildDialog, { host, start, readStatus }))
    try {
      await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(dialog.renderer.currentFocusedRenderable).not.toBeNull())

      dialog.mockInput.pressEnter()

      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(toasts.some((toast) => toast.variant === 'error')).toBe(true))

      const errorToast = toasts.find((toast) => toast.variant === 'error')
      expect(errorToast?.message).toBe(CONCURRENT_BUILD_MESSAGE)

      await new Promise((resolve) => setTimeout(resolve, 700))
      expect(readStatus).toHaveBeenCalledTimes(2)
    } finally {
      dialog.renderer.destroy()
    }
  })
})
