import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { loadPluginConfig } from '../src/setup'
import { resolveForgeApiUrl, connectForgeProject } from '../src/utils/tui-client'

const TEST_DIR = '/tmp/opencode-forge-tui-remote-test-' + Date.now()

describe('TUI remote server config', () => {
  let testConfigDir: string
  let testDataDir: string
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    testConfigDir = TEST_DIR + '-config-' + Math.random().toString(36).slice(2)
    testDataDir = TEST_DIR + '-data-' + Math.random().toString(36).slice(2)
    mkdirSync(testConfigDir, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })
    process.env['XDG_CONFIG_HOME'] = testConfigDir
    process.env['XDG_DATA_HOME'] = testDataDir
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    delete process.env['XDG_CONFIG_HOME']
    delete process.env['XDG_DATA_HOME']
    if (existsSync(testConfigDir)) {
      rmSync(testConfigDir, { recursive: true, force: true })
    }
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true })
    }
  })

  test('loadPluginConfig preserves tui.remoteServer.url when set', () => {
    const configPath = join(testConfigDir, 'opencode', 'forge-config.jsonc')
    mkdirSync(join(testConfigDir, 'opencode'), { recursive: true })

    const configWithRemoteServer = {
      tui: {
        remoteServer: {
          url: 'http://remote.example:4096',
        },
      },
    }

    writeFileSync(configPath, JSON.stringify(configWithRemoteServer))

    const config = loadPluginConfig()
    expect(config.tui?.remoteServer?.url).toBe('http://remote.example:4096')
  })

  test('loadPluginConfig handles undefined tui.remoteServer', () => {
    const configPath = join(testConfigDir, 'opencode', 'forge-config.jsonc')
    mkdirSync(join(testConfigDir, 'opencode'), { recursive: true })

    const configWithoutRemoteServer = {
      tui: {
        sidebar: true,
      },
    }

    writeFileSync(configPath, JSON.stringify(configWithoutRemoteServer))

    const config = loadPluginConfig()
    expect(config.tui?.remoteServer?.url).toBeUndefined()
  })

  test('loadPluginConfig handles missing tui block', () => {
    const configPath = join(testConfigDir, 'opencode', 'forge-config.jsonc')
    mkdirSync(join(testConfigDir, 'opencode'), { recursive: true })

    const configWithoutTui = {
      logging: {
        enabled: false,
      },
    }

    writeFileSync(configPath, JSON.stringify(configWithoutTui))

    const config = loadPluginConfig()
    expect(config.tui).toBeUndefined()
  })

  test('default config enables local inbound Forge API', () => {
    const config = loadPluginConfig()

    expect(config.api?.enabled).toBe(true)
    expect(resolveForgeApiUrl(config)).toBe('http://127.0.0.1:5552')
  })

  test('resolveForgeApiUrl returns remote Forge API URL when configured', () => {
    const url = resolveForgeApiUrl({
      tui: {
        remoteServer: { url: 'http://remote.example:4096' },
      },
    } as any)

    expect(url).toBe('http://remote.example:4096')
  })

  test('resolveForgeApiUrl brackets IPv6 localhost', () => {
    const url = resolveForgeApiUrl({
      api: { enabled: true, host: '::1', port: 5552 },
    })

    expect(url).toBe('http://[::1]:5552')
  })

  test('connectForgeProject returns null for invalid remote URL', async () => {
    const client = await connectForgeProject({
      tui: {
        remoteServer: { url: 'not a url' },
      },
    } as any)
    expect(client).toBeNull()
  })

  test('plan.execute posts execute, then prefs, then delete for loop mode', async () => {
    const requests: Array<{ url: string; method?: string; body?: string }> = []
    globalThis.fetch = mock(async (url, init) => {
      const u = String(url)
      requests.push({ url: u, method: init?.method, body: init?.body as string })
      if (u.endsWith('/api/v1/projects')) {
        return new Response(JSON.stringify({ ok: true, data: { projects: [{ id: 'project-1' }] } }), { status: 200 })
      }
      if (u.includes('/models/preferences')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, data: { sessionId: 'session-1', loopName: 'loop-1' } }), { status: 202 })
    }) as unknown as typeof fetch

    const client = await connectForgeProject({ tui: { remoteServer: { url: 'http://remote.example:4096' } } })
    const result = await client?.plan.execute('host-session', {
      mode: 'loop', title: 'Plan', plan: '# Plan',
      executionModel: 'provider/exec', auditorModel: 'provider/auditor',
    }, { mode: 'Loop', executionModel: 'provider/exec', auditorModel: 'provider/auditor' })

    expect(result?.loopName).toBe('loop-1')
    // 1: project resolution, 2: execute, 3: prefs PUT, 4: plan DELETE
    expect(requests.length).toBe(4)
    expect(requests[1]?.url).toContain('/plans/session/host-session/execute')
    expect(requests[1]?.method).toBe('POST')
    expect(requests[2]?.url).toContain('/models/preferences')
    expect(requests[2]?.method).toBe('PUT')
    expect(requests[3]?.url).toContain('/plans/session/host-session')
    expect(requests[3]?.method).toBe('DELETE')
  })

  test('loops.start posts worktree and auditor model to the API', async () => {
    const requests: Array<{ url: string; method?: string; body?: string }> = []
    globalThis.fetch = mock(async (url, init) => {
      const u = String(url)
      requests.push({ url: u, method: init?.method, body: init?.body as string })
      if (u.endsWith('/api/v1/projects')) {
        return new Response(JSON.stringify({ ok: true, data: { projects: [{ id: 'project-1' }] } }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, data: { sessionId: 'session-1', loopName: 'loop-1', worktreeDir: '/tmp/wt' } }), { status: 202 })
    }) as unknown as typeof fetch

    const client = await connectForgeProject({ tui: { remoteServer: { url: 'http://remote.example:4096' } } })
    const result = await client?.loops.start({
      title: 'Plan', plan: '# Plan', worktree: true,
      executionModel: 'provider/exec', auditorModel: 'provider/auditor',
      hostSessionId: 'host-session',
    })

    expect(result?.worktreeDir).toBe('/tmp/wt')
    expect(requests.length).toBe(2)
    expect(requests[1]?.url).toContain('/api/v1/projects/project-1/loops')
    expect(requests[1]?.method).toBe('POST')
    expect(JSON.parse(requests[1]?.body as string)).toEqual({
      title: 'Plan',
      plan: '# Plan',
      worktree: true,
      executionModel: 'provider/exec',
      auditorModel: 'provider/auditor',
      hostSessionId: 'host-session',
    })
  })

  test('loadExecutionContext fetches preferences and models in parallel', async () => {
    const requests: string[] = []
    globalThis.fetch = mock(async (url) => {
      const u = String(url)
      requests.push(u)
      if (u.endsWith('/api/v1/projects')) {
        return new Response(JSON.stringify({ ok: true, data: { projects: [{ id: 'p' }] } }), { status: 200 })
      }
      if (u.includes('/models/preferences')) {
        return new Response(JSON.stringify({ ok: true, data: { mode: 'Loop', executionModel: 'm/x' } }), { status: 200 })
      }
      if (u.endsWith('/models')) {
        return new Response(JSON.stringify({ ok: true, data: { providers: [{ id: 'anthropic' }] } }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch

    const client = await connectForgeProject({ tui: { remoteServer: { url: 'http://remote.example:4096' } } })
    const ctx = await client!.loadExecutionContext()
    expect(ctx.preferences?.mode).toBe('Loop')
    expect(ctx.models.providers.length).toBe(1)
    expect(requests.some(u => u.includes('/models/preferences'))).toBe(true)
    expect(requests.some(u => u.endsWith('/models'))).toBe(true)
  })

  test('connectForgeProject prefers project matching requested directory', async () => {
    const requests: string[] = []
    globalThis.fetch = mock(async (url) => {
      const u = String(url)
      requests.push(u)
      if (u.includes('/api/v1/projects?directory=')) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: { projects: [{ id: 'project-b', directory: '/repo/b' }] },
          }),
          { status: 200 }
        )
      }
      if (u.includes('/api/v1/projects/project-b/loops')) {
        return new Response(JSON.stringify({ ok: true, data: { loops: [], active: [], recent: [] } }), {
          status: 200,
        })
      }
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch

    const client = await connectForgeProject(
      { tui: { remoteServer: { url: 'http://remote.example:4096' } } },
      '/repo/b'
    )
    expect(client).not.toBeNull()

    await client!.loops.list()
    expect(requests[0]).toContain('/api/v1/projects?directory=%2Frepo%2Fb')
    expect(requests[1]).toContain('/api/v1/projects/project-b/loops')
  })
})
