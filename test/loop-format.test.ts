import { describe, test, expect } from 'vitest'
import { formatTokens, formatSessionOutput, formatAuditResult, formatUsageSummary, formatCumulativeUsage, aggregateToUsageSummary } from '../src/utils/loop-format'
import type { LoopSessionOutput } from '../src/loop/session-output'
import type { LoopUsageSummary } from '../src/loop/token-usage'
import type { LoopUsageAggregate } from '../src/storage/repos/loop-session-usage-repo'

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

describe('aggregateToUsageSummary', () => {
  function makeAggregate(overrides: Partial<LoopUsageAggregate> = {}): LoopUsageAggregate {
    return {
      loopName: 'loop',
      totalCost: 0.05,
      totalInputTokens: 5000,
      totalOutputTokens: 2500,
      totalReasoningTokens: 500,
      totalCacheReadTokens: 100,
      totalCacheWriteTokens: 200,
      totalMessageCount: 10,
      byModel: {
        'model-a': { cost: 0.03, inputTokens: 3000, outputTokens: 1500, reasoningTokens: 300, cacheReadTokens: 60, cacheWriteTokens: 120, messageCount: 6 },
        'model-b': { cost: 0.02, inputTokens: 2000, outputTokens: 1000, reasoningTokens: 200, cacheReadTokens: 40, cacheWriteTokens: 80, messageCount: 4 },
      },
      byRole: {
        code: { cost: 0.04, inputTokens: 4000, outputTokens: 2000, reasoningTokens: 400, cacheReadTokens: 80, cacheWriteTokens: 160, messageCount: 8 },
        auditor: { cost: 0.01, inputTokens: 1000, outputTokens: 500, reasoningTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 40, messageCount: 2 },
      },
      ...overrides,
    }
  }

  test('derives perRole from byRole in code, auditor, unknown order', () => {
    const agg = makeAggregate({
      byRole: {
        unknown: { cost: 0.005, inputTokens: 500, outputTokens: 250, reasoningTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 20, messageCount: 1 },
        auditor: { cost: 0.01, inputTokens: 1000, outputTokens: 500, reasoningTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 40, messageCount: 2 },
        code: { cost: 0.04, inputTokens: 4000, outputTokens: 2000, reasoningTokens: 400, cacheReadTokens: 80, cacheWriteTokens: 160, messageCount: 8 },
      },
    })

    const summary = aggregateToUsageSummary(agg)
    expect(summary.perRole?.map(r => r.role)).toEqual(['code', 'auditor', 'unknown'])
    const code = summary.perRole?.find(r => r.role === 'code')!
    expect(code.cost).toBe(0.04)
    expect(code.messageCount).toBe(8)
    expect(code.tokens).toEqual({ input: 4000, output: 2000, reasoning: 400, cacheRead: 80, cacheWrite: 160 })
  })

  test('omits absent roles from perRole', () => {
    const summary = aggregateToUsageSummary(makeAggregate())
    expect(summary.perRole?.map(r => r.role)).toEqual(['code', 'auditor'])
  })
})

describe('formatUsageSummary per-role block', () => {
  test('appends a Per-role usage block after the per-model rows', () => {
    const summary: LoopUsageSummary = {
      totalCost: 0.05,
      totalTokens: { input: 5000, output: 2500, reasoning: 500, cacheRead: 100, cacheWrite: 200 },
      perModel: [
        { model: 'model-a', cost: 0.03, tokens: { input: 3000, output: 1500, reasoning: 300, cacheRead: 60, cacheWrite: 120 }, messageCount: 6 },
        { model: 'model-b', cost: 0.02, tokens: { input: 2000, output: 1000, reasoning: 200, cacheRead: 40, cacheWrite: 80 }, messageCount: 4 },
      ],
      perRole: [
        { role: 'code', cost: 0.04, tokens: { input: 4000, output: 2000, reasoning: 400, cacheRead: 80, cacheWrite: 160 }, messageCount: 8 },
        { role: 'auditor', cost: 0.01, tokens: { input: 1000, output: 500, reasoning: 100, cacheRead: 20, cacheWrite: 40 }, messageCount: 2 },
      ],
    }

    const lines = formatUsageSummary(summary)
    const perModelIndex = lines.indexOf('Per-model usage:')
    const perRoleIndex = lines.indexOf('Per-role usage:')
    expect(perRoleIndex).toBeGreaterThan(perModelIndex)
    const roleRows = lines.slice(perRoleIndex + 1)
    expect(roleRows[0]).toContain('code:')
    expect(roleRows[0]).toContain('$0.0400')
    expect(roleRows[1]).toContain('auditor:')
    expect(roleRows[1]).toContain('$0.0100')
    // Per-model rows must remain exactly the two model rows immediately after
    // 'Per-model usage:'.
    const modelRows = lines.slice(perModelIndex + 1, perRoleIndex)
    expect(modelRows).toHaveLength(2)
    expect(modelRows[0]).toContain('model-a:')
    expect(modelRows[1]).toContain('model-b:')
  })

  test('omits the role block when perRole is empty', () => {
    const summary: LoopUsageSummary = {
      totalCost: 0.01,
      totalTokens: { input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 2 },
      perModel: [],
      perRole: [],
    }
    expect(formatUsageSummary(summary).some(l => l.includes('Per-role usage:'))).toBe(false)
  })

  test('omits the role block when perRole is absent', () => {
    const summary: LoopUsageSummary = {
      totalCost: 0.01,
      totalTokens: { input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 2 },
      perModel: [],
    }
    expect(formatUsageSummary(summary).some(l => l.includes('Per-role usage:'))).toBe(false)
  })
})

describe('formatCumulativeUsage', () => {
  test('returns [] when there is no usage', () => {
    expect(formatCumulativeUsage(undefined, 'p', 'loop', 'session', null)).toEqual([])
  })

  test('returns a leading blank line plus heading when there is usage', () => {
    const repo = {
      getAggregate: () => ({
        loopName: 'loop',
        totalCost: 0.05,
        totalInputTokens: 5000,
        totalOutputTokens: 2500,
        totalReasoningTokens: 500,
        totalCacheReadTokens: 100,
        totalCacheWriteTokens: 200,
        totalMessageCount: 10,
        byModel: { 'model-a': { cost: 0.05, inputTokens: 5000, outputTokens: 2500, reasoningTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 200, messageCount: 10 } },
        byRole: { code: { cost: 0.05, inputTokens: 5000, outputTokens: 2500, reasoningTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 200, messageCount: 10 } },
      }),
      hasSession: () => true,
    } as any
    const lines = formatCumulativeUsage(repo, 'p', 'loop', 'session', null)
    expect(lines[0]).toBe('')
    expect(lines[1]).toBe('Cumulative Usage:')
    expect(lines.join('\n')).toContain('Total Cost: $0.0500')
    expect(lines.join('\n')).toContain('Per-role usage:')
  })
})
