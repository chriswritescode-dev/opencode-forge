import { describe, expect, test } from 'bun:test'
import {
  MAX_SESSION_TITLE_LENGTH,
  truncateSessionTitle,
  formatLoopSessionTitle,
  formatPlanSessionTitle,
  formatAuditSessionTitle,
} from '../src/utils/session-titles'

describe('session-titles', () => {
  describe('MAX_SESSION_TITLE_LENGTH', () => {
    test('is set to 60', () => {
      expect(MAX_SESSION_TITLE_LENGTH).toBe(60)
    })
  })

  describe('truncateSessionTitle', () => {
    test('returns original title when under max length', () => {
      const title = 'Short Title'
      expect(truncateSessionTitle(title)).toBe(title)
    })

    test('returns original title when exactly at max length', () => {
      const title = 'a'.repeat(MAX_SESSION_TITLE_LENGTH)
      expect(truncateSessionTitle(title)).toBe(title)
      expect(truncateSessionTitle(title).length).toBe(MAX_SESSION_TITLE_LENGTH)
    })

    test('truncates and adds ellipsis when over max length', () => {
      const longTitle = 'a'.repeat(MAX_SESSION_TITLE_LENGTH + 10)
      const result = truncateSessionTitle(longTitle)
      expect(result.length).toBeLessThanOrEqual(MAX_SESSION_TITLE_LENGTH)
      expect(result.endsWith('...')).toBe(true)
    })

    test('truncates to exactly max length', () => {
      const longTitle = 'a'.repeat(MAX_SESSION_TITLE_LENGTH + 10)
      const result = truncateSessionTitle(longTitle)
      expect(result.length).toBe(MAX_SESSION_TITLE_LENGTH)
    })
  })

  describe('formatLoopSessionTitle', () => {
    test('adds Loop: prefix to unprefixed title', () => {
      expect(formatLoopSessionTitle('API Plan')).toBe('Loop: API Plan')
    })

    test('is idempotent for already-prefixed input', () => {
      expect(formatLoopSessionTitle('Loop: API Plan')).toBe('Loop: API Plan')
    })

    test('does not double-prefix Loop: title', () => {
      const result = formatLoopSessionTitle('Loop: API Plan')
      expect(result).toBe('Loop: API Plan')
      expect(result.startsWith('Loop: Loop:')).toBe(false)
    })

    test('truncates long title to max length with ellipsis', () => {
      const longTitle = 'a'.repeat(70)
      const result = formatLoopSessionTitle(longTitle)
      expect(result.length).toBeLessThanOrEqual(MAX_SESSION_TITLE_LENGTH)
      expect(result.endsWith('...')).toBe(true)
    })

    test('truncates after prefixing', () => {
      const longTitle = 'a'.repeat(60)
      const result = formatLoopSessionTitle(longTitle)
      expect(result.length).toBeLessThanOrEqual(MAX_SESSION_TITLE_LENGTH)
      expect(result.startsWith('Loop: ')).toBe(true)
    })
  })

  describe('formatPlanSessionTitle', () => {
    test('truncates long title to max length', () => {
      const longTitle = 'a'.repeat(70)
      const result = formatPlanSessionTitle(longTitle)
      expect(result.length).toBeLessThanOrEqual(MAX_SESSION_TITLE_LENGTH)
    })

    test('returns short title unchanged', () => {
      expect(formatPlanSessionTitle('Short Plan')).toBe('Short Plan')
    })
  })

  describe('formatAuditSessionTitle', () => {
    test('formats with loop name and iteration', () => {
      expect(formatAuditSessionTitle('test-loop', 2)).toBe('audit: test-loop #2')
    })

    test('truncates long loop name', () => {
      const longLoopName = 'a'.repeat(70)
      const result = formatAuditSessionTitle(longLoopName, 1)
      expect(result.length).toBeLessThanOrEqual(MAX_SESSION_TITLE_LENGTH)
    })
  })
})
