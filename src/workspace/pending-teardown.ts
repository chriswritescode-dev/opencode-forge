import type { TeardownContext } from './forge-adapter'

/**
 * Registry of pending workspace teardowns keyed by loop name.
 *
 * Set by callers of `client.workspace.remove` (loop termination side
 * effects, etc.) so the forge workspace adapter can produce informative commit
 * messages (iteration count, termination reason) while still being the single
 * source of truth for teardown behavior.
 *
 * Entries are short-lived: set before calling `workspace.remove`, cleared in
 * a `finally` block immediately after.
 */
export interface PendingTeardownRegistry {
  set(loopName: string, ctx: TeardownContext): void
  get(loopName: string): TeardownContext | undefined
  clear(loopName: string): void
}

export function createPendingTeardownRegistry(): PendingTeardownRegistry {
  const map = new Map<string, TeardownContext>()
  return {
    set(loopName, ctx) {
      map.set(loopName, ctx)
    },
    get(loopName) {
      return map.get(loopName)
    },
    clear(loopName) {
      map.delete(loopName)
    },
  }
}
