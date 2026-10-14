import { describe, it, expect } from 'vitest'
import {
  PLAN_NONE_MARKER,
  classifyArchitectOutput,
  inspectArchitectPlanReadiness,
} from '../../src/utils/architect-auto-output'
import { PLAN_START_MARKER, PLAN_END_MARKER } from '../../src/utils/marked-plan-parser'
import { GOAL_COMPLETE_MARKER } from '../../src/constants/goal'

describe('classifyArchitectOutput', () => {
  it('returns kind plan for a valid marked plan', () => {
    const text = [
      'prefix text',
      PLAN_START_MARKER,
      'do the thing',
      PLAN_END_MARKER,
      'suffix text',
    ].join('\n')

    const result = classifyArchitectOutput(text)
    expect(result).toEqual({ kind: 'plan', planText: 'do the thing' })
  })

  it('returns kind insufficient with reason from marker line remainder', () => {
    const text = `${PLAN_NONE_MARKER} needs API contract`

    const result = classifyArchitectOutput(text)
    expect(result).toEqual({
      kind: 'insufficient',
      reason: 'needs API contract',
    })
  })

  it('returns kind insufficient with default reason when marker has no remainder text', () => {
    const text = PLAN_NONE_MARKER

    const result = classifyArchitectOutput(text)
    expect(result).toEqual({
      kind: 'insufficient',
      reason: 'Insufficient context to generate a plan.',
    })
  })

  it('returns kind insufficient for marker alone on a line with whitespace', () => {
    const text = `\n  ${PLAN_NONE_MARKER}  \n`

    const result = classifyArchitectOutput(text)
    expect(result).toEqual({
      kind: 'insufficient',
      reason: 'Insufficient context to generate a plan.',
    })
  })

  it('returns kind none when no markers are present', () => {
    const result = classifyArchitectOutput('just some random text')
    expect(result).toEqual({ kind: 'none' })
  })

  it('returns kind goal-complete with the reason from the marker line remainder', () => {
    const text = `${GOAL_COMPLETE_MARKER} everything shipped`

    const result = classifyArchitectOutput(text)
    expect(result).toEqual({ kind: 'goal-complete', reason: 'everything shipped' })
  })

  it('returns kind goal-complete with a default reason when the marker has no remainder', () => {
    const result = classifyArchitectOutput(`\n  ${GOAL_COMPLETE_MARKER}  \n`)
    expect(result).toEqual({ kind: 'goal-complete', reason: 'Goal complete.' })
  })

  it('detects a goal-complete marker mentioned mid-line per findMarkerLine semantics', () => {
    const text = `see ${GOAL_COMPLETE_MARKER} all done`

    const result = classifyArchitectOutput(text)
    expect(result).toEqual({ kind: 'goal-complete', reason: 'all done' })
  })

  it('prefers a valid marked plan over the goal-complete marker', () => {
    const text = [
      PLAN_START_MARKER,
      'the plan content',
      PLAN_END_MARKER,
      `${GOAL_COMPLETE_MARKER} done`,
    ].join('\n')

    const result = classifyArchitectOutput(text)
    expect(result).toEqual({ kind: 'plan', planText: 'the plan content' })
  })

  it('prefers the goal-complete marker over the none marker', () => {
    const text = [`${GOAL_COMPLETE_MARKER} done`, PLAN_NONE_MARKER].join('\n')

    const result = classifyArchitectOutput(text)
    expect(result).toEqual({ kind: 'goal-complete', reason: 'done' })
  })

  it('returns kind none for empty string', () => {
    const result = classifyArchitectOutput('')
    expect(result).toEqual({ kind: 'none' })
  })

  it('returns kind none when marked plan is missing/invalid and no none marker', () => {
    const text = [
      PLAN_START_MARKER,
      '  ',
      PLAN_END_MARKER,
    ].join('\n')

    const result = classifyArchitectOutput(text)
    expect(result).toEqual({ kind: 'none' })
  })

  it('tries marked plan first and returns plan when both plan and none markers are present', () => {
    const text = [
      PLAN_START_MARKER,
      'the plan content',
      PLAN_END_MARKER,
      PLAN_NONE_MARKER,
    ].join('\n')

    const result = classifyArchitectOutput(text)
    expect(result).toEqual({ kind: 'plan', planText: 'the plan content' })
  })
})

describe('inspectArchitectPlanReadiness', () => {
  it('accepts a complete canonical stored plan', () => {
    const plan = [
      '# Objective',
      'Implement the behavior.',
      'Loop Name: complete-plan',
      '<!-- forge-section -->',
      '## Phase 1: Implement behavior',
      '### Files',
      '- src/example.ts',
      '### Edits',
      '- Implement the behavior.',
      '### Acceptance Criteria',
      '- The behavior works.',
      '### Verification',
      '- `pnpm typecheck`',
      '## Decisions',
      '- None.',
      '## Conventions',
      '- Follow repository conventions.',
      '## Key Context',
      '- None.',
    ].join('\n\n')

    expect(inspectArchitectPlanReadiness(plan)).toEqual({ ready: true })
  })

  it('rejects a partial stored plan with actionable structural reasons', () => {
    const result = inspectArchitectPlanReadiness([
      '# Objective',
      'Implement the behavior.',
      'Loop Name: partial-plan',
      '<!-- forge-section -->',
      '## Phase 1: Implement behavior',
    ].join('\n\n'))

    expect(result.ready).toBe(false)
    if (result.ready) return
    expect(result.reason).toContain('Stored plan is incomplete:')
    expect(result.reason).toContain('Section 1 is missing required headings')
    expect(result.reason).toContain('Plan is missing trailing headings')
  })

  it('rejects a heading-only skeleton', () => {
    const result = inspectArchitectPlanReadiness([
      '# Objective',
      'Loop Name: empty-plan',
      '<!-- forge-section -->',
      '## Phase 1: Empty skeleton',
      '### Files',
      '### Edits',
      '### Acceptance Criteria',
      '### Verification',
      '## Decisions',
      '## Conventions',
      '## Key Context',
    ].join('\n\n'))

    expect(result.ready).toBe(false)
    if (result.ready) return
    expect(result.reason).toContain('Objective must include non-empty content')
    expect(result.reason).toContain('has empty required headings')
    expect(result.reason).toContain('has empty trailing headings')
  })
})
