import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { loadPluginConfig } from '../src/setup'
import { resolveTuiClient } from '../src/utils/tui-client'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'

const TEST_DIR = '/tmp/opencode-forge-tui-remote-test-' + Date.now()

function createMockApi(): TuiPluginApi {
  return {
    client: { local: true },
    state: {
      path: { directory: TEST_DIR },
    },
    ui: {
      toast: mock(() => {}),
    },
  } as unknown as TuiPluginApi
}

describe('TUI remote server config', () => {
  let testConfigDir: string
  let testDataDir: string

  beforeEach(() => {
    testConfigDir = TEST_DIR + '-config-' + Math.random().toString(36).slice(2)
    testDataDir = TEST_DIR + '-data-' + Math.random().toString(36).slice(2)
    mkdirSync(testConfigDir, { recursive: true })
    mkdirSync(testDataDir, { recursive: true })
    process.env['XDG_CONFIG_HOME'] = testConfigDir
    process.env['XDG_DATA_HOME'] = testDataDir
  })

  afterEach(() => {
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

  test('resolveTuiClient returns local client when no remote URL is configured', () => {
    const api = createMockApi()

    const client = resolveTuiClient(api, undefined)

    expect(client).toBe(api.client)
  })

  test('resolveTuiClient returns remote client for valid remote URL', () => {
    const api = createMockApi()

    const client = resolveTuiClient(api, {
      remoteServer: { url: 'http://remote.example:4096' },
    } as any)

    expect(client).not.toBe(api.client)
    expect(api.ui.toast).not.toHaveBeenCalled()
  })

  test('resolveTuiClient falls back to local client for invalid remote URL', () => {
    const api = createMockApi()

    const client = resolveTuiClient(api, {
      remoteServer: { url: 'not a url' },
    } as any)

    expect(client).toBe(api.client)
    expect(api.ui.toast).toHaveBeenCalledWith(expect.objectContaining({
      variant: 'warning',
    }))
  })
})
