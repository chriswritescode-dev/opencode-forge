import { describe, test, expect } from 'vitest'
import { formatExecutePlanToast } from '../../src/tui/execute-plan-panel'

describe('formatExecutePlanToast', () => {
  test('names the loop for a launch', () => {
    expect(formatExecutePlanToast({ loopName: 'loop-a' })).toBe('Loop started: loop-a')
  })

  test('falls back when the result carries no loop', () => {
    expect(formatExecutePlanToast({})).toBe('Plan execution started')
  })
})
