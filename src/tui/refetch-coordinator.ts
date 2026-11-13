export interface RefetchCoordinator {
  trigger(): void
  dispose(): void
}

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
