import { describe, test, expect } from 'vitest'
import {
  GOAL_BRIEF_REQUIRED_HEADINGS,
  summarizeGoalBrief,
  formatGoalBriefSummary,
  hasPlanStructureViolations,
} from '../../src/utils/goal-brief'

function cleanBrief(): string {
  return ['## Goal', 'Ship the validator.', '## Context', 'Phase 2 of the loop.', '## Constraints', 'No new deps.', '## Acceptance Criteria', 'Tests pass.'].join('\n')
}

describe('GOAL_BRIEF_REQUIRED_HEADINGS', () => {
  test('exposes the canonical four headings', () => {
    expect([...GOAL_BRIEF_REQUIRED_HEADINGS]).toEqual([
      'Goal',
      'Context',
      'Constraints',
      'Acceptance Criteria',
    ])
  })
})

describe('summarizeGoalBrief', () => {
  test('returns empty missingHeadings when all four ## headings are present', () => {
    const structure = summarizeGoalBrief(cleanBrief())
    expect(structure.missingHeadings).toEqual([])
  })

  test('reports only the missing canonical heading name', () => {
    const brief = cleanBrief().split('\n').filter((line) => line !== '## Constraints').join('\n')
    const structure = summarizeGoalBrief(brief)
    expect(structure.missingHeadings).toEqual(['Constraints'])
    expect(formatGoalBriefSummary(structure)).toContain('- Missing required section: ## Constraints')
  })

  test('matches required headings case-insensitively', () => {
    const brief = [
      '## goal',
      '## CONTEXT',
      '## constraints',
      '## acceptance criteria',
      'body',
    ].join('\n')
    expect(summarizeGoalBrief(brief).missingHeadings).toEqual([])
  })

  test('does not satisfy a requirement with a ### nested heading', () => {
    const brief = [
      '## Goal',
      '### Context',
      '## Constraints',
      '## Acceptance Criteria',
      'body',
    ].join('\n')
    const structure = summarizeGoalBrief(brief)
    expect(structure.missingHeadings).toEqual(['Context'])
  })

  test('flags a forge-section marker as a plan structure violation', () => {
    const brief = `${cleanBrief()}\n<!-- forge-section -->`
    const structure = summarizeGoalBrief(brief)
    expect(structure.planStructureViolations).toContain('<!-- forge-section --> marker')
    expect(hasPlanStructureViolations(structure)).toBe(true)
  })

  test('flags ## Phase and ### Phase headings', () => {
    const brief2 = `${cleanBrief()}\n## Phase 1: Something`
    const brief3 = `${cleanBrief()}\n### Phase 2: Other`
    expect(summarizeGoalBrief(brief2).planStructureViolations).toContain('Phase heading')
    expect(summarizeGoalBrief(brief3).planStructureViolations).toContain('Phase heading')
  })

  test('does not flag the word "phase" appearing in prose', () => {
    const brief = `${cleanBrief()}\n- rolled out in a later phase`
    const structure = summarizeGoalBrief(brief)
    expect(structure.planStructureViolations).not.toContain('Phase heading')
    expect(hasPlanStructureViolations(structure)).toBe(false)
  })

  test('reports both violations when marker and phase heading coexist', () => {
    const brief = `${cleanBrief()}\n<!-- forge-section -->\n## Phase 1: Build`
    const structure = summarizeGoalBrief(brief)
    expect(structure.planStructureViolations).toEqual([
      '<!-- forge-section --> marker',
      'Phase heading',
    ])
  })

  test('counts lines and chars', () => {
    const text = 'a\nb\nc'
    const structure = summarizeGoalBrief(text)
    expect(structure.lines).toBe(3)
    expect(structure.chars).toBe(5)
  })
})

describe('formatGoalBriefSummary', () => {
  test('emits only the count line for a clean brief', () => {
    const structure = summarizeGoalBrief(cleanBrief())
    const report = formatGoalBriefSummary(structure)
    const lines = report.split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^Goal brief stored: \d+ lines, \d+ chars\.$/)
  })

  test('renders Warnings and Plan structure not allowed blocks when present', () => {
    const brief = '## Goal\nbody'
    const structure = summarizeGoalBrief(`${brief}\n<!-- forge-section -->\n## Phase 1: X`)
    const report = formatGoalBriefSummary(structure)
    expect(report).toContain('Goal brief stored:')
    expect(report).toContain('Warnings:')
    expect(report).toContain('- Missing required section: ## Context')
    expect(report).toContain('- Missing required section: ## Constraints')
    expect(report).toContain('- Missing required section: ## Acceptance Criteria')
    expect(report).toContain('Plan structure not allowed:')
    expect(report).toContain('- <!-- forge-section --> marker')
    expect(report).toContain('- Phase heading')
  })
})
