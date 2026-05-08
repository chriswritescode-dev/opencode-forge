import { describe, test, expect } from 'bun:test'
import { decomposeDeterministically } from '../src/services/deterministic-decomposer'

describe('decomposeDeterministically', () => {
  test('returns empty array when no Phase headings found', () => {
    const result = decomposeDeterministically('Just some plain text')
    expect(result).toEqual([])
  })

  test('returns empty array for empty string', () => {
    const result = decomposeDeterministically('')
    expect(result).toEqual([])
  })

  test('returns empty array when only non-phase headings exist', () => {
    const result = decomposeDeterministically('## Random Heading\nSome content\n## Another Heading')
    expect(result).toEqual([])
  })

  test('extracts single section correctly', () => {
    const plan = '## Phase 1: Setup\n- Create files\n- Run init'
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      index: 0,
      title: 'Setup',
      content: '## Phase 1: Setup\n- Create files\n- Run init',
    })
  })

  test('extracts multiple sections in order', () => {
    const plan = [
      '## Phase 1: Setup',
      '- Create project',
      '## Phase 2: Build',
      '- Compile code',
      '## Phase 3: Test',
      '- Run tests',
    ].join('\n')
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(3)
    expect(result[0].title).toBe('Setup')
    expect(result[0].index).toBe(0)
    expect(result[1].title).toBe('Build')
    expect(result[1].index).toBe(1)
    expect(result[2].title).toBe('Test')
    expect(result[2].index).toBe(2)
  })

  test('respects maxSections limit', () => {
    const plan = [
      '## Phase 1: First',
      'content 1',
      '## Phase 2: Second',
      'content 2',
      '## Phase 3: Third',
      'content 3',
      '## Phase 4: Fourth',
      'content 4',
      '## Phase 5: Fifth',
      'content 5',
    ].join('\n')
    const result = decomposeDeterministically(plan, { maxSections: 2 })
    expect(result).toHaveLength(2)
    expect(result[0].title).toBe('First')
    expect(result[1].title).toBe('Second')
  })

  test('defaults maxSections to 12', () => {
    const sections = Array.from({ length: 15 }, (_, i) => `## Phase ${i + 1}: Section ${i + 1}\ncontent ${i + 1}`)
    const plan = sections.join('\n')
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(12)
  })

  test('strips forge-plan start marker', () => {
    const plan = '<!-- forge-plan:start -->\n## Phase 1: Setup\n- Create files'
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Setup')
  })

  test('strips forge-plan end marker', () => {
    const plan = '## Phase 1: Setup\n- Create files\n<!-- forge-plan:end -->'
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Setup')
  })

  test('strips both forge-plan markers', () => {
    const plan = '<!-- forge-plan:start -->\n## Phase 1: Setup\n- Create files\n<!-- forge-plan:end -->'
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Setup')
  })

  test('strips forge-plan markers with extra whitespace', () => {
    const plan = '<!-- forge-plan:start -->\n<!-- forge-plan:end -->\n## Phase 1: Setup\ncontent'
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Setup')
  })

  test('stops at Verification heading', () => {
    const plan = [
      '## Phase 1: Setup',
      '- Create files',
      '## Verification',
      '- Check files exist',
    ].join('\n')
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Setup')
    expect(result[0].content).toContain('Create files')
    expect(result[0].content).not.toContain('Check files exist')
  })

  test('stops at Decisions heading', () => {
    const plan = [
      '## Phase 1: Setup',
      '- Create files',
      '## Decisions',
      '- Use TypeScript',
    ].join('\n')
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Setup')
    expect(result[0].content).not.toContain('Use TypeScript')
  })

  test('stops at Conventions heading', () => {
    const plan = [
      '## Phase 1: Setup',
      '- Create files',
      '## Conventions',
      '- Use 2 spaces',
    ].join('\n')
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Setup')
    expect(result[0].content).not.toContain('Use 2 spaces')
  })

  test('stops at Key Context heading', () => {
    const plan = [
      '## Phase 1: Setup',
      '- Create files',
      '## Key Context',
      '- Important info',
    ].join('\n')
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Setup')
    expect(result[0].content).not.toContain('Important info')
  })

  test('stops at first stop heading encountered', () => {
    const plan = [
      '## Phase 1: Setup',
      '- Create files',
      '## Verification',
      '- Check files exist',
      '## Decisions',
      '- Use TypeScript',
    ].join('\n')
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(1)
    expect(result[0].content).not.toContain('Verification')
    expect(result[0].content).not.toContain('Decisions')
  })

  test('handles nested content within phases', () => {
    const plan = [
      '## Phase 1: Setup',
      '- Step 1: Create dirs',
      '- Step 2: Init config',
      '  - Sub-step A',
      '  - Sub-step B',
      '- Step 3: Verify',
    ].join('\n')
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(1)
    expect(result[0].content).toContain('Step 1')
    expect(result[0].content).toContain('Sub-step A')
    expect(result[0].content).toContain('Step 3')
  })

  test('handles phases with blank lines between them', () => {
    const plan = [
      '## Phase 1: Setup',
      '- Create files',
      '',
      '',
      '## Phase 2: Build',
      '- Compile code',
    ].join('\n')
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(2)
    expect(result[0].title).toBe('Setup')
    expect(result[1].title).toBe('Build')
  })

  test('truncates titles to 60 characters', () => {
    const longTitle = 'A'.repeat(100)
    const plan = `## Phase 1: ${longTitle}\ncontent`
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(1)
    expect(result[0].title).toHaveLength(60)
    expect(result[0].title).toBe('A'.repeat(60))
  })

  test('trims whitespace from titles', () => {
    const plan = '## Phase 1:   Some Title  \ncontent'
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Some Title')
  })

  test('phase numbers are parsed correctly', () => {
    const plan = [
      '## Phase 3: Third',
      'content 3',
      '## Phase 1: First',
      'content 1',
      '## Phase 2: Second',
      'content 2',
    ].join('\n')
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(3)
    expect(result[0].title).toBe('Third')
    expect(result[1].title).toBe('First')
    expect(result[2].title).toBe('Second')
  })

  test('handles phase headings without colon space variations', () => {
    const plan = '## Phase 1:Title Without Space\ncontent'
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Title Without Space')
  })

  test('handles multiple stop headings within same phase', () => {
    const plan = [
      '## Phase 1: Setup',
      '- Create files',
      '## Verification',
      '- Check',
      '## Phase 2: Build',
      '- Compile',
      '## Decisions',
      '- Decision 1',
    ].join('\n')
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(2)
    expect(result[0].title).toBe('Setup')
    expect(result[1].title).toBe('Build')
  })

  test('each section has correct index', () => {
    const plan = [
      '## Phase 1: First',
      'a',
      '## Phase 2: Second',
      'b',
      '## Phase 3: Third',
      'c',
    ].join('\n')
    const result = decomposeDeterministically(plan)
    expect(result[0].index).toBe(0)
    expect(result[1].index).toBe(1)
    expect(result[2].index).toBe(2)
  })

  test('content includes phase heading line', () => {
    const plan = '## Phase 1: Setup\n- Step 1'
    const result = decomposeDeterministically(plan)
    expect(result[0].content).toContain('## Phase 1: Setup')
  })

  test('handles phase numbers > 9', () => {
    const plan = [
      '## Phase 10: Tenth',
      'content',
      '## Phase 11: Eleventh',
      'content',
    ].join('\n')
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(2)
    expect(result[0].title).toBe('Tenth')
    expect(result[1].title).toBe('Eleventh')
  })

  test('handles non-phase lines between phases', () => {
    const plan = [
      '## Phase 1: Setup',
      '- Step 1',
      '',
      '## Phase 2: Build',
      '- Step 2',
    ].join('\n')
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(2)
    expect(result[0].content).toContain('- Step 1')
    expect(result[1].content).toContain('- Step 2')
  })

  test('handles single section with no other content', () => {
    const plan = '## Phase 1: Only'
    const result = decomposeDeterministically(plan)
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Only')
    expect(result[0].content).toBe('## Phase 1: Only')
  })
})
