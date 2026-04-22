import { describe, test, expect } from 'bun:test'
import { agents } from '../src/agents'

describe('per-agent tools.exclude (regression guard)', () => {
  test('code agent excludes review/plan/loop tools', () => {
    const excluded = agents.code.tools?.exclude ?? []
    for (const tool of ['review-write', 'review-delete', 'plan-execute', 'plan-write', 'plan-edit', 'loop']) {
      expect(excluded).toContain(tool)
    }
  })

  test('auditor agent excludes plan/loop tools but NOT review tools', () => {
    const excluded = agents.auditor.tools?.exclude ?? []
    for (const tool of ['plan-execute', 'loop', 'plan-write', 'plan-edit', 'loop-cancel', 'loop-status']) {
      expect(excluded).toContain(tool)
    }
    // Auditor MUST be allowed to use review-write and review-delete.
    expect(excluded).not.toContain('review-write')
    expect(excluded).not.toContain('review-delete')
  })
})
