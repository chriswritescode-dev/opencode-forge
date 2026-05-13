import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../src/storage', () => ({
  resolveLogPath: vi.fn().mockReturnValue('/tmp/forge-test.log'),
}))

import { awaitWorkspaceConnected } from '../../src/utils/tui-client'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'

function makeApi(statusResults: Array<Array<{ workspaceID: string; status: string }> | Error>) {
  const status = vi.fn()
  statusResults.forEach((r) => {
    if (r instanceof Error) status.mockRejectedValueOnce(r)
    else status.mockResolvedValueOnce({ data: r })
  })
  return {
    client: {
      experimental: { workspace: { status } },
    },
  } as unknown as TuiPluginApi
}

describe('awaitWorkspaceConnected', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('cached path: connected on first poll returns source cached', async () => {
    const api = makeApi([
      [{ workspaceID: 'ws_1', status: 'connected' }],
    ])
    const promise = awaitWorkspaceConnected(api, 'ws_1', 5000, 100)
    await vi.advanceTimersByTimeAsync(200)
    const result = await promise

    expect(result.connected).toBe(true)
    expect(result.source).toBe('cached')
    expect(result.lastStatus).toBe('connected')
  })

  it('polled path: connecting then connected after 1 poll', async () => {
    const api = makeApi([
      [{ workspaceID: 'ws_2', status: 'connecting' }],
      [{ workspaceID: 'ws_2', status: 'connected' }],
    ])
    const promise = awaitWorkspaceConnected(api, 'ws_2', 5000, 10)

    await vi.advanceTimersByTimeAsync(50)
    const result = await promise

    expect(result.connected).toBe(true)
    expect(result.lastStatus).toBe('connected')
    expect(api.client.experimental.workspace.status).toHaveBeenCalledTimes(2)
  })

  it('timeout path: workspace stays connecting returns source timeout', async () => {
    const api = makeApi([
      [{ workspaceID: 'ws_3', status: 'connecting' }],
      [{ workspaceID: 'ws_3', status: 'connecting' }],
      [{ workspaceID: 'ws_3', status: 'connecting' }],
    ])
    const promise = awaitWorkspaceConnected(api, 'ws_3', 300, 100)

    await vi.advanceTimersByTimeAsync(400)
    const result = await promise

    expect(result.connected).toBe(false)
    expect(result.source).toBe('timeout')
    expect(result.lastStatus).toBe('connecting')
  })

  it('missing workspace: not in status list returns source timeout', async () => {
    const api = makeApi([
      [{ workspaceID: 'ws_other', status: 'connected' }],
      [{ workspaceID: 'ws_other', status: 'connected' }],
    ])
    const promise = awaitWorkspaceConnected(api, 'ws_missing', 250, 100)

    await vi.advanceTimersByTimeAsync(300)
    const result = await promise

    expect(result.connected).toBe(false)
    expect(result.source).toBe('timeout')
    expect(result.lastStatus).toBeUndefined()
  })

  it('status() throws on every poll keeps polling until timeout', async () => {
    const api = makeApi([
      new Error('network fail'),
      new Error('network fail'),
      new Error('network fail'),
    ])
    const promise = awaitWorkspaceConnected(api, 'ws_err', 250, 100)

    await vi.advanceTimersByTimeAsync(300)
    const result = await promise

    expect(result.connected).toBe(false)
    expect(result.source).toBe('timeout')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(250)
  })
})
