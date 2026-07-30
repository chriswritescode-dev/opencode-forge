import { describe, test, expect } from 'vitest'
import { extractLaunchSpecMetadata, type SessionLaunchSpec } from '../../src/utils/session-launch-spec'
import { extractPlanExecutionMetadata } from '../../src/utils/plan-execution'

function planSpec(text: string, updatedAt = 1): SessionLaunchSpec {
  return { kind: 'plan', text, updatedAt }
}

function goalSpec(text: string, updatedAt = 1): SessionLaunchSpec {
  return { kind: 'goal', text, updatedAt }
}

describe('extractLaunchSpecMetadata', () => {
  test('plan kind delegates exactly to extractPlanExecutionMetadata', () => {
    const text = '# Add retry to uploader\n## Loop Name: add-retry-uploader\nbody'
    const spec = planSpec(text)
    const expected = extractPlanExecutionMetadata(text)
    expect(extractLaunchSpecMetadata(spec)).toEqual({ title: expected.title, executionName: expected.executionName })
  })

  test('goal kind derives title from first non-blank line after ## Goal', () => {
    const brief = '# Goal Brief\n\n## Context\nSome context.\n\n## Goal\n\nAdd retry to the uploader\n\n## Acceptance Criteria\n- It retries.'
    const result = extractLaunchSpecMetadata(goalSpec(brief))
    expect(result.title).toBe('Add retry to the uploader')
    expect(result.executionName).toBe('add-retry-to-the-uploader')
  })

  test('goal kind falls back to first non-heading line when ## Goal is absent', () => {
    const brief = '# Goal Brief\n\n## Context\n\nBuild the uploader retry feature.\n'
    const result = extractLaunchSpecMetadata(goalSpec(brief))
    expect(result.title).toBe('Build the uploader retry feature.')
    expect(result.executionName).toBe('build-the-uploader-retry-feature')
  })

  test('goal kind falls back to first non-heading line when ## Goal body is blank', () => {
    const brief = '## Goal\n\n## Acceptance Criteria\n\nCool thing happening here.'
    const result = extractLaunchSpecMetadata(goalSpec(brief))
    expect(result.title).toBe('Cool thing happening here.')
  })

  test('goal kind caps the title at 80 chars with ellipsis', () => {
    const longLine = 'a'.repeat(120)
    const brief = `## Goal\n\n${longLine}\n`
    const result = extractLaunchSpecMetadata(goalSpec(brief))
    expect(result.title.length).toBe(80)
    expect(result.title.endsWith('…')).toBe(true)
    expect(result.title).toBe(`${'a'.repeat(79)}…`)
  })

  test('goal kind slug derivation matches sanitizeLoopName', () => {
    const brief = '## Goal\n\nAdd Retry To The Uploader!'
    const result = extractLaunchSpecMetadata(goalSpec(brief))
    expect(result.executionName).toBe('add-retry-to-the-uploader')
  })

  test('goal kind preserves body text containing # characters', () => {
    const brief = '# Goal Brief\n\n## Goal\n\nSupport C# clients\n'
    const result = extractLaunchSpecMetadata(goalSpec(brief))
    expect(result.title).toBe('Support C# clients')
    expect(result.executionName).toBe('support-c-clients')
  })

  test('goal kind skips whitespace-only lines before the body', () => {
    const brief = 'Some context prose here.\n\n## Goal\n\n   \n\n\t\n\nAdd retry to the uploader\n'
    const result = extractLaunchSpecMetadata(goalSpec(brief))
    expect(result.title).toBe('Add retry to the uploader')
  })

  test('goal heading match is case-insensitive, mirroring summarizeGoalBrief', () => {
    const canonical = '## Goal\n\nAdd retry to the uploader'
    const lower = '## goal\n\nAdd retry to the uploader'
    const mixed = '## GoAl\n\nAdd retry to the uploader'
    const expected = extractLaunchSpecMetadata(goalSpec(canonical))
    expect(extractLaunchSpecMetadata(goalSpec(lower))).toEqual(expected)
    expect(extractLaunchSpecMetadata(goalSpec(mixed))).toEqual(expected)
  })
})
