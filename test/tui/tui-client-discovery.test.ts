import { describe, test, expect, vi } from 'vitest'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import { resolveTuiProjectIdOnce } from '../../src/utils/tui-client'

function createMockApi(overrides?: { current?: () => Promise<{ data: { id: string }; error?: unknown }> }): TuiPluginApi {
  return {
    state: {
      config: { provider: {} },
      path: { directory: '/test/project' },
    },
    client: {
      project: {
        current: vi.fn(overrides?.current ?? (async () => ({ data: { id: 'proj-1' }, error: undefined }))),
        list: vi.fn(async () => ({ data: [], error: undefined })),
      },
    } as any,
  } as unknown as TuiPluginApi
}

describe('resolveTuiProjectIdOnce single-flight', () => {
  test('shares one in-flight discovery across concurrent calls for the same API', async () => {
    const api = createMockApi()
    const [a, b, c] = await Promise.all([
      resolveTuiProjectIdOnce(api, '/test/project'),
      resolveTuiProjectIdOnce(api, '/test/project'),
      resolveTuiProjectIdOnce(api, '/test/project'),
    ])
    expect(a).toBe('proj-1')
    expect(b).toBe('proj-1')
    expect(c).toBe('proj-1')
    expect(api.client.project.current).toHaveBeenCalledTimes(1)
  })

  test('runs a fresh discovery for a later call after the flight settles', async () => {
    const api = createMockApi()
    await resolveTuiProjectIdOnce(api, '/test/project')
    await resolveTuiProjectIdOnce(api, '/test/project')
    expect(api.client.project.current).toHaveBeenCalledTimes(2)
  })

  test('does not share flights across different directories', async () => {
    const api = createMockApi()
    await Promise.all([
      resolveTuiProjectIdOnce(api, '/test/a'),
      resolveTuiProjectIdOnce(api, '/test/b'),
    ])
    expect(api.client.project.current).toHaveBeenCalledTimes(2)
  })

  test('does not cache a null result so a later retry can re-discover', async () => {
    let calls = 0
    const api = createMockApi({
      current: async () => {
        calls += 1
        if (calls === 1) throw new Error('not ready')
        return { data: { id: 'proj-2' }, error: undefined }
      },
    })
    expect(await resolveTuiProjectIdOnce(api, '/test/project')).toBeNull()
    expect(await resolveTuiProjectIdOnce(api, '/test/project')).toBe('proj-2')
  })
})
