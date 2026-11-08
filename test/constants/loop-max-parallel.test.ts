import { describe, test, expect } from 'vitest'
import {
  DEFAULT_MAX_PARALLEL_SECTIONS,
  MAX_TOTAL_SECTIONS,
  collectMaxParallelSectionsWarnings,
  parseMaxParallelSections,
  resolveMaxParallelSections,
} from '../../src/constants/loop'
import type { PluginConfig } from '../../src/types'

describe('resolveMaxParallelSections', () => {
  test('defaults when the loop config is absent or unset', () => {
    expect(resolveMaxParallelSections(undefined)).toBe(DEFAULT_MAX_PARALLEL_SECTIONS)
    expect(resolveMaxParallelSections({})).toBe(DEFAULT_MAX_PARALLEL_SECTIONS)
    expect(resolveMaxParallelSections({ loop: {} })).toBe(DEFAULT_MAX_PARALLEL_SECTIONS)
  })

  test('accepts a configured integer of at least 1', () => {
    expect(resolveMaxParallelSections({ loop: { maxParallelSections: 1 } })).toBe(1)
    expect(resolveMaxParallelSections({ loop: { maxParallelSections: 4 } })).toBe(4)
  })

  test('falls back to the default for invalid values', () => {
    for (const raw of [0, -1, 1.5, Number.POSITIVE_INFINITY, '3', true]) {
      const config = { loop: { maxParallelSections: raw } } as unknown as PluginConfig
      expect(resolveMaxParallelSections(config)).toBe(DEFAULT_MAX_PARALLEL_SECTIONS)
    }
  })

  test('clamps a value above the section cap', () => {
    const config: PluginConfig = { loop: { maxParallelSections: MAX_TOTAL_SECTIONS + 5 } }
    expect(resolveMaxParallelSections(config)).toBe(MAX_TOTAL_SECTIONS)
  })
})

describe('collectMaxParallelSectionsWarnings', () => {
  test('is empty for unset and valid values', () => {
    expect(collectMaxParallelSectionsWarnings(undefined)).toEqual([])
    expect(collectMaxParallelSectionsWarnings({ loop: { maxParallelSections: 3 } })).toEqual([])
    expect(collectMaxParallelSectionsWarnings({ loop: { maxParallelSections: MAX_TOTAL_SECTIONS } })).toEqual([])
  })

  test('warns when the value is invalid and is replaced by the default', () => {
    const config: PluginConfig = { loop: { maxParallelSections: 0 } }
    expect(collectMaxParallelSectionsWarnings(config)).toEqual([
      `loop.maxParallelSections is ignored: expected an integer of at least 1, using the default ${DEFAULT_MAX_PARALLEL_SECTIONS}`,
    ])
    expect(parseMaxParallelSections('2').value).toBe(DEFAULT_MAX_PARALLEL_SECTIONS)
  })

  test('warns when the value is clamped to the section cap', () => {
    const config: PluginConfig = { loop: { maxParallelSections: MAX_TOTAL_SECTIONS + 1 } }
    expect(collectMaxParallelSectionsWarnings(config)).toEqual([
      `loop.maxParallelSections ${MAX_TOTAL_SECTIONS + 1} exceeds the ${MAX_TOTAL_SECTIONS}-section cap, using ${MAX_TOTAL_SECTIONS}`,
    ])
  })
})
