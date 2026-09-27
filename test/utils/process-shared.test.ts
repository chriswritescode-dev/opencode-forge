import { describe, test, expect, vi } from 'vitest'
import { processShared } from '../../src/utils/process-shared'

describe('processShared', () => {
  test('creates a value once per key and returns it on every later call', () => {
    const create = vi.fn(() => new Map<string, number>())
    const first = processShared('test.process-shared.once', create)
    const second = processShared('test.process-shared.once', create)

    expect(second).toBe(first)
    expect(create).toHaveBeenCalledTimes(1)
    expect(processShared('test.process-shared.other', () => new Map())).not.toBe(first)
  })

  test('module copies of the loop registry and in-flight guard share one store', async () => {
    vi.resetModules()
    const registryA = await import('../../src/utils/loop-registry')
    const guardA = await import('../../src/loop/in-flight-guard')
    registryA.loopRegistry.add('loop-shared-copy')
    guardA.markPromptInFlight('loop-shared-copy', 'ses-shared', 'code')

    vi.resetModules()
    const registryB = await import('../../src/utils/loop-registry')
    const guardB = await import('../../src/loop/in-flight-guard')

    expect(registryB).not.toBe(registryA)
    expect(registryB.loopRegistry.has('loop-shared-copy')).toBe(true)
    expect(guardB.getPromptInFlight('loop-shared-copy')?.sessionId).toBe('ses-shared')

    registryB.loopRegistry.remove('loop-shared-copy')
    guardB.clearPromptInFlight('loop-shared-copy')
  })
})
