import { describe, test, expect, vi } from 'vitest'
import { processShared, projectLoopKey } from '../../src/utils/process-shared'

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
    registryA.loopRegistry.add('proj-shared', 'loop-shared-copy')
    guardA.markPromptInFlight('proj-shared', 'loop-shared-copy', 'ses-shared', 'code')

    vi.resetModules()
    const registryB = await import('../../src/utils/loop-registry')
    const guardB = await import('../../src/loop/in-flight-guard')

    expect(registryB).not.toBe(registryA)
    expect(registryB.loopRegistry.has('proj-shared', 'loop-shared-copy')).toBe(true)
    expect(guardB.getPromptInFlight('proj-shared', 'loop-shared-copy')?.sessionId).toBe('ses-shared')

    registryB.loopRegistry.remove('proj-shared', 'loop-shared-copy')
    guardB.clearPromptInFlight('proj-shared', 'loop-shared-copy')
  })

  test('projectLoopKey separates same-named loops in different projects', () => {
    expect(projectLoopKey('proj-a', 'loop')).not.toBe(projectLoopKey('proj-b', 'loop'))
    expect(projectLoopKey('proj-a', 'loop')).toBe(projectLoopKey('proj-a', 'loop'))
  })

  test('same loop name in two projects shares no in-flight, awaiting-busy, or registry state', async () => {
    vi.resetModules()
    const guard = await import('../../src/loop/in-flight-guard')
    const idle = await import('../../src/loop/idle-gate')
    const { loopRegistry } = await import('../../src/utils/loop-registry')
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() }

    guard.markPromptInFlight('proj-a', 'shared', 'sess-a', 'code')
    idle.markPromptSent('proj-a', 'shared', 'sess-a', logger)
    loopRegistry.add('proj-a', 'shared')

    expect(guard.getPromptInFlight('proj-b', 'shared')).toBeUndefined()
    expect(idle.isAwaitingBusy('proj-b', 'shared', 'sess-a')).toBe(false)
    expect(loopRegistry.has('proj-b', 'shared')).toBe(false)
    expect(loopRegistry.getAll('proj-a')).toEqual(['shared'])
    expect(loopRegistry.getAll('proj-b')).toEqual([])

    guard.clearPromptInFlight('proj-a', 'shared')
    idle.clearPromptPending('proj-a', 'shared', logger)
    loopRegistry.remove('proj-a', 'shared')
    idle.__resetIdleGate()
  })
})
