import type { SessionStatusEntry } from '../client/port'
import type { ToolDefinition } from '../tools/tool'
import type { SandboxContext } from '../sandbox/context'
import type { SharedSessionSandboxController } from '../host/forge-core'
import type { ForgeTuiEventEmitter } from '../host/tui-events'
import type { IdleGateStore } from '../loop/idle-gate'
import type { InFlightEntry } from '../loop/in-flight-guard'
import type { LRUCache } from './lru-cache'

export interface ForgeSharedRegistries {
  'idle-gate.v2': IdleGateStore
  'prompt-in-flight.v2': Map<string, InFlightEntry>
  'loop-state-locks.v1': Map<string, Promise<unknown>>
  'loop-internal-fallback-aborts.v1': Map<string, number>
  'loop-pending-code-graph-snapshots.v1': Map<string, string>
  'session-sandbox-controllers.v1': Map<string, SharedSessionSandboxController>
  'tui-event-emitters.v1': Map<string, Set<ForgeTuiEventEmitter>>
  'v2-location-tools.v1': Map<string, Record<string, ToolDefinition>>
  'pending-shell-sandboxes.v1': Map<string, SandboxContext>
  'v2-session-status.v1': LRUCache<SessionStatusEntry>
  'loop-registry.v2': Map<string, Set<string>>
}

declare global {
  var __opencodeForgeShared: Partial<ForgeSharedRegistries> | undefined
}

export function processShared<K extends keyof ForgeSharedRegistries>(
  key: K,
  create: () => ForgeSharedRegistries[K],
): ForgeSharedRegistries[K] {
  const store = (globalThis.__opencodeForgeShared ??= {})
  const existing = store[key]
  if (existing !== undefined) return existing
  const created = create()
  store[key] = created
  return created
}

export function projectLoopKey(projectId: string, loopName: string): string {
  return `${projectId}\u0000${loopName}`
}
