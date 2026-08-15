import { describe, test, expect } from 'vitest'
import { collectLegacySandboxConfigWarnings } from '../../src/sandbox/config-warnings'

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

  test('returns [] for undefined, null and non-object input', () => {
    expect(collectLegacySandboxConfigWarnings(undefined)).toEqual([])
    expect(collectLegacySandboxConfigWarnings(null)).toEqual([])
    expect(collectLegacySandboxConfigWarnings('x')).toEqual([])
    expect(collectLegacySandboxConfigWarnings([1, 2])).toEqual([])
  })
})
