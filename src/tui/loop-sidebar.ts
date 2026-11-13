import { createSignal, type Accessor } from 'solid-js'
import type { ForgeLoopSidebarOutput } from '../host/forge-rpc'
import type { LoopSidebarRow } from '../storage/repos/loops-repo'
import { createRefetchCoordinator } from './refetch-coordinator'

export interface LoopSidebarStoreDeps {
  readLoops(): Promise<ForgeLoopSidebarOutput>
}

export interface LoopSidebarStore {
  loops: Accessor<LoopSidebarRow[]>
  refresh(): void
  dispose(): void
}

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
