import type { TeardownContext } from './forge-adapter'

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
