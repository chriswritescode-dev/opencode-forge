import { describe, expect, test } from 'vitest'
import type { ForgeSandboxTemplateBuildStatus } from '../../src/host/forge-rpc'
import { describeSandboxBuildStatus } from '../../src/tui/sandbox-build-dialog'

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
