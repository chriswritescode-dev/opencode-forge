import { describe, expect, test } from 'vitest'
import { readLoopSandboxSettings, resolveSandboxResources, SANDBOX_RESOURCE_DEFAULTS } from '../../src/sandbox/loop-settings'

describe('readLoopSandboxSettings', () => {
  test('keeps valid fields and normalizes sizes', () => {
    expect(readLoopSandboxSettings({ enabled: false, resources: { cpus: ' 8 ', memory: '16GB', dockerDisk: '32g', cacheDisk: '1024m' } }))
      .toEqual({ enabled: false, resources: { cpus: '8', memory: '16gb', dockerDisk: '32g', cacheDisk: '1024m' } })
  })

  test('drops invalid fields and returns undefined when nothing valid remains', () => {
    expect(readLoopSandboxSettings({ enabled: 'no', resources: { cpus: '0', memory: 'lots', cacheDisk: 16 } })).toBeUndefined()
    expect(readLoopSandboxSettings({ resources: { cpus: '2.5', memory: '4g' } })).toEqual({ resources: { memory: '4g' } })
    expect(readLoopSandboxSettings(null)).toBeUndefined()
    expect(readLoopSandboxSettings([])).toBeUndefined()
    expect(readLoopSandboxSettings({})).toBeUndefined()
  })
})

describe('resolveSandboxResources', () => {
  test('layers override over config over defaults per field', () => {
    expect(resolveSandboxResources()).toEqual(SANDBOX_RESOURCE_DEFAULTS)
    expect(resolveSandboxResources({ memory: '12g', cpus: '6' }, { cpus: '10' }))
      .toEqual({ memory: '12g', cpus: '10', dockerDisk: '16g', cacheDisk: '16g' })
  })
})
