import { describe, test, expect } from 'bun:test'
import { formatTokens, formatSessionOutput, formatAuditResult, formatUsageSummary } from '../src/utils/loop-format'
import type { LoopSessionOutput } from '../src/loop/session-output'
import type { LoopUsageSummary } from '../src/loop/token-usage'

describe('formatTokens', () => {
  test('numbers less than 1000 returned as string', () => {
    expect(formatTokens(500)).toBe('500')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(1)).toBe('1')
  })

  test('numbers greater than or equal to 1000 formatted with k suffix', () => {
    expect(formatTokens(1000)).toBe('1.0k')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(2000)).toBe('2.0k')
    expect(formatTokens(2500)).toBe('2.5k')
    expect(formatTokens(10000)).toBe('10.0k')
  })

  test('handles edge cases', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(100)).toBe('100')
    expect(formatTokens(1001)).toBe('1.0k')
  })
})

describe('formatSessionOutput', () => {
  test('includes cost string with dollar prefix', () => {
    const sessionOutput: LoopSessionOutput = {
      totalCost: 0.0123,
      totalTokens: {
        input: 1000,
        output: 500,
        reasoning: 200,
        cacheRead: 0,
        cacheWrite: 0,
      },
      fileChanges: null,
      messages: [],
    }

    const lines = formatSessionOutput(sessionOutput)
    expect(lines[0]).toContain('$0.0123')
  })

  test('includes token breakdown', () => {
    const sessionOutput: LoopSessionOutput = {
      totalCost: 0.01,
      totalTokens: {
        input: 1500,
        output: 750,
        reasoning: 300,
        cacheRead: 100,
        cacheWrite: 50,
      },
      fileChanges: null,
      messages: [],
    }

    const lines = formatSessionOutput(sessionOutput)
    expect(lines[0]).toContain('1.5k in')
    expect(lines[0]).toContain('750 out')
    expect(lines[0]).toContain('300 reasoning')
    expect(lines[0]).toContain('100 cache read')
    expect(lines[0]).toContain('50 cache write')
  })

  test('includes file changes when present', () => {
    const sessionOutput: LoopSessionOutput = {
      totalCost: 0.01,
      totalTokens: {
        input: 100,
        output: 100,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      fileChanges: {
        files: 5,
        additions: 100,
        deletions: 50,
      },
      messages: [],
    }

    const lines = formatSessionOutput(sessionOutput)
    expect(lines).toContain('  Files changed: 5 (+100/-50 lines)')
  })

  test('omits file changes line when not present', () => {
    const sessionOutput: LoopSessionOutput = {
      totalCost: 0.01,
      totalTokens: {
        input: 100,
        output: 100,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      fileChanges: null,
      messages: [],
    }

    const lines = formatSessionOutput(sessionOutput)
    const hasFileChanges = lines.some((line) => line.includes('Files changed'))
    expect(hasFileChanges).toBe(false)
  })

  test('includes recent activity messages', () => {
    const sessionOutput: LoopSessionOutput = {
      totalCost: 0.01,
      totalTokens: {
        input: 100,
        output: 100,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      fileChanges: null,
      messages: [
        { text: 'First message', cost: 0.001, tokens: { input: 10, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
        { text: 'Second message', cost: 0.001, tokens: { input: 10, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
    }

    const lines = formatSessionOutput(sessionOutput)
    expect(lines).toContain('Recent Activity:')
    expect(lines.join('\n')).toContain('[assistant] First message')
    expect(lines.join('\n')).toContain('[assistant] Second message')
  })

  test('handles empty messages array', () => {
    const sessionOutput: LoopSessionOutput = {
      totalCost: 0.01,
      totalTokens: {
        input: 100,
        output: 100,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      fileChanges: null,
      messages: [],
    }

    const lines = formatSessionOutput(sessionOutput)
    const hasRecentActivity = lines.some((line) => line.includes('Recent Activity'))
    expect(hasRecentActivity).toBe(false)
  })

  test('truncates long message text', () => {
    const longMessage = 'a'.repeat(250)
    const sessionOutput: LoopSessionOutput = {
      totalCost: 0.01,
      totalTokens: {
        input: 100,
        output: 100,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      fileChanges: null,
      messages: [{ text: longMessage, cost: 0.001, tokens: { input: 10, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }],
    }

    const lines = formatSessionOutput(sessionOutput)
    const messageLine = lines.find((line) => line.includes('[assistant]'))
    expect(messageLine).toBeDefined()
    expect(messageLine!.length).toBeLessThanOrEqual(1020)
  })

  test('handles multiline messages', () => {
    const sessionOutput: LoopSessionOutput = {
      totalCost: 0.01,
      totalTokens: {
        input: 100,
        output: 100,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      fileChanges: null,
      messages: [{ text: 'Line 1\nLine 2\nLine 3', cost: 0.001, tokens: { input: 10, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }],
    }

    const lines = formatSessionOutput(sessionOutput)
    const messageLine = lines.find((line) => line.includes('[assistant]'))
    expect(messageLine).toContain('Line 1 Line 2 Line 3')
  })
})

describe('formatAuditResult', () => {
  test('returns array with empty line, Last Audit, and truncated result', () => {
    const auditResult = 'Audit passed with no issues'
    const lines = formatAuditResult(auditResult)

    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('')
    expect(lines[1]).toBe('Last Audit:')
    expect(lines[2]).toContain('Audit passed with no issues')
  })

  test('truncates long audit results to 300 chars', () => {
    const longResult = 'a'.repeat(400)
    const lines = formatAuditResult(longResult)

    expect(lines).toHaveLength(3)
    expect(lines[2].length).toBeLessThanOrEqual(303)
    expect(lines[2]).toContain('...')
  })

  test('handles short audit results', () => {
    const auditResult = 'Short audit result'
    const lines = formatAuditResult(auditResult)

    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe('  Short audit result')
  })
})

describe('formatUsageSummary', () => {
  test('formats total cost and tokens', () => {
    const summary: LoopUsageSummary = {
      totalCost: 0.0123,
      totalTokens: {
        input: 1000,
        output: 500,
        reasoning: 200,
        cacheRead: 100,
        cacheWrite: 50,
      },
      perModel: [],
    }

    const lines = formatUsageSummary(summary)
    expect(lines[0]).toContain('$0.0123')
    expect(lines[0]).toContain('1.0k in')
    expect(lines[0]).toContain('500 out')
    expect(lines[0]).toContain('200 reasoning')
    expect(lines[0]).toContain('100 cache read')
    expect(lines[0]).toContain('50 cache write')
  })

  test('formats per-model usage', () => {
    const summary: LoopUsageSummary = {
      totalCost: 0.03,
      totalTokens: {
        input: 300,
        output: 150,
        reasoning: 30,
        cacheRead: 15,
        cacheWrite: 6,
      },
      perModel: [
        {
          model: 'model-a',
          cost: 0.01,
          tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 2 },
        },
        {
          model: 'model-b',
          cost: 0.02,
          tokens: { input: 200, output: 100, reasoning: 20, cacheRead: 10, cacheWrite: 4 },
        },
      ],
    }

    const lines = formatUsageSummary(summary)
    expect(lines).toContain('Per-model usage:')
    expect(lines.join('\n')).toContain('model-a:')
    expect(lines.join('\n')).toContain('model-b:')
    expect(lines.join('\n')).toContain('$0.0100')
    expect(lines.join('\n')).toContain('$0.0200')
  })

  test('preserves per-model order from summary', () => {
    // Note: formatUsageSummary preserves the order from the summary.
    // Sorting is done by summarizeAssistantUsage before creating the summary.
    const summary: LoopUsageSummary = {
      totalCost: 0.03,
      totalTokens: {
        input: 300,
        output: 150,
        reasoning: 30,
        cacheRead: 15,
        cacheWrite: 6,
      },
      perModel: [
        { model: 'a-model', cost: 0.02, tokens: { input: 200, output: 100, reasoning: 20, cacheRead: 10, cacheWrite: 4 } },
        { model: 'm-model', cost: 0.005, tokens: { input: 50, output: 25, reasoning: 5, cacheRead: 2, cacheWrite: 1 } },
        { model: 'z-model', cost: 0.01, tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 2 } },
      ],
    }

    const lines = formatUsageSummary(summary)
    const perModelIndex = lines.findIndex((line) => line.includes('Per-model usage:'))
    const modelLines = lines.slice(perModelIndex + 1)
    expect(modelLines[0]).toContain('a-model:')
    expect(modelLines[1]).toContain('m-model:')
    expect(modelLines[2]).toContain('z-model:')
  })

  test('omits per-model section when empty', () => {
    const summary: LoopUsageSummary = {
      totalCost: 0.01,
      totalTokens: {
        input: 100,
        output: 50,
        reasoning: 10,
        cacheRead: 5,
        cacheWrite: 2,
      },
      perModel: [],
    }

    const lines = formatUsageSummary(summary)
    const hasPerModel = lines.some((line) => line.includes('Per-model usage:'))
    expect(hasPerModel).toBe(false)
  })

  test('formats zero values correctly', () => {
    const summary: LoopUsageSummary = {
      totalCost: 0,
      totalTokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      perModel: [],
    }

    const lines = formatUsageSummary(summary)
    expect(lines[0]).toContain('$0.0000')
    expect(lines[0]).toContain('0 in')
  })
})
