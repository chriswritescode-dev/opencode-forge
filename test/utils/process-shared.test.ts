import { describe, test, expect, vi } from 'vitest'
import {
  processShared,
  projectLoopKey,
  projectLoopLaneKey,
  deleteLoopLaneEntries,
} from '../../src/utils/process-shared'

const LANE = { loopName: 'loop-shared-copy', sectionRunKey: 'plan' }

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
    guardA.markPromptInFlight('proj-shared', LANE, 'ses-shared', 'code')

    vi.resetModules()
    const registryB = await import('../../src/utils/loop-registry')
    const guardB = await import('../../src/loop/in-flight-guard')

    expect(registryB).not.toBe(registryA)
    expect(registryB.loopRegistry.has('proj-shared', 'loop-shared-copy')).toBe(true)
    expect(guardB.getPromptInFlight('proj-shared', LANE)?.sessionId).toBe('ses-shared')

    registryB.loopRegistry.remove('proj-shared', 'loop-shared-copy')
    guardB.clearPromptInFlight('proj-shared', LANE)
  })

  test('projectLoopKey separates same-named loops in different projects', () => {
    expect(projectLoopKey('proj-a', 'loop')).not.toBe(projectLoopKey('proj-b', 'loop'))
    expect(projectLoopKey('proj-a', 'loop')).toBe(projectLoopKey('proj-a', 'loop'))
  })

  test('projectLoopLaneKey separates section runs of one loop and same-named loops in different projects', () => {
    expect(projectLoopLaneKey('proj-a', { loopName: 'loop', sectionRunKey: 'plan' })).not.toBe(
      projectLoopLaneKey('proj-a', { loopName: 'loop', sectionRunKey: 'section:section-1' }),
    )
    expect(projectLoopLaneKey('proj-a', { loopName: 'loop', sectionRunKey: 'plan' })).not.toBe(
      projectLoopLaneKey('proj-b', { loopName: 'loop', sectionRunKey: 'plan' }),
    )
    expect(projectLoopLaneKey('proj-a', { loopName: 'loop', sectionRunKey: 'plan' })).toBe(
      projectLoopLaneKey('proj-a', { loopName: 'loop', sectionRunKey: 'plan' }),
    )
  })

  test('deleteLoopLaneEntries removes only the requested loop lanes and returns their values', () => {
    const map = new Map<string, string>([
      [projectLoopLaneKey('proj-a', { loopName: 'loop', sectionRunKey: 'plan' }), 'plan'],
      [projectLoopLaneKey('proj-a', { loopName: 'loop', sectionRunKey: 'section:section-1' }), 'section-1'],
      [projectLoopLaneKey('proj-a', { loopName: 'other-loop', sectionRunKey: 'plan' }), 'other'],
      [projectLoopLaneKey('proj-b', { loopName: 'loop', sectionRunKey: 'plan' }), 'other-project'],
    ])

    expect(deleteLoopLaneEntries(map, 'proj-a', 'loop')).toEqual(['plan', 'section-1'])
    expect(map.size).toBe(2)
    expect(map.has(projectLoopLaneKey('proj-a', { loopName: 'other-loop', sectionRunKey: 'plan' }))).toBe(true)
    expect(map.has(projectLoopLaneKey('proj-b', { loopName: 'loop', sectionRunKey: 'plan' }))).toBe(true)
  })

  test('same loop name in two projects shares no in-flight, awaiting-busy, or registry state', async () => {
    vi.resetModules()
    const guard = await import('../../src/loop/in-flight-guard')
    const idle = await import('../../src/loop/idle-gate')
    const { loopRegistry } = await import('../../src/utils/loop-registry')
    const logger = { log: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const lane = { loopName: 'shared', sectionRunKey: 'plan' }

    guard.markPromptInFlight('proj-a', lane, 'sess-a', 'code')
    idle.markPromptSent('proj-a', lane, 'sess-a', logger)
    loopRegistry.add('proj-a', 'shared')

    expect(guard.getPromptInFlight('proj-b', lane)).toBeUndefined()
    expect(idle.isAwaitingBusy('proj-b', lane, 'sess-a')).toBe(false)
    expect(loopRegistry.has('proj-b', 'shared')).toBe(false)
    expect(loopRegistry.getAll('proj-a')).toEqual(['shared'])
    expect(loopRegistry.getAll('proj-b')).toEqual([])

    guard.clearPromptInFlight('proj-a', lane)
    idle.clearPromptPending('proj-a', lane, logger)
    loopRegistry.remove('proj-a', 'shared')
    idle.__resetIdleGate()
  })
})
