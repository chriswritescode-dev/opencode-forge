import { describe, test, expect, vi } from 'vitest'
import { withBusyGuard } from '../../src/utils/busy-guard'

function createSignalLike(initial = false) {
  let v = initial
  return {
    get: () => v,
    set: (next: boolean) => { v = next },
  }
}

describe('withBusyGuard (used by ExecutePlanPanel handleExecuteMode)', () => {
  test('concurrent invocations: only one work fn runs; subsequent calls trigger onBusy and skip', async () => {
    const signal = createSignalLike()
    const onBusy = vi.fn()
    const work = vi.fn().mockImplementation(
      () => new Promise<void>(resolve => setTimeout(resolve, 30)),
    )
    const guarded = withBusyGuard(work, {
      isBusy: signal.get,
      setBusy: signal.set,
      onBusy,
    })

    await Promise.all([guarded(), guarded(), guarded()])

    expect(work).toHaveBeenCalledTimes(1)
    expect(onBusy).toHaveBeenCalledTimes(2)
    expect(signal.get()).toBe(false)
  })

  test('after first call completes, subsequent calls run normally', async () => {
    const signal = createSignalLike()
    const onBusy = vi.fn()
    const work = vi.fn().mockResolvedValue(undefined)
    const guarded = withBusyGuard(work, {
      isBusy: signal.get,
      setBusy: signal.set,
      onBusy,
    })

    await guarded()
    await guarded()
    await guarded()

    expect(work).toHaveBeenCalledTimes(3)
    expect(onBusy).not.toHaveBeenCalled()
  })

  test('work fn throwing still resets busy flag', async () => {
    const signal = createSignalLike()
    const work = vi.fn().mockRejectedValue(new Error('boom'))
    const guarded = withBusyGuard(work, {
      isBusy: signal.get,
      setBusy: signal.set,
    })

    await expect(guarded()).rejects.toThrow('boom')
    expect(signal.get()).toBe(false)

    // After a throw, a new call should still execute (busy must have been cleared)
    work.mockResolvedValueOnce(undefined)
    await guarded()
    expect(work).toHaveBeenCalledTimes(2)
  })

  test('forwards arguments to the wrapped function', async () => {
    const signal = createSignalLike()
    const work = vi.fn().mockResolvedValue(undefined)
    const guarded = withBusyGuard(work, {
      isBusy: signal.get,
      setBusy: signal.set,
    })

    await guarded('Execute here', 'prov/exec', 'prov/aud', 'thinking-max', 'reasoning-high')

    expect(work).toHaveBeenCalledWith('Execute here', 'prov/exec', 'prov/aud', 'thinking-max', 'reasoning-high')
  })
})
