import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { loadPluginConfig, resolveConfigPath } from '../src/setup'
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
        maxFiles: 500,
        watch: true,
      },
    }

    writeFileSync(configPath, JSON.stringify(graphConfig))

    const config = loadPluginConfig()
    expect(config.graph?.enabled).toBe(true)
    expect(config.graph?.maxFiles).toBe(500)
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
    expect(parsed.defaultKvTtlMs).toBeDefined()
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

  test('bundled config includes dataDir and defaultKvTtlMs', () => {
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
    expect(parsed.defaultKvTtlMs).toBe(604800000)
  })
})
