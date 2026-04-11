import { describe, test, expect } from 'bun:test'
import {
  extractPlanTitle,
  extractLoopName,
  extractLoopNames,
  sanitizeLoopName,
  PLAN_EXECUTION_LABELS,
  matchExecutionLabel,
} from '../src/utils/plan-execution'

describe('Plan Execution Utilities', () => {
  describe('PLAN_EXECUTION_LABELS', () => {
    test('Contains all four canonical execution labels', () => {
      expect(PLAN_EXECUTION_LABELS).toHaveLength(4)
      expect(PLAN_EXECUTION_LABELS).toContain('New session')
      expect(PLAN_EXECUTION_LABELS).toContain('Execute here')
      expect(PLAN_EXECUTION_LABELS).toContain('Loop (worktree)')
      expect(PLAN_EXECUTION_LABELS).toContain('Loop')
    })

    test('Labels match the exact strings used by plan-approval.ts', () => {
      // These are the exact labels that must match between TUI and plan-approval
      expect(PLAN_EXECUTION_LABELS[0]).toBe('New session')
      expect(PLAN_EXECUTION_LABELS[1]).toBe('Execute here')
      expect(PLAN_EXECUTION_LABELS[2]).toBe('Loop (worktree)')
      expect(PLAN_EXECUTION_LABELS[3]).toBe('Loop')
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
  })

  describe('matchExecutionLabel', () => {
    test('Matches exact canonical labels', () => {
      expect(matchExecutionLabel('New session')).toBe('New session')
      expect(matchExecutionLabel('Execute here')).toBe('Execute here')
      expect(matchExecutionLabel('Loop (worktree)')).toBe('Loop (worktree)')
      expect(matchExecutionLabel('Loop')).toBe('Loop')
    })

    test('Matches case-insensitively', () => {
      expect(matchExecutionLabel('new session')).toBe('New session')
      expect(matchExecutionLabel('EXECUTE HERE')).toBe('Execute here')
      expect(matchExecutionLabel('LOOP (WORKTREE)')).toBe('Loop (worktree)')
      expect(matchExecutionLabel('loop')).toBe('Loop')
    })

    test('Matches partial labels that start with canonical label', () => {
      expect(matchExecutionLabel('New session (custom)')).toBe('New session')
      expect(matchExecutionLabel('Loop (worktree) variant')).toBe('Loop (worktree)')
    })

    test('Returns null for non-matching labels', () => {
      expect(matchExecutionLabel('Custom mode')).toBeNull()
      expect(matchExecutionLabel('Execute there')).toBeNull()
      expect(matchExecutionLabel('')).toBeNull()
    })

    test('Does not match partial text in middle', () => {
      // Should not match "I want to loop" as "Loop"
      expect(matchExecutionLabel('I want to loop')).toBeNull()
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
