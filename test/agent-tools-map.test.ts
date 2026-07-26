import { describe, test, expect } from 'vitest'
import { buildAgents } from '../src/agents'

const agents = buildAgents()

describe('per-agent tools.exclude (regression guard)', () => {
  test('code agent excludes review and plan tools but can launch loops', () => {
    const excluded = agents.code.tools?.exclude ?? []
    for (const tool of ['review-write', 'review-delete', 'plan', 'plan_enter', 'plan_exit', 'plan-write', 'plan-edit']) {
      expect(excluded).toContain(tool)
    }
    expect(excluded).not.toContain('execute-plan')
    // Post-action sessions need skill and task tools to load skills and spawn subagents.
    expect(excluded).not.toContain('skill')
    expect(excluded).not.toContain('task')
  })

  test('auditor agent excludes plan/loop tools but NOT review tools', () => {
    const excluded = agents.auditor.tools?.exclude ?? []
    for (const tool of ['plan', 'plan_exit', 'execute-plan', 'loop-cancel', 'loop-status', 'plan-write', 'plan-edit']) {
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

  test('feature-splitter excludes plan-authoring tools', () => {
    const excluded = agents['feature-splitter'].tools?.exclude ?? []
    for (const tool of ['plan-write', 'plan-edit']) {
      expect(excluded).toContain(tool)
    }
  })

  test('architect and architect-auto retain plan-authoring tools', () => {
    for (const role of ['architect', 'architect-auto'] as const) {
      const excluded = agents[role].tools?.exclude ?? []
      expect(excluded).not.toContain('plan-write')
      expect(excluded).not.toContain('plan-edit')
    }
  })

  test('auditor-loop shares plan-authoring exclusions with auditor', () => {
    const loopExcluded = agents['auditor-loop'].tools?.exclude ?? []
    for (const tool of ['plan-write', 'plan-edit']) {
      expect(loopExcluded).toContain(tool)
    }
  })
})
