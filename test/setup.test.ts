import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { loadPluginConfig, resolveConfigPath } from '../src/setup'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const TEST_DIR = '/tmp/opencode-forge-setup-test-' + Date.now()

describe('loadPluginConfig', () => {
  let testConfigDir: string

  beforeEach(() => {
    testConfigDir = TEST_DIR + '-config-' + Math.random().toString(36).slice(2)
    mkdirSync(testConfigDir, { recursive: true })
    process.env['XDG_CONFIG_HOME'] = testConfigDir
  })

  afterEach(() => {
    delete process.env['XDG_CONFIG_HOME']
    if (existsSync(testConfigDir)) {
      rmSync(testConfigDir, { recursive: true, force: true })
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
})
