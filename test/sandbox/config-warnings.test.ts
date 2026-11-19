import { describe, test, expect } from 'vitest'
import {
  collectLegacySandboxConfigWarnings,
  collectMacosSandboxConfigWarnings,
} from '../../src/sandbox/config-warnings'
import type { SandboxConfig } from '../../src/types'

describe('collectLegacySandboxConfigWarnings', () => {
  test('reports one message per legacy key present', () => {
    const raw = {
      mode: 'docker',
      projectMountPath: '/project',
      resources: { shmSize: '1g', memorySwap: '12g' },
      network: { hostGateway: true },
      mounts: [{ host: '/a', container: '/b' }],
    }
    const warnings = collectLegacySandboxConfigWarnings(raw)
    expect(warnings).toHaveLength(6)
    const joined = warnings.join('\n')
    expect(joined).toContain('sandbox.mode')
    expect(joined).toContain('sandbox.projectMountPath')
    expect(joined).toContain('sandbox.resources.shmSize')
    expect(joined).toContain('sandbox.resources.memorySwap')
    expect(joined).toContain('sandbox.network.hostGateway')
    expect(joined).toContain('sandbox.mounts')
  })

  test('reports exactly one msb-replacement warning for the retired sbx mode', () => {
    const warnings = collectLegacySandboxConfigWarnings({ mode: 'sbx' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('msb')
    expect(warnings[0]).toContain('use mode')
  })

  test('returns [] for a clean msb config', () => {
    expect(collectLegacySandboxConfigWarnings({ enabled: true, mode: 'msb', image: 'oc-forge-sandbox:latest' })).toEqual([])
  })

  test('returns [] for a clean macos config', () => {
    expect(collectLegacySandboxConfigWarnings({ mode: 'macos' })).toEqual([])
  })

  test('names both supported modes when warning about an unknown mode', () => {
    const warnings = collectLegacySandboxConfigWarnings({ mode: 'unknown-driver' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("'msb'")
    expect(warnings[0]).toContain("'macos'")
  })

  test('returns [] for undefined, null and non-object input', () => {
    expect(collectLegacySandboxConfigWarnings(undefined)).toEqual([])
    expect(collectLegacySandboxConfigWarnings(null)).toEqual([])
    expect(collectLegacySandboxConfigWarnings('x')).toEqual([])
    expect(collectLegacySandboxConfigWarnings([1, 2])).toEqual([])
  })
})

describe('collectMacosSandboxConfigWarnings', () => {
  test('reports one warning per ignored key in the macOS mode', () => {
    const sandbox: SandboxConfig = {
      mode: 'macos',
      resources: { dockerDisk: '10g', cacheDisk: '5g', cpus: '4', memory: '8g' },
      network: {
        allowLan: true,
        env: ['FOO=1'],
        secrets: [{ env: 'TOKEN', hosts: ['example.com'] }],
      },
    }
    const warnings = collectMacosSandboxConfigWarnings(sandbox)
    expect(warnings).toHaveLength(7)
    const prefixes = [
      'sandbox.resources.dockerDisk is ignored in the macOS sandbox mode:',
      'sandbox.resources.cacheDisk is ignored in the macOS sandbox mode:',
      'sandbox.resources.cpus is ignored in the macOS sandbox mode:',
      'sandbox.resources.memory is ignored in the macOS sandbox mode:',
      'sandbox.network.allowLan is ignored in the macOS sandbox mode:',
      'sandbox.network.env is ignored in the macOS sandbox mode:',
      'sandbox.network.secrets is ignored in the macOS sandbox mode:',
    ]
    prefixes.forEach((prefix, index) => {
      expect(warnings[index]?.startsWith(prefix)).toBe(true)
    })
  })

  test('reports exactly one warning for a single ignored key', () => {
    const warnings = collectMacosSandboxConfigWarnings({ mode: 'macos', resources: { cpus: '4' } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.startsWith('sandbox.resources.cpus is ignored in the macOS sandbox mode:')).toBe(true)
  })

  test('returns [] for a clean macos config', () => {
    expect(collectMacosSandboxConfigWarnings({ mode: 'macos' })).toEqual([])
  })

  test('returns [] for the same keys in the msb mode', () => {
    const sandbox: SandboxConfig = {
      mode: 'msb',
      resources: { dockerDisk: '10g', cacheDisk: '5g', cpus: '4', memory: '8g' },
      network: {
        allowLan: true,
        env: ['FOO=1'],
        secrets: [{ env: 'TOKEN', hosts: ['example.com'] }],
      },
    }
    expect(collectMacosSandboxConfigWarnings(sandbox)).toEqual([])
  })

  test('returns [] for undefined and null', () => {
    expect(collectMacosSandboxConfigWarnings(undefined)).toEqual([])
    expect(collectMacosSandboxConfigWarnings(null)).toEqual([])
  })
})
