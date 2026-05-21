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
    test('formats with loop name and iteration (non-sectioned)', () => {
      expect(formatAuditSessionTitle('test-loop', { iteration: 3, currentSectionIndex: 0, totalSections: 0 })).toBe('audit: test-loop #3')
    })

    test('formats with section context for sectioned loops', () => {
      expect(formatAuditSessionTitle('test-loop', { iteration: 3, currentSectionIndex: 1, totalSections: 4 })).toBe('audit: test-loop 2/4 #3')
    })

    test('truncates long loop name', () => {
      const longLoopName = 'x'.repeat(80)
      const result = formatAuditSessionTitle(longLoopName, { iteration: 1, currentSectionIndex: 0, totalSections: 0 })
      expect(result.length).toBeLessThanOrEqual(MAX_SESSION_TITLE_LENGTH)
    })
  })

  describe('formatLoopSessionTitle with context', () => {
    test('appends iteration when context provided and totalSections is 0', () => {
      expect(formatLoopSessionTitle('user-detail-orders', { iteration: 3, currentSectionIndex: 0, totalSections: 0 }))
        .toBe('Loop: user-detail-orders #3')
    })
    test('appends section I+1/T and iteration for sectioned loops', () => {
      expect(formatLoopSessionTitle('user-detail-orders', { iteration: 3, currentSectionIndex: 1, totalSections: 4 }))
        .toBe('Loop: user-detail-orders 2/4 #3')
    })
    test('omits both markers when context is undefined (display-only callers)', () => {
      expect(formatLoopSessionTitle('user-detail-orders')).toBe('Loop: user-detail-orders')
    })
    test('is idempotent if caller accidentally passes a pre-formatted title', () => {
      expect(formatLoopSessionTitle('Loop: user-detail-orders', { iteration: 2, currentSectionIndex: 0, totalSections: 0 }))
        .toBe('Loop: user-detail-orders #2')
    })
    test('truncates after suffixes are appended', () => {
      const long = 'x'.repeat(80)
      const out = formatLoopSessionTitle(long, { iteration: 12, currentSectionIndex: 0, totalSections: 5 })
      expect(out.length).toBeLessThanOrEqual(60)
      expect(out.endsWith('...')).toBe(true)
    })
  })
})
