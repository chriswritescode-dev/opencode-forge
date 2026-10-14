import { describe, test, expect } from 'vitest'
import { formatExecutePlanToast } from '../../src/tui/execute-plan-panel'

describe('formatExecutePlanToast', () => {
  test('names the goal for a first chunk launch', () => {
    expect(formatExecutePlanToast({ loopName: 'chunk-1-loop', goalId: 'goal-1' }))
      .toBe('Goal goal-1: chunk 1 started')
  })

  test('names the loop for a launch that is not a goal', () => {
    expect(formatExecutePlanToast({ loopName: 'loop-a' })).toBe('Loop started: loop-a')
  })

  test('falls back when the result carries no loop', () => {
    expect(formatExecutePlanToast({})).toBe('Plan execution started')
  })
})
