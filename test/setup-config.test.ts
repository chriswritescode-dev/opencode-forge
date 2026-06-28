import { describe, test, expect } from 'vitest'
import { loadPluginConfig } from '../src/setup'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { useTempConfigHome } from './helpers/temp-config'

describe('groupLaunch config normalization', () => {
  const getConfigDir = useTempConfigHome('opencode-forge-group-launch-test')

  test('defaults maxConcurrentLoops to 3 when no groupLaunch config is provided', () => {
    const configPath = join(getConfigDir(), 'opencode', 'forge-config.jsonc')
    mkdirSync(join(getConfigDir(), 'opencode'), { recursive: true })

    writeFileSync(configPath, JSON.stringify({ logging: { enabled: false, file: '' } }))

    const config = loadPluginConfig()
    expect(config.groupLaunch).toBeDefined()
    expect(config.groupLaunch?.maxConcurrentLoops).toBe(3)
  })

  test('clamps maxConcurrentLoops to 1 when value is less than 1', () => {
    const configPath = join(getConfigDir(), 'opencode', 'forge-config.jsonc')
    mkdirSync(join(getConfigDir(), 'opencode'), { recursive: true })

    writeFileSync(configPath, JSON.stringify({
      groupLaunch: { maxConcurrentLoops: 0 },
    }))

    const config = loadPluginConfig()
    expect(config.groupLaunch?.maxConcurrentLoops).toBe(1)
  })

  test('clamps maxConcurrentLoops to 1 when value is negative', () => {
    const configPath = join(getConfigDir(), 'opencode', 'forge-config.jsonc')
    mkdirSync(join(getConfigDir(), 'opencode'), { recursive: true })

    writeFileSync(configPath, JSON.stringify({
      groupLaunch: { maxConcurrentLoops: -5 },
    }))

    const config = loadPluginConfig()
    expect(config.groupLaunch?.maxConcurrentLoops).toBe(1)
  })

  test('passes through explicit maxConcurrentLoops value', () => {
    const configPath = join(getConfigDir(), 'opencode', 'forge-config.jsonc')
    mkdirSync(join(getConfigDir(), 'opencode'), { recursive: true })

    writeFileSync(configPath, JSON.stringify({
      groupLaunch: { maxConcurrentLoops: 5 },
    }))

    const config = loadPluginConfig()
    expect(config.groupLaunch?.maxConcurrentLoops).toBe(5)
  })

  test('defaults groupLaunch when groupLaunch is present but empty', () => {
    const configPath = join(getConfigDir(), 'opencode', 'forge-config.jsonc')
    mkdirSync(join(getConfigDir(), 'opencode'), { recursive: true })

    writeFileSync(configPath, JSON.stringify({
      groupLaunch: {},
    }))

    const config = loadPluginConfig()
    expect(config.groupLaunch?.maxConcurrentLoops).toBe(3)
  })
})
