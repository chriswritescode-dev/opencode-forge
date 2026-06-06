import { describe, test, expect } from 'vitest'
import { buildAgents } from '../src/agents'

const agents = buildAgents()

describe('per-agent tools.exclude (regression guard)', () => {
  test('code agent excludes review and plan tools but can launch loops', () => {
    const excluded = agents.code.tools?.exclude ?? []
    for (const tool of ['review-write', 'review-delete', 'plan', 'plan_enter', 'plan_exit']) {
      expect(excluded).toContain(tool)
    }
    expect(excluded).not.toContain('loop')
  })

  test('auditor agent excludes plan/loop tools but NOT review tools', () => {
    const excluded = agents.auditor.tools?.exclude ?? []
    for (const tool of ['plan', 'plan_exit', 'loop', 'loop-cancel', 'loop-status']) {
      expect(excluded).toContain(tool)
    }
    // Auditor MUST be allowed to use review-write and review-delete.
    expect(excluded).not.toContain('review-write')
    expect(excluded).not.toContain('review-delete')
  })

  test('no agent retains plan-execute in tools.exclude (regression: tool removed)', () => {
    for (const role of ['code', 'auditor'] as const) {
      expect(agents[role].tools?.exclude ?? []).not.toContain('plan-execute')
    }
  })
})
