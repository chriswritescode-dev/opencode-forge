import { describe, test, expect, vi } from 'vitest'

vi.mock('../../src/storage', () => ({
  resolveLogPath: vi.fn().mockReturnValue('/tmp/forge-test.log'),
}))

import { selectTuiSession } from '../../src/utils/tui-client'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'

function makeApi() {
  return {
    route: { navigate: vi.fn() },
    client: { tui: { selectSession: vi.fn().mockResolvedValue(undefined) } },
  } as unknown as TuiPluginApi
}

describe('selectTuiSession', () => {
  test('route-first success: calls api.route.navigate and does not call SDK', async () => {
    const api = makeApi()
    await selectTuiSession(api, 'ses_123', 'ws_123')

    expect((api.route.navigate as any)).toHaveBeenCalledTimes(1)
    expect((api.route.navigate as any)).toHaveBeenCalledWith('session', { sessionID: 'ses_123' })
    expect((api.client.tui.selectSession as any)).not.toHaveBeenCalled()
  })

  test('SDK fallback when route navigate throws', async () => {
    const api = makeApi()
    ;(api.route.navigate as any).mockImplementation(() => {
      throw new Error('route unavailable')
    })

    await selectTuiSession(api, 'ses_456', 'ws_456')

    expect((api.client.tui.selectSession as any)).toHaveBeenCalledTimes(1)
    expect((api.client.tui.selectSession as any)).toHaveBeenCalledWith({
      sessionID: 'ses_456',
      workspace: 'ws_456',
    })
  })

  test('no workspace fallback payload', async () => {
    const api = makeApi()
    ;(api.route.navigate as any).mockImplementation(() => {
      throw new Error('route unavailable')
    })

    await selectTuiSession(api, 'ses_789')

    expect((api.client.tui.selectSession as any)).toHaveBeenCalledTimes(1)
    expect((api.client.tui.selectSession as any)).toHaveBeenCalledWith({
      sessionID: 'ses_789',
    })
  })
})
