import { describe, test, expect } from 'bun:test'
import {
  emptyTokenBreakdown,
  normalizeTokens,
  addTokens,
  modelLabelFromMessage,
  summarizeAssistantUsage,
  mergeUsageSummaries,
  type TokenBreakdown,
  type ModelUsage,
  type LoopUsageSummary,
} from '../../src/loop/token-usage'

describe('emptyTokenBreakdown', () => {
  test('returns zeroed token breakdown', () => {
    const result = emptyTokenBreakdown()
    expect(result).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })
})

describe('normalizeTokens', () => {
  test('handles undefined input', () => {
    expect(normalizeTokens(undefined)).toEqual(emptyTokenBreakdown())
    expect(normalizeTokens(null)).toEqual(emptyTokenBreakdown())
  })

  test('normalizes SDK token format', () => {
    const sdkTokens = {
      input: 100,
      output: 50,
      reasoning: 25,
      cache: { read: 10, write: 5 },
    }
    const result = normalizeTokens(sdkTokens)
    expect(result).toEqual({
      input: 100,
      output: 50,
      reasoning: 25,
      cacheRead: 10,
      cacheWrite: 5,
    })
  })

  test('handles zero values', () => {
    const sdkTokens = {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }
    const result = normalizeTokens(sdkTokens)
    expect(result).toEqual(emptyTokenBreakdown())
  })
})

describe('addTokens', () => {
  test('adds two token breakdowns', () => {
    const a: TokenBreakdown = { input: 100, output: 50, reasoning: 25, cacheRead: 10, cacheWrite: 5 }
    const b: TokenBreakdown = { input: 200, output: 100, reasoning: 50, cacheRead: 20, cacheWrite: 10 }
    const result = addTokens(a, b)
    expect(result).toEqual({
      input: 300,
      output: 150,
      reasoning: 75,
      cacheRead: 30,
      cacheWrite: 15,
    })
  })

  test('handles zero values', () => {
    const a = emptyTokenBreakdown()
    const b: TokenBreakdown = { input: 100, output: 50, reasoning: 25, cacheRead: 10, cacheWrite: 5 }
    const result = addTokens(a, b)
    expect(result).toEqual(b)
  })
})

describe('modelLabelFromMessage', () => {
  test('prefers info.model', () => {
    const info = { role: 'assistant', model: 'claude-3-opus' }
    expect(modelLabelFromMessage(info, 'fallback')).toBe('claude-3-opus')
  })

  test('uses modelID as-is when it lacks provider (actual message model wins)', () => {
    const info = { role: 'assistant', modelID: 'claude-3-sonnet' }
    expect(modelLabelFromMessage(info, 'fallback')).toBe('claude-3-sonnet')
  })

  test('uses modelId as-is when it lacks provider (actual message model wins)', () => {
    const info = { role: 'assistant', modelId: 'claude-3-haiku' }
    expect(modelLabelFromMessage(info, 'fallback')).toBe('claude-3-haiku')
  })

  test('uses provider/model_name pair', () => {
    const info = { role: 'assistant', provider: 'anthropic', model_name: 'claude-3' }
    expect(modelLabelFromMessage(info, 'fallback')).toBe('anthropic/claude-3')
  })

  test('uses fallbackModel when no metadata', () => {
    const info = { role: 'assistant' }
    expect(modelLabelFromMessage(info, 'my-fallback-model')).toBe('my-fallback-model')
  })

  test('returns default model label when no metadata and no fallback', () => {
    const info = { role: 'assistant' }
    expect(modelLabelFromMessage(info)).toBe('default/session model')
  })

  test('handles undefined info', () => {
    expect(modelLabelFromMessage(undefined, 'fallback')).toBe('fallback')
    expect(modelLabelFromMessage(undefined)).toBe('default/session model')
  })

  test('model field takes precedence over modelID', () => {
    const info = { role: 'assistant', model: 'preferred', modelID: 'ignored' }
    expect(modelLabelFromMessage(info)).toBe('preferred')
  })

  test('combines providerID + modelID as provider/model label', () => {
    const info = { role: 'assistant', providerID: 'anthropic', modelID: 'claude-3-opus' }
    expect(modelLabelFromMessage(info)).toBe('anthropic/claude-3-opus')
  })

  test('combines providerID + modelId as provider/model label', () => {
    const info = { role: 'assistant', providerID: 'openai', modelId: 'gpt-4' }
    expect(modelLabelFromMessage(info)).toBe('openai/gpt-4')
  })

  test('modelID without providerID uses the model ID as-is (actual message model wins)', () => {
    const info = { role: 'assistant', modelID: 'claude-3-sonnet' }
    expect(modelLabelFromMessage(info, 'fallback-model')).toBe('claude-3-sonnet')
  })

  test('modelID without providerID and no fallback uses the model ID as-is', () => {
    const info = { role: 'assistant', modelID: 'claude-3-sonnet' }
    expect(modelLabelFromMessage(info)).toBe('claude-3-sonnet')
  })

  test('modelId without provider uses the model ID as-is (actual message model wins)', () => {
    const info = { role: 'assistant', modelId: 'gpt-4-turbo' }
    expect(modelLabelFromMessage(info, 'fallback-model')).toBe('gpt-4-turbo')
  })

  test('providerID + model_name combines as provider/model', () => {
    const info = { role: 'assistant', providerID: 'google', model_name: 'gemini-pro' }
    expect(modelLabelFromMessage(info)).toBe('google/gemini-pro')
  })

  test('model field takes precedence over providerID/modelID pair', () => {
    const info = { role: 'assistant', model: 'direct-model', providerID: 'anthropic', modelID: 'claude-3' }
    expect(modelLabelFromMessage(info)).toBe('direct-model')
  })

  test('providerID + modelID takes precedence over provider + model_name', () => {
    const info = { role: 'assistant', providerID: 'anthropic', modelID: 'claude-3-opus', provider: 'openai', model_name: 'gpt-4' }
    expect(modelLabelFromMessage(info)).toBe('anthropic/claude-3-opus')
  })

  test('combines provider + modelID as provider/model label', () => {
    const info = { role: 'assistant', provider: 'anthropic', modelID: 'claude-3-opus' }
    expect(modelLabelFromMessage(info)).toBe('anthropic/claude-3-opus')
  })

  test('combines provider + modelId as provider/model label', () => {
    const info = { role: 'assistant', provider: 'openai', modelId: 'gpt-4' }
    expect(modelLabelFromMessage(info)).toBe('openai/gpt-4')
  })

  test('provider + modelID takes precedence over provider + model_name', () => {
    const info = { role: 'assistant', provider: 'anthropic', modelID: 'claude-3-opus', model_name: 'claude-3-sonnet' }
    expect(modelLabelFromMessage(info)).toBe('anthropic/claude-3-opus')
  })
})

describe('summarizeAssistantUsage', () => {
  test('sums assistant-only usage', () => {
    const messages = [
      { info: { role: 'assistant', cost: 0.01, tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } } } },
      { info: { role: 'assistant', cost: 0.02, tokens: { input: 200, output: 100, reasoning: 20, cache: { read: 10, write: 4 } } } },
      { info: { role: 'user', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } },
    ]

    const summary = summarizeAssistantUsage(messages)
    expect(summary.totalCost).toBe(0.03)
    expect(summary.totalTokens).toEqual({
      input: 300,
      output: 150,
      reasoning: 30,
      cacheRead: 15,
      cacheWrite: 6,
    })
  })

  test('groups by model metadata', () => {
    const messages = [
      { info: { role: 'assistant', cost: 0.01, tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } }, model: 'model-a' } },
      { info: { role: 'assistant', cost: 0.02, tokens: { input: 200, output: 100, reasoning: 20, cache: { read: 10, write: 4 } }, model: 'model-b' } },
      { info: { role: 'assistant', cost: 0.015, tokens: { input: 150, output: 75, reasoning: 15, cache: { read: 7, write: 3 } }, model: 'model-a' } },
    ]

    const summary = summarizeAssistantUsage(messages)
    expect(summary.perModel).toHaveLength(2)
    expect(summary.perModel[0]).toEqual({
      model: 'model-a',
      cost: 0.025,
      tokens: { input: 250, output: 125, reasoning: 25, cacheRead: 12, cacheWrite: 5 },
      messageCount: 2,
    })
    expect(summary.perModel[1]).toEqual({
      model: 'model-b',
      cost: 0.02,
      tokens: { input: 200, output: 100, reasoning: 20, cacheRead: 10, cacheWrite: 4 },
      messageCount: 1,
    })
  })

  test('uses fallback model when message lacks metadata', () => {
    const messages = [
      { info: { role: 'assistant', cost: 0.01, tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } } } },
      { info: { role: 'assistant', cost: 0.02, tokens: { input: 200, output: 100, reasoning: 20, cache: { read: 10, write: 4 } } } },
    ]

    const summary = summarizeAssistantUsage(messages, { role: 'code', fallbackModel: 'fallback-model' })
    expect(summary.perModel).toHaveLength(1)
    expect(summary.perModel[0].model).toBe('fallback-model')
    expect(summary.attribution).toEqual({ role: 'code', fallbackModel: 'fallback-model' })
  })

  test('deterministic merge/group sorting', () => {
    const messages = [
      { info: { role: 'assistant', cost: 0.01, model: 'z-model', tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } } } },
      { info: { role: 'assistant', cost: 0.02, model: 'a-model', tokens: { input: 200, output: 100, reasoning: 20, cache: { read: 10, write: 4 } } } },
      { info: { role: 'assistant', cost: 0.015, model: 'm-model', tokens: { input: 150, output: 75, reasoning: 15, cache: { read: 7, write: 3 } } } },
    ]

    const summary = summarizeAssistantUsage(messages)
    expect(summary.perModel.map((m) => m.model)).toEqual(['a-model', 'm-model', 'z-model'])
  })

  test('handles empty messages', () => {
    const summary = summarizeAssistantUsage([])
    expect(summary.totalCost).toBe(0)
    expect(summary.totalTokens).toEqual(emptyTokenBreakdown())
    expect(summary.perModel).toHaveLength(0)
  })

  test('uses default model label when no metadata and no fallback', () => {
    const messages = [
      { info: { role: 'assistant', cost: 0.01, tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } } } },
    ]

    const summary = summarizeAssistantUsage(messages)
    expect(summary.perModel).toHaveLength(1)
    expect(summary.perModel[0].model).toBe('default/session model')
  })

  test('handles messages with missing tokens', () => {
    const messages = [
      { info: { role: 'assistant', cost: 0.01 } },
      { info: { role: 'assistant', cost: 0.02, tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } } } },
    ]

    const summary = summarizeAssistantUsage(messages)
    expect(summary.totalCost).toBe(0.03)
    expect(summary.totalTokens).toEqual({ input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 2 })
  })

  test('handles messages with missing cost', () => {
    const messages = [
      { info: { role: 'assistant', tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } } } },
      { info: { role: 'assistant', cost: 0.02, tokens: { input: 200, output: 100, reasoning: 20, cache: { read: 10, write: 4 } } } },
    ]

    const summary = summarizeAssistantUsage(messages)
    expect(summary.totalCost).toBe(0.02)
  })
})

describe('mergeUsageSummaries', () => {
  test('merges multiple summaries', () => {
    const summary1: LoopUsageSummary = {
      totalCost: 0.01,
      totalTokens: { input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 2 },
      perModel: [{ model: 'model-a', cost: 0.01, tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 2 }, messageCount: 1 }],
    }

    const summary2: LoopUsageSummary = {
      totalCost: 0.02,
      totalTokens: { input: 200, output: 100, reasoning: 20, cacheRead: 10, cacheWrite: 4 },
      perModel: [{ model: 'model-b', cost: 0.02, tokens: { input: 200, output: 100, reasoning: 20, cacheRead: 10, cacheWrite: 4 }, messageCount: 1 }],
    }

    const merged = mergeUsageSummaries(summary1, summary2)
    expect(merged.totalCost).toBe(0.03)
    expect(merged.totalTokens).toEqual({ input: 300, output: 150, reasoning: 30, cacheRead: 15, cacheWrite: 6 })
    expect(merged.perModel).toHaveLength(2)
    expect(merged.perModel.map((m) => m.model)).toEqual(['model-a', 'model-b'])
  })

  test('merges same model across summaries', () => {
    const summary1: LoopUsageSummary = {
      totalCost: 0.01,
      totalTokens: { input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 2 },
      perModel: [{ model: 'model-a', cost: 0.01, tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 2 }, messageCount: 1 }],
    }

    const summary2: LoopUsageSummary = {
      totalCost: 0.02,
      totalTokens: { input: 200, output: 100, reasoning: 20, cacheRead: 10, cacheWrite: 4 },
      perModel: [{ model: 'model-a', cost: 0.02, tokens: { input: 200, output: 100, reasoning: 20, cacheRead: 10, cacheWrite: 4 }, messageCount: 1 }],
    }

    const merged = mergeUsageSummaries(summary1, summary2)
    expect(merged.totalCost).toBe(0.03)
    expect(merged.perModel).toHaveLength(1)
    expect(merged.perModel[0]).toEqual({
      model: 'model-a',
      cost: 0.03,
      tokens: { input: 300, output: 150, reasoning: 30, cacheRead: 15, cacheWrite: 6 },
      messageCount: 2,
    })
  })

  test('preserves attribution from first summary', () => {
    const summary1: LoopUsageSummary = {
      totalCost: 0.01,
      totalTokens: { input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 2 },
      perModel: [],
      attribution: { role: 'code', fallbackModel: 'model-a' },
    }

    const summary2: LoopUsageSummary = {
      totalCost: 0.02,
      totalTokens: { input: 200, output: 100, reasoning: 20, cacheRead: 10, cacheWrite: 4 },
      perModel: [],
      attribution: { role: 'auditor', fallbackModel: 'model-b' },
    }

    const merged = mergeUsageSummaries(summary1, summary2)
    expect(merged.attribution).toEqual({ role: 'code', fallbackModel: 'model-a' })
  })

  test('handles empty array', () => {
    const merged = mergeUsageSummaries()
    expect(merged.totalCost).toBe(0)
    expect(merged.totalTokens).toEqual(emptyTokenBreakdown())
    expect(merged.perModel).toHaveLength(0)
  })

  test('deterministic sorting after merge', () => {
    const summary1: LoopUsageSummary = {
      totalCost: 0.01,
      totalTokens: { input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 2 },
      perModel: [{ model: 'z-model', cost: 0.01, tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 2 }, messageCount: 1 }],
    }

    const summary2: LoopUsageSummary = {
      totalCost: 0.02,
      totalTokens: { input: 200, output: 100, reasoning: 20, cacheRead: 10, cacheWrite: 4 },
      perModel: [{ model: 'a-model', cost: 0.02, tokens: { input: 200, output: 100, reasoning: 20, cacheRead: 10, cacheWrite: 4 }, messageCount: 1 }],
    }

    const merged = mergeUsageSummaries(summary1, summary2)
    expect(merged.perModel.map((m) => m.model)).toEqual(['a-model', 'z-model'])
  })
})
