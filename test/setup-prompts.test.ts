import { describe, test, expect } from 'vitest'
import { loadPluginConfig, resolvePromptsDir } from '../src/setup'
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { useTempConfigHome } from './helpers/temp-config'

describe('ensureBundledPrompts', () => {
  const getConfigDir = useTempConfigHome('opencode-forge-prompts-test')

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

  test('creates manifest file with prompt entries', () => {
    const configDir = getConfigDir()
    const manifestPath = join(configDir, 'opencode', 'forge', 'manifests', 'prompts.json')

    loadPluginConfig()

    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    expect(manifest['agents/architect.md']).toBeDefined()
  })
})
