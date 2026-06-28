import { describe, test, expect, vi } from 'vitest'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import { connectForgeProject } from '../src/utils/tui-client'

function createMockApi(): TuiPluginApi {
  return {
    state: {
      config: {
        provider: {},
      },
      path: {
        directory: '/test/project',
      },
    },
    client: {
      provider: {
        list: vi.fn(() => Promise.resolve({ data: { all: [], connected: [] } })),
      },
      experimental: {
        workspace: {
          create: vi.fn(async () => ({
            data: { id: 'ws-default', directory: '/tmp/default', branch: 'default' },
            error: undefined,
          })),
          list: vi.fn(() => Promise.resolve({ data: [], error: undefined })),
          status: vi.fn(() => Promise.resolve({ data: [], error: undefined })),
          syncList: vi.fn(() => Promise.resolve({ data: undefined, error: undefined })),
          remove: vi.fn(() => Promise.resolve({ data: undefined, error: undefined })),
          warp: vi.fn(() => Promise.resolve({ data: undefined, error: undefined })),
        },
      },
      session: {
        create: vi.fn(async () => ({ data: { id: 'sess-default' }, error: undefined })),
        list: vi.fn(() => Promise.resolve({ data: [], error: undefined })),
        status: vi.fn(() => Promise.resolve({ data: {}, error: undefined })),
        promptAsync: vi.fn(() => Promise.resolve({ data: undefined, error: undefined })),
        messages: vi.fn(() => Promise.resolve({ data: [], error: undefined })),
        get: vi.fn(() => Promise.resolve({ data: {}, error: undefined })),
      },
      project: {
        list: vi.fn(() => Promise.resolve({ data: [], error: undefined })),
      },
    } as any,
    ui: {
      toast: vi.fn(() => {}),
      dialog: {
        clear: vi.fn(() => {}),
        replace: vi.fn(() => {}),
        setSize: vi.fn(() => {}),
      },
    },
    theme: {
      current: {
        text: '#ffffff',
        textMuted: '#888888',
        border: '#444444',
        borderActive: '#007acc',
        success: '#4caf50',
        info: '#2194f3',
        danger: '#e53935',
        bg: '#1e1e1e',
        bgPanel: '#252526',
      },
    },
    route: {
      navigate: vi.fn(() => Promise.resolve()),
    },
  } as unknown as TuiPluginApi
}

describe('plan.execute(loop) workspace.create failure', () => {
  test('returns actionable error when workspace.create throws with experimental not enabled', async () => {
    const api = createMockApi()

    // Override experimental.workspace.create to throw
    api.client.experimental.workspace.create = vi.fn(async () => {
      throw new Error('experimental workspaces not enabled')
    })

    const project = await connectForgeProject(api, '/test/project')
    expect(project).not.toBeNull()
    if (!project) return

    const result = await project.plan.execute('sess-1', {
      mode: 'loop',
      title: 'Test Loop',
      plan: '# Test\n\nLoop test plan.',
    })

    expect(result).not.toBeNull()
    if (result && 'error' in result) {
      expect(result.error).toContain('OPENCODE_EXPERIMENTAL_WORKSPACES')
      expect(result.error).toContain('1.17.8')
    } else {
      expect(result).toHaveProperty('error')
    }
  })

  test('returns actionable error when workspace.create throws with empty message', async () => {
    const api = createMockApi()

    api.client.experimental.workspace.create = vi.fn(async () => {
      throw new Error('')
    })

    const project = await connectForgeProject(api, '/test/project')
    expect(project).not.toBeNull()
    if (!project) return

    const result = await project.plan.execute('sess-1', {
      mode: 'loop',
      title: 'Empty Error Loop',
      plan: '# Test\n\nEmpty error test.',
    })

    if (result && 'error' in result) {
      expect(result.error).toContain('OPENCODE_EXPERIMENTAL_WORKSPACES')
    } else {
      expect(result).toHaveProperty('error')
    }
  })

  test('returns null for non-create failures in the post-create flow', async () => {
    const api = createMockApi()

    // Mock workspace.status to report the workspace as connected so awaitWorkspaceConnected resolves quickly
    api.client.experimental.workspace.status = vi.fn(async () => ({
      data: [{ workspaceID: 'ws-default', status: 'connected' }],
      error: undefined,
    }))
    api.client.experimental.workspace.list = vi.fn(async () => ({
      data: [{ id: 'ws-default' }],
      error: undefined,
    }))

    // Make session.create fail (post-create path)
    api.client.session.create = vi.fn(async () => {
      throw new Error('session create failed')
    })

    const project = await connectForgeProject(api, '/test/project')
    expect(project).not.toBeNull()
    if (!project) return

    const result = await project.plan.execute('sess-1', {
      mode: 'loop',
      title: 'PostCreate Fail',
      plan: '# Test\n\nPost-create failure test.',
    })

    // Post-create failures should still return null (generic)
    expect(result).toBeNull()
  }, 10000)
})
