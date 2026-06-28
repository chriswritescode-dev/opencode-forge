import { describe, test, expect } from 'vitest'
import {
  computeSchedulerActions,
  type SchedulerFeature,
} from '../../src/services/group-scheduler'

function feat(index: number, stage: SchedulerFeature['stage']): SchedulerFeature {
  return { featureIndex: index, stage }
}

describe('computeSchedulerActions', () => {
  test('cap on planning: fills toPlan up to cap when all pending', () => {
    const features = Array.from({ length: 5 }, (_, i) => feat(i, 'pending'))

    const result = computeSchedulerActions(features, 3)

    expect(result.toPlan).toEqual([0, 1, 2])
    expect(result.toLaunch).toEqual([])
    expect(result.groupStatus).toBe('planning')
  })

  test('cap on launching: fills toLaunch up to available slots', () => {
    const features: SchedulerFeature[] = [
      feat(0, 'running'),
      feat(1, 'planned'),
      feat(2, 'planned'),
      feat(3, 'planned'),
    ]

    const result = computeSchedulerActions(features, 2)

    // runningInFlight=1 => launchSlots=1, picks first planned
    expect(result.toPlan).toEqual([])
    expect(result.toLaunch).toEqual([1])
    expect(result.groupStatus).toBe('running')
  })

  test('all features terminal returns completed with empty arrays', () => {
    const features: SchedulerFeature[] = [
      feat(0, 'completed'),
      feat(1, 'failed'),
      feat(2, 'cancelled'),
    ]

    const result = computeSchedulerActions(features, 3)

    expect(result.toPlan).toEqual([])
    expect(result.toLaunch).toEqual([])
    expect(result.groupStatus).toBe('completed')
  })

  test('failed features do not block scheduling of pending features', () => {
    const features: SchedulerFeature[] = [
      feat(0, 'failed'),
      feat(1, 'failed'),
      feat(2, 'pending'),
      feat(3, 'pending'),
      feat(4, 'pending'),
    ]

    const result = computeSchedulerActions(features, 3)

    expect(result.toPlan).toEqual([2, 3, 4])
    expect(result.toLaunch).toEqual([])
    expect(result.groupStatus).toBe('planning')
  })

  test('mixed states respect both caps independently', () => {
    const features: SchedulerFeature[] = [
      feat(0, 'planning'),
      feat(1, 'planning'),
      feat(2, 'pending'),
      feat(3, 'pending'),
      feat(4, 'running'),
      feat(5, 'planned'),
      feat(6, 'planned'),
    ]

    const result = computeSchedulerActions(features, 3)

    // planningInFlight=2 => pendingSlots=1 => picks first pending (2)
    // runningInFlight=1 => launchSlots=2 => picks first 2 planned (5, 6)
    expect(result.toPlan).toEqual([2])
    expect(result.toLaunch).toEqual([5, 6])
    expect(result.groupStatus).toBe('running')
  })

  test('cap value below 1 is treated as 1', () => {
    const features: SchedulerFeature[] = [
      feat(0, 'pending'),
      feat(1, 'pending'),
    ]

    const resultZero = computeSchedulerActions(features, 0)
    expect(resultZero.toPlan).toEqual([0])
    expect(resultZero.groupStatus).toBe('planning')

    const resultNeg = computeSchedulerActions(features, -5)
    expect(resultNeg.toPlan).toEqual([0])
    expect(resultNeg.groupStatus).toBe('planning')
  })

  test('group status is planning when only pending and planning stages exist', () => {
    const features: SchedulerFeature[] = [
      feat(0, 'planning'),
      feat(1, 'pending'),
      feat(2, 'pending'),
    ]

    const result = computeSchedulerActions(features, 3)

    // planningInFlight=1 => pendingSlots=2
    expect(result.toPlan).toEqual([1, 2])
    expect(result.toLaunch).toEqual([])
    expect(result.groupStatus).toBe('planning')
  })

  test('empty features array returns completed with empty arrays', () => {
    const result = computeSchedulerActions([], 3)

    expect(result.toPlan).toEqual([])
    expect(result.toLaunch).toEqual([])
    expect(result.groupStatus).toBe('completed')
  })

  test('does not schedule more than cap when inflight exceeds cap', () => {
    const features: SchedulerFeature[] = [
      feat(0, 'planning'),
      feat(1, 'planning'),
      feat(2, 'planning'),
      feat(3, 'planning'),
      feat(4, 'pending'),
    ]

    // planningInFlight=4 > cap=2 => pendingSlots=0
    const result = computeSchedulerActions(features, 2)

    expect(result.toPlan).toEqual([])
    expect(result.groupStatus).toBe('planning')
  })

  test('does not schedule launches when running inflight meets or exceeds cap', () => {
    const features: SchedulerFeature[] = [
      feat(0, 'running'),
      feat(1, 'running'),
      feat(2, 'planned'),
      feat(3, 'planned'),
    ]

    // runningInFlight=2, cap=2 => launchSlots=0
    const result = computeSchedulerActions(features, 2)

    expect(result.toLaunch).toEqual([])
    expect(result.groupStatus).toBe('running')
  })

  test('cancelled and failed features count as terminal for group status', () => {
    const features: SchedulerFeature[] = [
      feat(0, 'cancelled'),
      feat(1, 'failed'),
    ]

    const result = computeSchedulerActions(features, 3)

    expect(result.toPlan).toEqual([])
    expect(result.toLaunch).toEqual([])
    expect(result.groupStatus).toBe('completed')
  })

  test('single pending with single planned fills both slots under cap', () => {
    const features: SchedulerFeature[] = [
      feat(0, 'pending'),
      feat(1, 'planned'),
    ]

    const result = computeSchedulerActions(features, 3)

    expect(result.toPlan).toEqual([0])
    expect(result.toLaunch).toEqual([1])
    expect(result.groupStatus).toBe('running')
  })
})
