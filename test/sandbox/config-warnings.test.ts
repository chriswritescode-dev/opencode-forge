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
    expect(joined).toContain("sandbox.mode 'docker' is ignored")
    expect(joined).toContain("use mode 'sbx' (default) or 'smolvm'")
    expect(joined).toContain('sandbox.projectMountPath')
    expect(joined).toContain('sandbox.resources.shmSize')
    expect(joined).toContain('sandbox.resources.memorySwap')
    expect(joined).toContain('sandbox.network.hostGateway')
    expect(joined).toContain('sandbox.mounts')
  })

  test('returns [] for a clean sbx config', () => {
    expect(collectLegacySandboxConfigWarnings({ enabled: true, image: 'oc-forge-sandbox:latest' })).toEqual([])
  })

  test('returns [] for undefined, null and non-object input', () => {
    expect(collectLegacySandboxConfigWarnings(undefined)).toEqual([])
    expect(collectLegacySandboxConfigWarnings(null)).toEqual([])
    expect(collectLegacySandboxConfigWarnings('x')).toEqual([])
    expect(collectLegacySandboxConfigWarnings([1, 2])).toEqual([])
  })
})
