import { describe, test, expect } from 'vitest'
import {
  extractPlanTitle,
  extractPlanExecutionMetadata,
  extractLoopName,
  extractLoopNames,
  sanitizeLoopName,
  PLAN_EXECUTION_LABELS,
  describePlanExecutionMode,
} from '../src/utils/plan-execution'

describe('Plan Execution Utilities', () => {
  describe('PLAN_EXECUTION_LABELS', () => {
    test('Contains all three canonical execution labels', () => {
      expect(PLAN_EXECUTION_LABELS).toHaveLength(3)
      expect(PLAN_EXECUTION_LABELS).toContain('New session')
      expect(PLAN_EXECUTION_LABELS).toContain('Execute here')
      expect(PLAN_EXECUTION_LABELS).toContain('Loop')
    })

    test('Labels match the exact strings used by plan-approval.ts', () => {
      // These are the exact labels that must match between TUI and plan-approval
      expect(PLAN_EXECUTION_LABELS[0]).toBe('New session')
      expect(PLAN_EXECUTION_LABELS[1]).toBe('Execute here')
      expect(PLAN_EXECUTION_LABELS[2]).toBe('Loop')
    })
  })

  describe('describePlanExecutionMode', () => {
    test('New session describes an audited goal-style loop in the project directory', () => {
      const description = describePlanExecutionMode('New session')
      expect(description.toLowerCase()).toContain('audited')
      expect(description.toLowerCase()).toContain('goal-style loop')
      expect(description.toLowerCase()).toContain('project directory')
    })

    test('New session description never implies an isolated worktree or a direct code-agent handoff', () => {
      const description = describePlanExecutionMode('New session').toLowerCase()
      expect(description).not.toContain('worktree')
      expect(description).not.toContain('send the plan to the code agent')
      expect(description).not.toContain('send the plan')
    })

    test('New session description notes the one-shot fallback', () => {
      expect(describePlanExecutionMode('New session').toLowerCase()).toContain('one-shot session')
    })

    test('Loop mode still describes an isolated worktree (unaffected by Phase 4)', () => {
      const description = describePlanExecutionMode('Loop').toLowerCase()
      expect(description).toContain('isolated git worktree')
    })

    test('Execute here still describes a code-agent handoff in the current session', () => {
      const description = describePlanExecutionMode('Execute here')
      expect(description.toLowerCase()).toContain('current session')
      expect(description.toLowerCase()).toContain('code agent')
    })

    test('Unknown label returns empty string', () => {
      expect(describePlanExecutionMode('something else')).toBe('')
    })
  })

  describe('extractPlanTitle', () => {
    test('Extracts title from first heading', () => {
      const plan = '# My Implementation Plan\n\nSome content here...'
      expect(extractPlanTitle(plan)).toBe('My Implementation Plan')
    })

    test('Truncates long titles to 60 characters', () => {
      const longTitle = 'a'.repeat(65)
      const plan = `# ${longTitle}\n\nContent`
      const result = extractPlanTitle(plan)
      expect(result.length).toBe(60)
      expect(result).toBe('a'.repeat(57) + '...')
    })

    test('Falls back to first line if no heading', () => {
      const plan = 'Implementation Plan\n\nSome content'
      expect(extractPlanTitle(plan)).toBe('Implementation Plan')
    })

    test('Falls back to default if plan is empty', () => {
      expect(extractPlanTitle('')).toBe('Implementation Plan')
    })

    test('Trims whitespace from extracted title', () => {
      const plan = '#   Title with spaces   \n\nContent'
      expect(extractPlanTitle(plan)).toBe('Title with spaces')
    })

    test('Prioritizes loop name from heading-style field', () => {
      const plan = '# Plan\n\n## Loop Name\n\nworkspace-sync-fix\n\n## Phases\n\nContent'
      expect(extractPlanTitle(plan)).toBe('workspace-sync-fix')
    })

    test('Prioritizes loop name from inline heading field', () => {
      const plan = '# Plan\n\n## Loop Name: workspace-sync-fix\n\n## Phases\n\nContent'
      expect(extractPlanTitle(plan)).toBe('workspace-sync-fix')
    })

    test('Skips structural heading prefixes like Phase and Plan', () => {
      const plan = '# Plan\n\n## Phase 1: Extract feature\n\n## Plan: Fix bug\n\n## Actual Title\n\nContent'
      expect(extractPlanTitle(plan)).toBe('Actual Title')
    })

    test('Skips Loop Name heading with inline value', () => {
      const plan = '# Plan\n\n## Loop Name: auth-refactor\n\n## Phase 1: Setup\n\nContent'
      expect(extractPlanTitle(plan)).toBe('auth-refactor')
    })

    test('Prioritizes inline Loop Name over phase subsections like Files', () => {
      const plan = '# Objective\n\nAdd model variant selection.\n\nLoop Name: plan-variant-selection\n\n<!-- forge-section -->\n## Phase 1: Capture variants\n\n### Files\n\n- src/utils/tui-models.ts\n\n### Edits\n\n1. Extend metadata'
      expect(extractPlanTitle(plan)).toBe('plan-variant-selection')
    })
  })

  describe('extractPlanExecutionMetadata', () => {
    test('Returns one canonical metadata shape for execution methods', () => {
      const plan = '# Objective\n\nAdd model variant selection.\n\nLoop Name: plan-variant-selection\n\n<!-- forge-section -->\n## Phase 1: Capture variants\n\n### Files\n\n- src/utils/tui-models.ts'
      expect(extractPlanExecutionMetadata(plan)).toEqual({
        title: 'plan-variant-selection',
        displayName: 'plan-variant-selection',
        executionName: 'plan-variant-selection',
      })
    })

    test('Falls back to non-structural heading when no explicit loop name exists', () => {
      const plan = '# Objective\n\nBuild the thing.\n\n## Real Feature Title\n\n### Files\n\n- src/a.ts'
      expect(extractPlanExecutionMetadata(plan)).toEqual({
        title: 'Real Feature Title',
        displayName: 'Real Feature Title',
        executionName: 'real-feature-title',
      })
    })
  })

  describe('extractLoopName', () => {
    test('Extracts explicit Loop Name field when present', () => {
      const plan = '# My Implementation Plan\n\nLoop Name: auth-refactor\n\nContent here...'
      expect(extractLoopName(plan)).toBe('auth-refactor')
    })

    test('Truncates long loop names to 60 characters', () => {
      const longName = 'a'.repeat(65)
      const plan = `Loop Name: ${longName}\n\nContent`
      const result = extractLoopName(plan)
      expect(result.length).toBe(60)
      expect(result).toBe('a'.repeat(60))
    })

    test('Falls back to title when no Loop Name field exists', () => {
      const plan = '# Fallback Title Plan\n\nSome content without loop name'
      expect(extractLoopName(plan)).toBe('Fallback Title Plan')
    })

    test('Falls back to default when plan is empty', () => {
      expect(extractLoopName('')).toBe('Implementation Plan')
    })

    test('Trims whitespace from loop name', () => {
      const plan = 'Loop Name:   name with spaces   \n\nContent'
      expect(extractLoopName(plan)).toBe('name with spaces')
    })

    test('Prioritizes Loop Name over heading', () => {
      const plan = '# Long Descriptive Heading Here\n\nLoop Name: short-name\n\nContent'
      expect(extractLoopName(plan)).toBe('short-name')
    })

    test('Parses markdown bold format **Loop Name**:', () => {
      const plan = '# Plan\n\n**Loop Name**: auth-refactor\n\nContent'
      expect(extractLoopName(plan)).toBe('auth-refactor')
    })

    test('Parses markdown bold with list prefix - **Loop Name**:', () => {
      const plan = '# Plan\n\n- **Loop Name**: api-validation\n\nContent'
      expect(extractLoopName(plan)).toBe('api-validation')
    })

    test('Parses loop name with leading whitespace', () => {
      const plan = '# Plan\n\n  Loop Name: spaced-name\n\nContent'
      expect(extractLoopName(plan)).toBe('spaced-name')
    })

    test('Parses bold loop name with leading whitespace', () => {
      const plan = '# Plan\n\n  **Loop Name**: bold-spaced\n\nContent'
      expect(extractLoopName(plan)).toBe('bold-spaced')
    })

    test('Parses bullet with bold and whitespace', () => {
      const plan = '# Plan\n\n  - **Loop Name**: bullet-bold-spaced\n\nContent'
      expect(extractLoopName(plan)).toBe('bullet-bold-spaced')
    })

    test('Falls back to title when no loop name in any format exists', () => {
      const plan = '# My Fallback Title\n\nSome content without loop name field'
      expect(extractLoopName(plan)).toBe('My Fallback Title')
    })
  })

  describe('extractLoopNames', () => {
    test('Returns both display and execution names', () => {
      const plan = '# Plan\n\nLoop Name: Auth Refactor\n\nContent'
      const result = extractLoopNames(plan)
      expect(result.displayName).toBe('Auth Refactor')
      expect(result.executionName).toBe('auth-refactor')
    })

    test('Display name preserves original casing and spaces', () => {
      const plan = 'Loop Name: API Migration v2.0'
      const result = extractLoopNames(plan)
      expect(result.displayName).toBe('API Migration v2.0')
    })

    test('Execution name is sanitized (lowercase, hyphens)', () => {
      const plan = 'Loop Name: API Migration v2.0'
      const result = extractLoopNames(plan)
      expect(result.executionName).toBe('api-migration-v2-0')
    })

    test('Handles markdown bold format', () => {
      const plan = '**Loop Name**: User Authentication'
      const result = extractLoopNames(plan)
      expect(result.displayName).toBe('User Authentication')
      expect(result.executionName).toBe('user-authentication')
    })

    test('Handles bullet list with bold format', () => {
      const plan = '- **Loop Name**: Database Optimization'
      const result = extractLoopNames(plan)
      expect(result.displayName).toBe('Database Optimization')
      expect(result.executionName).toBe('database-optimization')
    })

    test('Falls back to title when no explicit loop name', () => {
      const plan = '# Fallback Title Here\n\nContent'
      const result = extractLoopNames(plan)
      expect(result.displayName).toBe('Fallback Title Here')
      expect(result.executionName).toBe('fallback-title-here')
    })

    test('Truncates display name to 60 characters', () => {
      const longName = 'a'.repeat(65)
      const plan = `Loop Name: ${longName}`
      const result = extractLoopNames(plan)
      expect(result.displayName.length).toBe(60)
      expect(result.executionName.length).toBe(60)
    })
  })

  describe('sanitizeLoopName', () => {
    test('Converts to lowercase', () => {
      expect(sanitizeLoopName('MyLoopName')).toBe('myloopname')
    })

    test('Replaces spaces with hyphens', () => {
      expect(sanitizeLoopName('my loop name')).toBe('my-loop-name')
    })

    test('Replaces non-alphanumeric chars with hyphens', () => {
      expect(sanitizeLoopName('auth@refactor!test')).toBe('auth-refactor-test')
    })

    test('Removes leading and trailing hyphens', () => {
      expect(sanitizeLoopName('--my-loop--')).toBe('my-loop')
    })

    test('Truncates to 60 characters', () => {
      const longName = 'a'.repeat(100)
      expect(sanitizeLoopName(longName).length).toBe(60)
    })

    test('Returns default "loop" for empty input', () => {
      expect(sanitizeLoopName('')).toBe('loop')
    })

    test('Handles special characters correctly', () => {
      expect(sanitizeLoopName('API v2.0 Migration')).toBe('api-v2-0-migration')
    })
  })
})
