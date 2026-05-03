import { describe, it, expect } from 'bun:test'
import { resolveLoopModel, resolveLoopAuditorModel, formatDuration, computeElapsedSeconds } from '../src/utils/loop-helpers'
import type { PluginConfig } from '../src/types'

describe('resolveLoopModel', () => {
  const createMockLoopService = (state: any) => ({
    getActiveState: (name: string) => state,
  } as any)

  it('returns undefined when modelFailed is true', () => {
    const mockLoopService = createMockLoopService({ active: true, modelFailed: true })
    const config = { loop: { model: 'provider/model' } } as PluginConfig
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

  it('ignores config.loop.model so opencode default remains the final fallback', () => {
    const mockLoopService = createMockLoopService({ 
      active: true,
      modelFailed: false,
    })
    const config = { loop: { model: 'provider/loop-model' } } as PluginConfig
    const result = resolveLoopModel(config, mockLoopService, 'test-loop')
    expect(result).toBeUndefined()
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
      loop: { model: 'provider/loop-model' },
      executionModel: 'provider/exec-model',
    } as PluginConfig
    const result = resolveLoopAuditorModel(config, mockLoopService, 'test-loop')
    expect(result).toEqual({ providerID: 'provider', modelID: 'state-auditor' })
  })

  it('falls back to state.executionModel when state.auditorModel is missing', () => {
    const mockLoopService = createMockLoopService({ 
      active: true, 
      executionModel: 'provider/state-exec',
    })
    const config = { 
      auditorModel: 'provider/config-auditor',
      loop: { model: 'provider/loop-model' },
      executionModel: 'provider/exec-model',
    } as PluginConfig
    const result = resolveLoopAuditorModel(config, mockLoopService, 'test-loop')
    expect(result).toEqual({ providerID: 'provider', modelID: 'state-exec' })
  })

  it('falls back to config.executionModel when state models are missing', () => {
    const mockLoopService = createMockLoopService({ 
      active: true,
    })
    const config = { 
      auditorModel: 'provider/config-auditor',
      loop: { model: 'provider/loop-model' },
      executionModel: 'provider/exec-model',
    } as PluginConfig
    const result = resolveLoopAuditorModel(config, mockLoopService, 'test-loop')
    expect(result).toEqual({ providerID: 'provider', modelID: 'exec-model' })
  })

  it('ignores config.auditorModel and config.loop.model without a stored state model or config.executionModel', () => {
    const mockLoopService = createMockLoopService({ 
      active: true,
    })
    const config = { 
      auditorModel: 'provider/config-auditor',
      loop: { model: 'provider/loop-model' },
    } as PluginConfig
    const result = resolveLoopAuditorModel(config, mockLoopService, 'test-loop')
    expect(result).toBeUndefined()
  })

  it('falls back to config.executionModel as last resort', () => {
    const mockLoopService = createMockLoopService({ 
      active: true,
    })
    const config = { 
      executionModel: 'provider/exec-model',
    } as PluginConfig
    const result = resolveLoopAuditorModel(config, mockLoopService, 'test-loop')
    expect(result).toEqual({ providerID: 'provider', modelID: 'exec-model' })
  })

  it('returns undefined when no models configured', () => {
    const mockLoopService = createMockLoopService({ 
      active: true,
    })
    const config = {} as PluginConfig
    const result = resolveLoopAuditorModel(config, mockLoopService, 'test-loop')
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
    const result = resolveLoopAuditorModel(config, mockLoopService, 'test-loop')
    expect(result).toBeUndefined()
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
