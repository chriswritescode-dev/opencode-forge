import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { loadPluginConfig, resolvePromptsDir } from '../src/setup'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'

const TEST_DIR = '/tmp/opencode-forge-prompts-test-' + Date.now()

describe('ensureBundledPrompts', () => {
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

  test('installs bundled prompts on first loadPluginConfig call', () => {
    loadPluginConfig()

    const promptsDir = resolvePromptsDir()
    const architectPath = join(promptsDir, 'agents', 'architect.md')
    expect(existsSync(architectPath)).toBe(true)
    const content = readFileSync(architectPath, 'utf-8')
    expect(content).toContain('planning agent')
  })

  test('does not overwrite existing user prompts', () => {
    const promptsDir = resolvePromptsDir()
    const architectPath = join(promptsDir, 'agents', 'architect.md')
    mkdirSync(join(promptsDir, 'agents'), { recursive: true })
    writeFileSync(architectPath, 'CUSTOM')

    loadPluginConfig()

    const content = readFileSync(architectPath, 'utf-8')
    expect(content).toBe('CUSTOM')
  })

  test('restores deleted bundled prompts on next loadPluginConfig call', () => {
    // First install
    loadPluginConfig()

    const promptsDir = resolvePromptsDir()
    const codePath = join(promptsDir, 'agents', 'code.md')
    expect(existsSync(codePath)).toBe(true)

    // Delete a bundled file
    unlinkSync(codePath)
    expect(existsSync(codePath)).toBe(false)

    // Second load restores the deleted file
    loadPluginConfig()

    expect(existsSync(codePath)).toBe(true)
    const content = readFileSync(codePath, 'utf-8')
    expect(content).toContain('coding agent')
  })
})
