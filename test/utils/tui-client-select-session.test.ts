import { describe, test, expect, vi } from 'vitest'

vi.mock('../../src/storage', () => ({
  resolveLogPath: vi.fn().mockReturnValue('/tmp/forge-test.log'),
}))

import { selectTuiSession } from '../../src/utils/tui-client'
import { createForgeClient } from '../../src/client/sdk-adapter'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'

function makeFixture() {
  const navigate = vi.fn()
  const selectSession = vi.fn().mockResolvedValue({ data: true })
  const api = { route: { navigate } } as unknown as TuiPluginApi
  const client = createForgeClient({ tui: { selectSession } } as never)
  return { api, client, navigate, selectSession }
}

describe('selectTuiSession', () => {
  test('route-first success: calls api.route.navigate and does not call SDK', async () => {
    const { api, client, navigate, selectSession } = makeFixture()
    await selectTuiSession(api, client, 'ses_123', 'ws_123')

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('session', { sessionID: 'ses_123' })
    expect(selectSession).not.toHaveBeenCalled()
  })

  test('SDK fallback when route navigate throws', async () => {
    const { api, client, navigate, selectSession } = makeFixture()
    navigate.mockImplementation(() => {
      throw new Error('route unavailable')
    })

    await selectTuiSession(api, client, 'ses_456', 'ws_456')

    expect(selectSession).toHaveBeenCalledTimes(1)
    expect(selectSession).toHaveBeenCalledWith({
      sessionID: 'ses_456',
      workspace: 'ws_456',
    })
  })

  test('no workspace fallback payload', async () => {
    const { api, client, navigate, selectSession } = makeFixture()
    navigate.mockImplementation(() => {
      throw new Error('route unavailable')
    })

    await selectTuiSession(api, client, 'ses_789')

    expect(selectSession).toHaveBeenCalledTimes(1)
    expect(selectSession).toHaveBeenCalledWith({
      sessionID: 'ses_789',
    })
  })
})
