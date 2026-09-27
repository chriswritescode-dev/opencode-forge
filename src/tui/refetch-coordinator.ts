/** A refresh trigger that coalesces overlapping fetches into one follow-up. */
export interface RefetchCoordinator {
  /** Request a fetch, running exactly one follow-up when one is already in flight. */
  trigger(): void
  dispose(): void
}

/**
 * Wraps an async refresh so any trigger raised while a fetch is in flight schedules
 * exactly one follow-up fetch after it settles. Overlapping triggers never run
 * concurrent fetches, and the newest trigger is never lost. A rejected fetch is
 * swallowed because a refresh reflects its own failure in the state it reads.
 */
export function createRefetchCoordinator(fetch: () => Promise<void>): RefetchCoordinator {
  let running = false
  let pending = false
  let disposed = false

  const run = async (): Promise<void> => {
    running = true
    try {
      await fetch()
    } catch {
    } finally {
      running = false
      if (pending && !disposed) {
        pending = false
        void run()
      }
    }
  }

  return {
    trigger() {
      if (disposed) return
      if (running) {
        pending = true
        return
      }
      void run()
    },
    dispose() {
      disposed = true
    },
  }
}
