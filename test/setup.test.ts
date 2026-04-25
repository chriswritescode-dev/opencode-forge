import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { attachForgeApiServer } from '../src/api/server'
import { getProjectRegistry } from '../src/api/project-registry'
import { loadPluginConfig, resolveConfigPath } from '../src/setup'
import type { ToolContext } from '../src/tools/types'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const TEST_DIR = '/tmp/opencode-manager-memory-setup-test-' + Date.now()

describe('loadPluginConfig', () => {
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

  test('returns default config when no config file exists', () => {
    const config = loadPluginConfig()
    expect(config.logging).toBeDefined()
    expect(config.logging?.enabled).toBe(false)
  })

  test('reads and parses valid config file', () => {
    const configPath = join(testConfigDir, 'opencode', 'forge-config.jsonc')
    mkdirSync(join(testConfigDir, 'opencode'), { recursive: true })

    const validConfig = {
      logging: {
        enabled: true,
        debug: true,
      },
      loop: {
        enabled: true,
        defaultMaxIterations: 20,
      },
    }

    writeFileSync(configPath, JSON.stringify(validConfig))

    const config = loadPluginConfig()
    expect(config.logging?.enabled).toBe(true)
    expect(config.logging?.debug).toBe(true)
    expect(config.loop?.enabled).toBe(true)
  })

  test('returns defaults when file contains invalid JSON', () => {
    const configPath = join(testConfigDir, 'opencode', 'forge-config.jsonc')
    mkdirSync(join(testConfigDir, 'opencode'), { recursive: true })

    writeFileSync(configPath, 'invalid json content')

    const config = loadPluginConfig()
    expect(config.logging).toBeDefined()
  })

  test('loads config with graph settings', () => {
    const configPath = join(testConfigDir, 'opencode', 'forge-config.jsonc')
    mkdirSync(join(testConfigDir, 'opencode'), { recursive: true })

    const graphConfig = {
      graph: {
        enabled: true,
        watch: true,
      },
    }

    writeFileSync(configPath, JSON.stringify(graphConfig))

    const config = loadPluginConfig()
    expect(config.graph?.enabled).toBe(true)
  })

  test('loads config with sandbox settings', () => {
    const configPath = join(testConfigDir, 'opencode', 'forge-config.jsonc')
    mkdirSync(join(testConfigDir, 'opencode'), { recursive: true })

    const sandboxConfig = {
      sandbox: {
        mode: 'docker',
        image: 'custom-image:latest',
      },
    }

    writeFileSync(configPath, JSON.stringify(sandboxConfig))

    const config = loadPluginConfig()
    expect(config.sandbox?.mode).toBe('docker')
    expect(config.sandbox?.image).toBe('custom-image:latest')
  })
})

describe('resolveConfigPath', () => {
  let testConfigDir: string

  beforeEach(() => {
    testConfigDir = TEST_DIR + '-configpath-' + Math.random().toString(36).slice(2)
    mkdirSync(testConfigDir, { recursive: true })
  })

  afterEach(() => {
    delete process.env['XDG_CONFIG_HOME']
    if (existsSync(testConfigDir)) {
      rmSync(testConfigDir, { recursive: true, force: true })
    }
  })

  test('returns correct path based on XDG_CONFIG_HOME', () => {
    process.env['XDG_CONFIG_HOME'] = testConfigDir
    const configPath = resolveConfigPath()
    expect(configPath).toBe(join(testConfigDir, 'opencode', 'forge-config.jsonc'))
  })

  test('falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    delete process.env['XDG_CONFIG_HOME']
    const configPath = resolveConfigPath()
    const expectedDefault = join(homedir(), '.config', 'opencode', 'forge-config.jsonc')
    expect(configPath).toBe(expectedDefault)
  })
})

describe('bundled sample config', () => {
  let testConfigDir: string

  beforeEach(() => {
    testConfigDir = TEST_DIR + '-configpath-' + Math.random().toString(36).slice(2)
    mkdirSync(testConfigDir, { recursive: true })
  })

  afterEach(() => {
    delete process.env['XDG_CONFIG_HOME']
    if (existsSync(testConfigDir)) {
      rmSync(testConfigDir, { recursive: true, force: true })
    }
  })

  test('bundled forge-config.jsonc is valid JSONC and parses successfully', () => {
    const bundledConfigPath = join(import.meta.dir, '..', 'forge-config.jsonc')
    expect(existsSync(bundledConfigPath)).toBe(true)
    
    const content = readFileSync(bundledConfigPath, 'utf-8')
    expect(content).toBeDefined()
    
    const config = loadPluginConfig()
    const parsed = loadPluginConfig()
    expect(parsed).toBeDefined()
  })

  test('bundled config includes all supported top-level keys', () => {
    const bundledConfigPath = join(import.meta.dir, '..', 'forge-config.jsonc')
    const content = readFileSync(bundledConfigPath, 'utf-8')
    
    const stripComments = (text: string): string => {
      let result = text
      result = result.replace(/\/\*[\s\S]*?\*\//g, '')
      result = result.replace(/(^|[^:])(\/\/.*$)/gm, '$1')
      return result
    }
    
    const stripTrailingCommas = (text: string): string => {
      let result = text
      result = result.replace(/,(\s*}[ \t\n\r]*)/g, '$1')
      result = result.replace(/,(\s*][ \t\n\r]*)/g, '$1')
      return result
    }
    
    const cleaned = stripComments(content)
    const normalized = stripTrailingCommas(cleaned)
    const parsed = JSON.parse(normalized)
    
    expect(parsed.dataDir).toBeDefined()
    expect(parsed.logging).toBeDefined()
    expect(parsed.compaction).toBeDefined()
    expect(parsed.messagesTransform).toBeDefined()
    expect(parsed.executionModel).toBeDefined()
    expect(parsed.auditorModel).toBeDefined()
    expect(parsed.loop).toBeDefined()
    expect(parsed.sandbox).toBeDefined()
    expect(parsed.graph).toBeDefined()
    expect(parsed.tui).toBeDefined()
    expect(parsed.completedLoopTtlMs).toBeDefined()
  })

  test('bundled config compaction includes maxContextTokens', () => {
    const bundledConfigPath = join(import.meta.dir, '..', 'forge-config.jsonc')
    const content = readFileSync(bundledConfigPath, 'utf-8')
    
    const stripComments = (text: string): string => {
      let result = text
      result = result.replace(/\/\*[\s\S]*?\*\//g, '')
      result = result.replace(/(^|[^:])(\/\/.*$)/gm, '$1')
      return result
    }
    
    const stripTrailingCommas = (text: string): string => {
      let result = text
      result = result.replace(/,(\s*}[ \t\n\r]*)/g, '$1')
      result = result.replace(/,(\s*][ \t\n\r]*)/g, '$1')
      return result
    }
    
    const cleaned = stripComments(content)
    const normalized = stripTrailingCommas(cleaned)
    const parsed = JSON.parse(normalized)
    
    expect(parsed.compaction?.maxContextTokens).toBeDefined()
  })

  test('bundled config includes dataDir and completedLoopTtlMs', () => {
    const bundledConfigPath = join(import.meta.dir, '..', 'forge-config.jsonc')
    const content = readFileSync(bundledConfigPath, 'utf-8')
    
    const stripComments = (text: string): string => {
      let result = text
      result = result.replace(/\/\*[\s\S]*?\*\//g, '')
      result = result.replace(/(^|[^:])(\/\/.*$)/gm, '$1')
      return result
    }
    
    const stripTrailingCommas = (text: string): string => {
      let result = text
      result = result.replace(/,(\s*}[ \t\n\r]*)/g, '$1')
      result = result.replace(/,(\s*][ \t\n\r]*)/g, '$1')
      return result
    }
    
    const cleaned = stripComments(content)
    const normalized = stripTrailingCommas(cleaned)
    const parsed = JSON.parse(normalized)
    
    expect(parsed.dataDir).toBeDefined()
    expect(parsed.completedLoopTtlMs).toBe(604800000)
  })

  test('bundled config includes loop.worktreeLogging and is disabled by default', () => {
    const bundledConfigPath = join(import.meta.dir, '..', 'forge-config.jsonc')
    const content = readFileSync(bundledConfigPath, 'utf-8')
    
    const stripComments = (text: string): string => {
      let result = text
      result = result.replace(/\/\*[\s\S]*?\*\//g, '')
      result = result.replace(/(^|[^:])(\/\/.*$)/gm, '$1')
      return result
    }
    
    const stripTrailingCommas = (text: string): string => {
      let result = text
      result = result.replace(/,(\s*}[ \t\n\r]*)/g, '$1')
      result = result.replace(/,(\s*][ \t\n\r]*)/g, '$1')
      return result
    }
    
    const cleaned = stripComments(content)
    const normalized = stripTrailingCommas(cleaned)
    const parsed = JSON.parse(normalized)
    
    expect(parsed.loop?.worktreeLogging).toBeDefined()
    expect(parsed.loop?.worktreeLogging?.enabled).toBe(false)
  })

  test('JSONC parsing preserves worktreeLogging config', () => {
    const configPath = join(testConfigDir, 'opencode', 'forge-config.jsonc')
    mkdirSync(join(testConfigDir, 'opencode'), { recursive: true })
    process.env['XDG_CONFIG_HOME'] = testConfigDir

    const configWithWorktreeLogging = {
      loop: {
        enabled: true,
        worktreeLogging: {
          enabled: true,
          directory: '/tmp/loop-logs',
        },
      },
    }

    writeFileSync(configPath, JSON.stringify(configWithWorktreeLogging))

    const config = loadPluginConfig()
    expect(config.loop?.worktreeLogging).toBeDefined()
    expect(config.loop?.worktreeLogging?.enabled).toBe(true)
    expect(config.loop?.worktreeLogging?.directory).toBe('/tmp/loop-logs')
  })

  test('bundled config includes api section with defaults', () => {
    const bundledConfigPath = join(import.meta.dir, '..', 'forge-config.jsonc')
    const content = readFileSync(bundledConfigPath, 'utf-8')
    
    const stripComments = (text: string): string => {
      let result = text
      result = result.replace(/\/\*[\s\S]*?\*\//g, '')
      result = result.replace(/(^|[^:])(\/\/.*$)/gm, '$1')
      return result
    }
    
    const stripTrailingCommas = (text: string): string => {
      let result = text
      result = result.replace(/,(\s*}[ \t\n\r]*)/g, '$1')
      result = result.replace(/,(\s*][ \t\n\r]*)/g, '$1')
      return result
    }
    
    const cleaned = stripComments(content)
    const normalized = stripTrailingCommas(cleaned)
    const parsed = JSON.parse(normalized)
    
    expect(parsed.api).toBeDefined()
    expect(parsed.api?.enabled).toBe(true)
    expect(parsed.api?.host).toBe('127.0.0.1')
    expect(parsed.api?.port).toBe(5552)
  })

  test('loadPluginConfig surfaces api.enabled as true by default', () => {
    // Set up test config directory to use bundled config
    const configPath = join(testConfigDir, 'opencode', 'forge-config.jsonc')
    mkdirSync(join(testConfigDir, 'opencode'), { recursive: true })
    process.env['XDG_CONFIG_HOME'] = testConfigDir

    // Copy bundled config to test location
    const bundledConfigPath = join(import.meta.dir, '..', 'forge-config.jsonc')
    const bundledContent = readFileSync(bundledConfigPath, 'utf-8')
    writeFileSync(configPath, bundledContent)

    const config = loadPluginConfig()
    expect(config.api?.enabled).toBe(true)
  })

  test('loadPluginConfig round-trips user-supplied api block', () => {
    const configPath = join(testConfigDir, 'opencode', 'forge-config.jsonc')
    mkdirSync(join(testConfigDir, 'opencode'), { recursive: true })
    process.env['XDG_CONFIG_HOME'] = testConfigDir

    const configWithApi = {
      api: {
        enabled: true,
        host: '0.0.0.0',
        port: 8080,
      },
    }

    writeFileSync(configPath, JSON.stringify(configWithApi))

    const config = loadPluginConfig()
    expect(config.api?.enabled).toBe(true)
    expect(config.api?.host).toBe('0.0.0.0')
    expect(config.api?.port).toBe(8080)
  })

  test('loadPluginConfig round-trips tui.remoteServer.url', () => {
    const configPath = join(testConfigDir, 'opencode', 'forge-config.jsonc')
    mkdirSync(join(testConfigDir, 'opencode'), { recursive: true })
    process.env['XDG_CONFIG_HOME'] = testConfigDir

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
})

describe('bundled config documents OPENCODE_SERVER_PASSWORD contract', () => {
  test('bundled forge-config.jsonc mentions OPENCODE_SERVER_PASSWORD near api block', () => {
    const bundledConfigPath = join(import.meta.dir, '..', 'forge-config.jsonc')
    const content = readFileSync(bundledConfigPath, 'utf-8')
    expect(content).toContain('OPENCODE_SERVER_PASSWORD')
    expect(content).toContain('"::1"')
  })

  test('README Remote API section documents ::1 and no-start behavior', () => {
    const readmePath = join(import.meta.dir, '..', 'README.md')
    const content = readFileSync(readmePath, 'utf-8')
    expect(content).toContain('::1')
    expect(content).toContain('OPENCODE_SERVER_PASSWORD')
    expect(content).not.toContain('the server refuses to start')
  })

  test('bundled config and README document tui.remoteServer.url', () => {
    const bundledConfigPath = join(import.meta.dir, '..', 'forge-config.jsonc')
    const configContent = readFileSync(bundledConfigPath, 'utf-8')
    expect(configContent).toContain('remoteServer')
    expect(configContent).toContain('OPENCODE_SERVER_PASSWORD')

    const readmePath = join(import.meta.dir, '..', 'README.md')
    const readmeContent = readFileSync(readmePath, 'utf-8')
    expect(readmeContent).toContain('tui.remoteServer.url')
  })
})

describe('remote API startup authentication requirements', () => {
  const originalPassword = process.env.OPENCODE_SERVER_PASSWORD

  afterEach(() => {
    if (originalPassword === undefined) {
      delete process.env.OPENCODE_SERVER_PASSWORD
    } else {
      process.env.OPENCODE_SERVER_PASSWORD = originalPassword
    }
  })

  test('does not start for non-localhost host without OPENCODE_SERVER_PASSWORD', () => {
    delete process.env.OPENCODE_SERVER_PASSWORD
    const errors: string[] = []
    const ctx = {
      projectId: 'test-project',
      config: {
        api: {
          enabled: true,
          host: '0.0.0.0',
          port: 5552,
        },
      },
      logger: {
        log: () => {},
        debug: () => {},
        error: (message: string) => {
          errors.push(message)
        },
      },
    } as unknown as ToolContext

    const registry = getProjectRegistry()
    registry.register(ctx)
    const server = attachForgeApiServer(ctx, registry)
    registry.unregister(ctx.projectId)

    expect(server).toBeNull()
    expect(errors).toEqual([
      '[api] refusing to start: host=0.0.0.0 requires OPENCODE_SERVER_PASSWORD',
    ])
  })
})
