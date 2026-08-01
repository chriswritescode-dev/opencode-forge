import { describe, it, expect } from 'vitest'
import { resolveLoopModel, resolveLoopAuditorChoice, buildAuditorModelChain, auditorModelChoiceAt, nextAuditorFallbackIndex, resolveUsageFallbackModelLabel, formatDuration, computeElapsedSeconds } from '../src/utils/loop-helpers'
import type { PluginConfig } from '../src/types'

describe('resolveLoopModel', () => {
  const createMockLoopService = (state: any) => ({
    getActiveState: (name: string) => state,
  } as any)

  it('returns undefined when modelFailed is true', () => {
    const mockLoopService = createMockLoopService({ active: true, modelFailed: true })
    const config = { executionModel: 'provider/model' } as PluginConfig
    const result = resolveLoopModel(config, mockLoopService, 'failed-worktree')
    expect(result).toBeUndefined()
  })

  it('returns parsed model when available', () => {
    const mockLoopService = createMockLoopService({ active: true, modelFailed: false })
    const config = { executionModel: 'provider/model' } as PluginConfig
    const result = resolveLoopModel(config, mockLoopService, 'valid-worktree')
    expect(result).toEqual({ providerID: 'provider', modelID: 'model' })
  })

  it('returns undefined when no model configured', () => {
    const mockLoopService = createMockLoopService({ active: true, modelFailed: false })
    const config = {} as PluginConfig
    const result = resolveLoopModel(config, mockLoopService, 'valid-worktree')
    expect(result).toBeUndefined()
  })

  it('prefers state.executionModel over config.executionModel', () => {
    const mockLoopService = createMockLoopService({ 
      active: true, 
      modelFailed: false,
      executionModel: 'provider/state-model',
    })
    const config = { executionModel: 'provider/config-model' } as PluginConfig
    const result = resolveLoopModel(config, mockLoopService, 'test-loop')
    expect(result).toEqual({ providerID: 'provider', modelID: 'state-model' })
  })

  it('falls back to config.executionModel', () => {
    const mockLoopService = createMockLoopService({ 
      active: true, 
      modelFailed: false,
    })
    const config = { executionModel: 'provider/exec-model' } as PluginConfig
    const result = resolveLoopModel(config, mockLoopService, 'test-loop')
    expect(result).toEqual({ providerID: 'provider', modelID: 'exec-model' })
  })

})

describe('resolveLoopAuditorModel', () => {
  const createMockLoopService = (state: any) => ({
    getActiveState: (name: string) => state,
  } as any)

  it('prefers state.auditorModel over all config values', () => {
    const mockLoopService = createMockLoopService({ 
      active: true, 
      auditorModel: 'provider/state-auditor',
      executionModel: 'provider/state-exec',
    })
    const config = { 
      auditorModel: 'provider/config-auditor',
      executionModel: 'provider/exec-model',
    } as PluginConfig
    const result = resolveLoopAuditorChoice(config, mockLoopService, 'test-loop').model
    expect(result).toEqual({ providerID: 'provider', modelID: 'state-auditor' })
  })

  it('falls back to state.executionModel when state.auditorModel is missing', () => {
    const mockLoopService = createMockLoopService({ 
      active: true, 
      executionModel: 'provider/state-exec',
    })
    const config = { 
      auditorModel: 'provider/config-auditor',
      executionModel: 'provider/exec-model',
    } as PluginConfig
    const result = resolveLoopAuditorChoice(config, mockLoopService, 'test-loop').model
    expect(result).toEqual({ providerID: 'provider', modelID: 'state-exec' })
  })

  it('falls back to config.executionModel when state models are missing', () => {
    const mockLoopService = createMockLoopService({ 
      active: true,
    })
    const config = { 
      auditorModel: 'provider/config-auditor',
      executionModel: 'provider/exec-model',
    } as PluginConfig
    const result = resolveLoopAuditorChoice(config, mockLoopService, 'test-loop').model
    expect(result).toEqual({ providerID: 'provider', modelID: 'exec-model' })
  })

  it('ignores config.auditorModel without a stored state model or config.executionModel', () => {
    const mockLoopService = createMockLoopService({ 
      active: true,
    })
    const config = { 
      auditorModel: 'provider/config-auditor',
    } as PluginConfig
    const result = resolveLoopAuditorChoice(config, mockLoopService, 'test-loop').model
    expect(result).toBeUndefined()
  })

  it('falls back to config.executionModel as last resort', () => {
    const mockLoopService = createMockLoopService({ 
      active: true,
    })
    const config = { 
      executionModel: 'provider/exec-model',
    } as PluginConfig
    const result = resolveLoopAuditorChoice(config, mockLoopService, 'test-loop').model
    expect(result).toEqual({ providerID: 'provider', modelID: 'exec-model' })
  })

  it('returns undefined when no models configured', () => {
    const mockLoopService = createMockLoopService({ 
      active: true,
    })
    const config = {} as PluginConfig
    const result = resolveLoopAuditorChoice(config, mockLoopService, 'test-loop').model
    expect(result).toBeUndefined()
  })

  it('returns undefined when modelFailed is true', () => {
    const mockLoopService = createMockLoopService({ 
      active: true,
      modelFailed: true,
      auditorModel: 'provider/state-auditor',
      executionModel: 'provider/state-exec',
    })
    const config = { 
      auditorModel: 'provider/config-auditor',
      loop: { model: 'provider/loop-model' },
      executionModel: 'provider/exec-model',
    } as PluginConfig
    const result = resolveLoopAuditorChoice(config, mockLoopService, 'test-loop').model
    expect(result).toBeUndefined()
  })
})

describe('resolveLoopAuditorChoice', () => {
  const createMockLoopService = (state: any) => ({
    getActiveState: (name: string) => state,
  } as any)

  it('defaults to index 0 (primary auditor model + state variant)', () => {
    const mockLoopService = createMockLoopService({
      active: true,
      auditorModel: 'provider/primary',
      auditorVariant: 'audit-high',
    })
    const config = { auditorFallbackModels: ['provider/fb'] } as PluginConfig
    const choice = resolveLoopAuditorChoice(config, mockLoopService, 'test-loop')
    expect(choice.model).toEqual({ providerID: 'provider', modelID: 'primary' })
    expect(choice.variant).toBe('audit-high')
  })

  it('selects the fallback at the persisted index with no variant', () => {
    const mockLoopService = createMockLoopService({
      active: true,
      auditorModel: 'provider/primary',
      auditorVariant: 'audit-high',
      auditorFallbackIndex: 1,
    })
    const config = { auditorFallbackModels: ['provider/fb'] } as PluginConfig
    const choice = resolveLoopAuditorChoice(config, mockLoopService, 'test-loop')
    expect(choice.model).toEqual({ providerID: 'provider', modelID: 'fb' })
    expect(choice.variant).toBeUndefined()
  })

  it('preserves modelFailed → undefined model while keeping state variant at index 0', () => {
    const mockLoopService = createMockLoopService({
      active: true,
      modelFailed: true,
      auditorModel: 'provider/primary',
      auditorVariant: 'audit-high',
    })
    const config = { auditorFallbackModels: ['provider/fb'] } as PluginConfig
    const choice = resolveLoopAuditorChoice(config, mockLoopService, 'test-loop')
    expect(choice.model).toBeUndefined()
    expect(choice.variant).toBe('audit-high')
  })

  it('logs the resolution with index and source', () => {
    const mockLoopService = createMockLoopService({
      active: true,
      auditorModel: 'provider/primary',
      auditorFallbackIndex: 1,
    })
    const config = { auditorFallbackModels: ['provider/fb'] } as PluginConfig
    const logs: string[] = []
    const logger = { log: (m: string) => logs.push(m), error: () => {}, debug: () => {} } as any
    resolveLoopAuditorChoice(config, mockLoopService, 'test-loop', logger)
    expect(logs[0]).toContain('resolveLoopAuditorChoice(test-loop)')
    expect(logs[0]).toContain('index=1/1')
    expect(logs[0]).toContain('provider/fb')
  })
})

describe('buildAuditorModelChain', () => {
  it('returns a 1-entry chain matching resolveLoopAuditorModel when no fallbacks configured', () => {
    const state: any = { active: true, auditorModel: 'provider/state-auditor' }
    const config = { executionModel: 'provider/exec-model' } as PluginConfig
    const chain = buildAuditorModelChain(config, state)
    expect(chain).toHaveLength(1)
    expect(chain[0]).toEqual({
      model: { providerID: 'provider', modelID: 'state-auditor' },
      variant: undefined,
      source: 'state.auditorModel=provider/state-auditor',
    })
    expect(chain[0].model).toEqual(resolveLoopAuditorChoice(config, { getActiveState: () => state } as any, 'test-loop').model)
  })

  it('preserves order, drops unparseable and duplicate entries', () => {
    const state: any = { active: true, executionModel: 'provider/primary' }
    const config = {
      auditorFallbackModels: [
        'provider/a',
        'bogus',
        '/model',
        'provider/',
        'provider/b',
        'provider/a',
        'provider/c',
      ],
    } as PluginConfig
    const chain = buildAuditorModelChain(config, state)
    expect(chain.map((c) => c.model)).toEqual([
      { providerID: 'provider', modelID: 'primary' },
      { providerID: 'provider', modelID: 'a' },
      { providerID: 'provider', modelID: 'b' },
      { providerID: 'provider', modelID: 'c' },
    ])
    expect(chain[1].variant).toBeUndefined()
    expect(chain[1].source).toBe('config.auditorFallbackModels[0]=provider/a')
  })

  it('seeds dedupe with entry 0 model so a matching fallback is dropped', () => {
    const state: any = { active: true, executionModel: 'provider/same' }
    const config = { auditorFallbackModels: ['provider/same', 'provider/other'] } as PluginConfig
    const chain = buildAuditorModelChain(config, state)
    expect(chain.map((c) => c.model)).toEqual([
      { providerID: 'provider', modelID: 'same' },
      { providerID: 'provider', modelID: 'other' },
    ])
  })

  it('nulls entry 0 model on modelFailed while configured fallbacks still appear', () => {
    const state: any = { active: true, modelFailed: true, auditorModel: 'provider/state-auditor' }
    const config = { auditorFallbackModels: ['provider/a', 'provider/b'] } as PluginConfig
    const chain = buildAuditorModelChain(config, state)
    expect(chain[0].model).toBeUndefined()
    expect(chain.slice(1).map((c) => c.model)).toEqual([
      { providerID: 'provider', modelID: 'a' },
      { providerID: 'provider', modelID: 'b' },
    ])
  })
})

describe('auditorModelChoiceAt', () => {
  it('returns the choice at a valid index', () => {
    const chain: any[] = [{ model: { providerID: 'p', modelID: 'a' } }, { model: { providerID: 'p', modelID: 'b' } }]
    expect(auditorModelChoiceAt(chain, 1).model).toEqual({ providerID: 'p', modelID: 'b' })
  })

  it('clamps out-of-range indexes', () => {
    const chain: any[] = [{ model: { providerID: 'p', modelID: 'a' } }]
    expect(auditorModelChoiceAt(chain, 5).model).toEqual({ providerID: 'p', modelID: 'a' })
    expect(auditorModelChoiceAt(chain, -3).model).toEqual({ providerID: 'p', modelID: 'a' })
  })
})

describe('nextAuditorFallbackIndex', () => {
  it('returns index + 1 when there is a next entry', () => {
    const chain: any[] = [{}, {}, {}]
    expect(nextAuditorFallbackIndex(chain, 0)).toBe(1)
  })

  it('returns null at the last index', () => {
    const chain: any[] = [{}, {}, {}]
    expect(nextAuditorFallbackIndex(chain, 2)).toBeNull()
  })
})

describe('resolveUsageFallbackModelLabel', () => {
  it('names the fallback model at the persisted index for auditing phases', () => {
    const state: any = {
      phase: 'auditing',
      auditorModel: 'provider/primary',
      auditorFallbackIndex: 1,
    }
    const config = { auditorFallbackModels: ['fb/auditor-2'] } as PluginConfig
    expect(resolveUsageFallbackModelLabel(config, state, state.phase)).toBe('fb/auditor-2')
  })

  it('at index 0 matches the legacy primary label for the same inputs', () => {
    const state: any = {
      phase: 'final_auditing',
      auditorModel: 'provider/state-auditor',
      executionModel: 'provider/state-exec',
      auditorFallbackIndex: 0,
    }
    const config = { auditorModel: 'provider/config-auditor', executionModel: 'provider/config-exec' } as PluginConfig
    const label = resolveUsageFallbackModelLabel(config, state, state.phase)
    expect(label).toBe('provider/state-auditor')
  })

  it('falls back to the richer legacy chain on modelFailed with no fallbacks', () => {
    const state: any = {
      phase: 'auditing',
      modelFailed: true,
      auditorModel: 'provider/state-auditor',
      executionModel: 'provider/state-exec',
      auditorFallbackIndex: 0,
    }
    const config = { auditorModel: 'provider/config-auditor', executionModel: 'provider/config-exec' } as PluginConfig
    expect(resolveUsageFallbackModelLabel(config, state, state.phase)).toBe('provider/state-auditor')
  })

  it('uses executionModel for coding-style phases', () => {
    const state: any = {
      phase: 'coding',
      auditorModel: 'provider/state-auditor',
      executionModel: 'provider/state-exec',
    }
    const config = { executionModel: 'provider/config-exec' } as PluginConfig
    expect(resolveUsageFallbackModelLabel(config, state, state.phase)).toBe('provider/state-exec')
  })

  it('falls back to config.executionModel for coding phases with no state model', () => {
    const state: any = { phase: 'coding' }
    const config = { executionModel: 'provider/config-exec' } as PluginConfig
    expect(resolveUsageFallbackModelLabel(config, state, state.phase)).toBe('provider/config-exec')
  })
})

describe('formatDuration', () => {
  it('formats seconds-only', () => {
    expect(formatDuration(45)).toBe('45s')
  })

  it('formats minutes+seconds', () => {
    expect(formatDuration(125)).toBe('2m 5s')
  })

  it('handles zero', () => {
    expect(formatDuration(0)).toBe('0s')
  })

  it('handles exact minutes', () => {
    expect(formatDuration(180)).toBe('3m 0s')
  })

  it('formats hours+minutes for durations over an hour', () => {
    expect(formatDuration(3661)).toBe('1h 1m')
    expect(formatDuration(7200)).toBe('2h 0m')
  })
})

describe('computeElapsedSeconds', () => {
  it('handles both timestamps', () => {
    const start = new Date('2024-01-01T00:00:00Z').toISOString()
    const end = new Date('2024-01-01T00:01:30Z').toISOString()
    expect(computeElapsedSeconds(start, end)).toBe(90)
  })

  it('handles missing start', () => {
    expect(computeElapsedSeconds(undefined, new Date().toISOString())).toBe(0)
  })

  it('handles missing end (uses Date.now)', () => {
    const start = new Date(Date.now() - 5000).toISOString()
    const elapsed = computeElapsedSeconds(start, undefined)
    expect(elapsed).toBeGreaterThanOrEqual(4)
    expect(elapsed).toBeLessThanOrEqual(6)
  })
})
