import { describe, test, expect } from 'vitest'
import {
  summarizePlanStructure,
  formatPlanStructureSummary,
} from '../src/utils/plan-structure'
import { MAX_TOTAL_SECTIONS } from '../src/constants/loop'

function planWithMarkers(count: number, body = 'body'): string {
  const parts: string[] = []
  for (let i = 0; i < count; i++) {
    parts.push(`<!-- forge-section -->`, `## Phase ${i + 1}`, body)
  }
  return parts.join('\n')
}

describe('summarizePlanStructure', () => {
  test('counts unfenced <!-- forge-section --> marker lines', () => {
    expect(summarizePlanStructure('<!-- forge-section -->\n## Phase 1\nbody').sectionMarkers).toBe(1)
    expect(summarizePlanStructure(planWithMarkers(3)).sectionMarkers).toBe(3)
  })

  test('reports 0 markers when none are present', () => {
    expect(summarizePlanStructure('## Phase 1\nbody').sectionMarkers).toBe(0)
    expect(summarizePlanStructure('').sectionMarkers).toBe(0)
  })

  test('ignores markers inside ``` fences', () => {
    const plan = ['<!-- forge-section -->', '## Phase 1', '```ts', '<!-- forge-section -->', 'const x = 1', '```', 'body'].join('\n')
    expect(summarizePlanStructure(plan).sectionMarkers).toBe(1)
  })

  test('basic summary with 3 markers and 3 non-empty bodies', () => {
    const summary = summarizePlanStructure(planWithMarkers(3))
    expect(summary.sectionMarkers).toBe(3)
    expect(summary.sections).toHaveLength(3)
    expect(summary.sections.map((s) => s.title)).toEqual(['Phase 1', 'Phase 2', 'Phase 3'])
    expect(summary.sections.map((s) => s.index)).toEqual([0, 1, 2])
    expect(summary.warnings).not.toContainEqual(expect.stringMatching(/section marker/i))
    expect(summary.warnings).not.toContainEqual(expect.stringMatching(/cap of/))
  })

  test('26 markers hit the cap: sectionMarkers=26, sections=24, cap warning names 26 and 24', () => {
    const summary = summarizePlanStructure(planWithMarkers(26))
    expect(summary.sectionMarkers).toBe(26)
    expect(summary.sections).toHaveLength(MAX_TOTAL_SECTIONS)
    expect(summary.sections).toHaveLength(24)
    const cap = summary.warnings.find((w) => w.includes('exceed the cap'))
    expect(cap).toBeDefined()
    expect(cap).toContain('26')
    expect(cap).toContain('24')
    // No empty-body warning: diff is fully explained by the cap.
    expect(summary.warnings.find((w) => w.includes('empty bodies'))).toBeUndefined()
  })

  test('marker followed by another marker produces the empty-body warning', () => {
    const plan = ['<!-- forge-section -->', '<!-- forge-section -->', '## Phase 2', 'body'].join('\n')
    const summary = summarizePlanStructure(plan)
    expect(summary.sectionMarkers).toBe(2)
    expect(summary.sections).toHaveLength(1)
    const empty = summary.warnings.find((w) => w.includes('empty bodies'))
    expect(empty).toBeDefined()
    expect(empty).toContain('1 section marker(s) have empty bodies and will be skipped.')
  })

  test('mixed cap + empty body: 25 markers with one empty body and 24 valid sections reports the empty-body warning', () => {
    // 25 markers; the second marker is immediately followed by another marker
    // so its body is empty. The remaining 24 markers each have a non-empty
    // body, so the cap drops nothing and the empty-body warning must surface.
    const parts: string[] = []
    for (let i = 0; i < 25; i++) {
      parts.push('<!-- forge-section -->')
      if (i === 1) {
        // Skip the body so this marker is immediately followed by the next one.
        continue
      }
      parts.push(`## Phase ${i + 1}`, 'body')
    }
    const summary = summarizePlanStructure(parts.join('\n'))
    expect(summary.sectionMarkers).toBe(25)
    expect(summary.sections).toHaveLength(24)
    const empty = summary.warnings.find((w) => w.includes('empty bodies'))
    expect(empty).toBeDefined()
    expect(empty).toContain('1 section marker(s) have empty bodies and will be skipped.')
  })

  test('empty plan returns lines:1, characters:0, no markers, no sections, null loop name, and both warnings', () => {
    const summary = summarizePlanStructure('')
    expect(summary.lines).toBe(1)
    expect(summary.characters).toBe(0)
    expect(summary.sectionMarkers).toBe(0)
    expect(summary.sections).toEqual([])
    expect(summary.loopName).toBeNull()
    expect(summary.warnings).toContain('No <!-- forge-section --> markers found: the whole plan will run as a single section.')
    expect(summary.warnings).toContain('No "Loop Name:" line found: the loop name will be derived from the plan title.')
  })

  test('non-repo-relative path ~/foo/bar.ts triggers the path warning', () => {
    const plan = `<!-- forge-section -->\n## Phase 1\nEdit \`~/foo/bar.ts\` and \`src/foo.ts\`.`
    const summary = summarizePlanStructure(plan)
    const path = summary.warnings.find((w) => w.includes('non-repo-relative'))
    expect(path).toBeDefined()
    expect(path).toBe('Plan contains a non-repo-relative path (~/foo/bar.ts). Use repo-relative paths.')
    expect(path).not.toContain('src/foo.ts')
  })

  test('a plan with only repo-relative paths produces no path warning', () => {
    const plan = `<!-- forge-section -->\n## Phase 1\nEdit \`src/foo.ts\` and \`test/foo.test.ts\`.`
    const summary = summarizePlanStructure(plan)
    expect(summary.warnings.find((w) => w.includes('non-repo-relative'))).toBeUndefined()
  })

  test('Loop Name: foo is detected (plain form)', () => {
    const plan = `Loop Name: foo\n\n${planWithMarkers(1)}`
    const summary = summarizePlanStructure(plan)
    expect(summary.loopName).toBe('foo')
    expect(summary.warnings.find((w) => w.includes('"Loop Name:"'))).toBeUndefined()
  })

  test('**Loop Name**: foo is detected (bold form)', () => {
    const plan = `**Loop Name**: foo\n\n${planWithMarkers(1)}`
    const summary = summarizePlanStructure(plan)
    expect(summary.loopName).toBe('foo')
    expect(summary.warnings.find((w) => w.includes('"Loop Name:"'))).toBeUndefined()
  })

  test('lines and characters are computed from raw plan text', () => {
    const plan = 'a\nb\nc'
    const summary = summarizePlanStructure(plan)
    expect(summary.lines).toBe(3)
    expect(summary.characters).toBe(5)
  })
})

describe('formatPlanStructureSummary', () => {
  test('renders the canonical structure with warnings', () => {
    const summary = summarizePlanStructure(`Loop Name: plan-authoring-tools\n\n${planWithMarkers(2)}`)
    const formatted = formatPlanStructureSummary(summary)
    expect(formatted).toContain(`Plan stored: ${summary.lines} lines, ${summary.characters} chars.`)
    expect(formatted).toContain('Loop Name: plan-authoring-tools')
    expect(formatted).toContain('Sections (2):')
    expect(formatted).toContain('  1. Phase 1')
    expect(formatted).toContain('  2. Phase 2')
    // No warnings in this case (markers and loop name present, no path).
    expect(formatted).not.toContain('Warnings:')
  })

  test('omits Loop Name: line when null', () => {
    const summary = summarizePlanStructure(planWithMarkers(1))
    const formatted = formatPlanStructureSummary(summary)
    expect(formatted).not.toContain('\nLoop Name:')
    // The warning block still mentions it.
    expect(formatted).toContain('Warnings:')
    expect(formatted).toContain('No "Loop Name:" line found')
  })

  test('omits the Warnings: block entirely when there are none', () => {
    const summary: import('../src/utils/plan-structure').PlanStructureSummary = {
      lines: 10,
      characters: 100,
      sectionMarkers: 1,
      sections: [{ index: 0, title: 'Phase 1' }],
      loopName: 'foo',
      warnings: [],
    }
    const formatted = formatPlanStructureSummary(summary)
    expect(formatted).not.toContain('Warnings:')
    expect(formatted).toContain('Loop Name: foo')
    expect(formatted).toContain('Sections (1):')
    expect(formatted).toContain('  1. Phase 1')
  })

  test('prints "Sections (0): none detected" when sections is empty', () => {
    const summary = summarizePlanStructure('just prose, no markers')
    const formatted = formatPlanStructureSummary(summary)
    expect(formatted).toContain('Sections (0): none detected')
    expect(formatted).not.toMatch(/Sections \(0\):\s*\n/)
  })

  test('renders cap warning when present', () => {
    const summary = summarizePlanStructure(planWithMarkers(26))
    const formatted = formatPlanStructureSummary(summary)
    expect(formatted).toContain('Warnings:')
    expect(formatted).toContain('exceed the cap of 24')
  })
})
