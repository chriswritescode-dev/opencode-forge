import { describe, expect, test, vi } from 'vitest'
import { createRefetchCoordinator } from '../../src/tui/refetch-coordinator'

describe('createRefetchCoordinator', () => {
  test('fetches once at startup', async () => {
    const fetch = vi.fn(async () => {})
    const coordinator = createRefetchCoordinator(fetch)

    coordinator.trigger()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    coordinator.dispose()
  })

  test('coalesces overlapping triggers into exactly one follow-up fetch', async () => {
    const gates: Array<() => void> = []
    let inFlight = 0
    let maxInFlight = 0
    let calls = 0
    const coordinator = createRefetchCoordinator(async () => {
      calls++
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise<void>((resolve) => gates.push(resolve))
      inFlight--
    })

    coordinator.trigger()
    await vi.waitFor(() => expect(calls).toBe(1))
    coordinator.trigger()
    coordinator.trigger()
    coordinator.trigger()
    gates.shift()?.()
    await vi.waitFor(() => expect(calls).toBe(2))
    gates.shift()?.()
    await vi.waitFor(() => expect(inFlight).toBe(0))

    expect(calls).toBe(2)
    expect(maxInFlight).toBe(1)
    coordinator.dispose()
  })

  test('runs a fresh fetch for a trigger after the previous fetch settled', async () => {
    const fetch = vi.fn(async () => {})
    const coordinator = createRefetchCoordinator(fetch)

    coordinator.trigger()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    coordinator.trigger()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    coordinator.dispose()
  })

  test('keeps coalescing after a rejected fetch', async () => {
    let calls = 0
    const coordinator = createRefetchCoordinator(async () => {
      calls++
      if (calls === 1) throw new Error('transient')
    })

    coordinator.trigger()
    await vi.waitFor(() => expect(calls).toBe(1))
    coordinator.trigger()
    await vi.waitFor(() => expect(calls).toBe(2))
    coordinator.dispose()
  })

  test('ignores a trigger after dispose', async () => {
    const fetch = vi.fn(async () => {})
    const coordinator = createRefetchCoordinator(fetch)

    coordinator.trigger()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    coordinator.dispose()
    coordinator.trigger()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
