import { describe, test, expect } from 'vitest'
import { DASHBOARD_APP_BUNDLE, DASHBOARD_APP_SOURCE_HASH } from '../../src/dashboard/app-bundle'
import { computeDashboardAppSourceHash } from '../../scripts/dashboard-source-hash'

describe('DASHBOARD_APP_BUNDLE', () => {
  test('is a non-empty string', () => {
    expect(typeof DASHBOARD_APP_BUNDLE).toBe('string')
    expect(DASHBOARD_APP_BUNDLE.length).toBeGreaterThan(1000)
  })

  test('contains expected API endpoint reference', () => {
    expect(DASHBOARD_APP_BUNDLE).toContain('/api/data')
  })

  test('contains forge-app-root element id', () => {
    expect(DASHBOARD_APP_BUNDLE).toContain('forge-app-root')
  })
})

describe('DASHBOARD_APP_SOURCE_HASH', () => {
  test('app-bundle is in sync with app source (run `pnpm build` to regenerate if this fails)', () => {
    expect(computeDashboardAppSourceHash()).toBe(DASHBOARD_APP_SOURCE_HASH)
  })
})
