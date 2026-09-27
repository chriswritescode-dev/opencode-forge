import { createSignal, type Accessor } from 'solid-js'
import type { ForgeLoopSidebarOutput } from '../host/forge-rpc'
import type { LoopSidebarRow } from '../storage/repos/loops-repo'
import { createRefetchCoordinator } from './refetch-coordinator'

export interface LoopSidebarStoreDeps {
  readLoops(): Promise<ForgeLoopSidebarOutput>
}

export interface LoopSidebarStore {
  /** Most recent loops for the sidebar. */
  loops: Accessor<LoopSidebarRow[]>
  /** Re-read the loop rows; coalesced with any in-flight read. */
  refresh(): void
  dispose(): void
}

/**
 * The sidebar's loop rows, read once at startup and on every `loopsChanged` push.
 * The row signature suppresses a re-render when a refetch returns identical rows.
 */
export function createLoopSidebarStore(deps: LoopSidebarStoreDeps): LoopSidebarStore {
  const [loops, setLoops] = createSignal<LoopSidebarRow[]>([])
  let signature = ''
  const coordinator = createRefetchCoordinator(async () => {
    const result = await deps.readLoops()
    if ('error' in result) return
    const next = result.loops
    const nextSignature = JSON.stringify(next)
    if (nextSignature === signature) return
    signature = nextSignature
    setLoops(next)
  })
  coordinator.trigger()
  return { loops, refresh: coordinator.trigger, dispose: coordinator.dispose }
}
