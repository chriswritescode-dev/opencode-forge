import { describe, it, expect } from 'bun:test'
import { resolveLoopModel, formatDuration, computeElapsedSeconds } from '../src/utils/loop-helpers'
import type { PluginConfig } from '../src/types'

describe('resolveLoopModel', () => {
  const mockLoopService = {
    getActiveState: (name: string) => name === 'failed-worktree' 
      ? { active: true, modelFailed: true } 
      : { active: true, modelFailed: false },
  } as any

  it('returns undefined when modelFailed is true', () => {
    const config = { loop: { model: 'provider/model' } } as PluginConfig
    const result = resolveLoopModel(config, mockLoopService, 'failed-worktree')
    expect(result).toBeUndefined()
  })

  it('returns parsed model when available', () => {
    const config = { loop: { model: 'provider/model' } } as PluginConfig
    const result = resolveLoopModel(config, mockLoopService, 'valid-worktree')
    expect(result).toEqual({ providerID: 'provider', modelID: 'model' })
  })

  it('returns undefined when no model configured', () => {
    const config = {} as PluginConfig
    const result = resolveLoopModel(config, mockLoopService, 'valid-worktree')
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
