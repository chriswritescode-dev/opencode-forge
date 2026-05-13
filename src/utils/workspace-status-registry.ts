import type { Logger } from '../types'

export type WorkspaceStatus = 'connected' | 'connecting' | 'disconnected' | 'error'

interface AwaitConnectedResult {
  connected: boolean
  elapsedMs: number
  source: 'cached' | 'event' | 'timeout'
  lastStatus?: WorkspaceStatus
  reason?: string
}

type WaiterResolver = (result: AwaitConnectedResult) => void

export interface WorkspaceStatusRegistry {
  recordEvent(event: { type: string; properties?: Record<string, unknown> }): void
  getStatus(workspaceId: string): WorkspaceStatus | undefined
  awaitConnected(workspaceId: string, options?: { timeoutMs?: number; logger?: Logger }): Promise<AwaitConnectedResult>
  primeFromSnapshot(snapshot: Array<{ workspaceID: string; status: string }>): void
}

const VALID_STATUSES = new Set<string>(['connected', 'connecting', 'disconnected', 'error'])
const VALID_EVENT_TYPES = new Set<string>(['workspace.status', 'workspace.ready'])

export function createWorkspaceStatusRegistry(deps?: { logger?: Logger }): WorkspaceStatusRegistry {
  const statusCache = new Map<string, WorkspaceStatus>()
  const waiters = new Map<string, Set<WaiterResolver>>()

  function flushWaiters(workspaceId: string, status: WorkspaceStatus): void {
    const waiterSet = waiters.get(workspaceId)
    if (!waiterSet) return
    if (status !== 'connected') return
    for (const resolver of waiterSet) {
      resolver({ connected: true, elapsedMs: 0, source: 'event' })
    }
    waiters.delete(workspaceId)
  }

  function recordEvent(event: { type: string; properties?: Record<string, unknown> }): void {
    try {
      const eventType = event.type
      if (!VALID_EVENT_TYPES.has(eventType)) return

      const props = event.properties as Record<string, unknown> | undefined
      const workspaceId = props?.workspaceID as string | undefined
      const rawStatus = props?.status as string | undefined

      if (!workspaceId || !rawStatus || !VALID_STATUSES.has(rawStatus)) return

      const status = rawStatus as WorkspaceStatus
      statusCache.set(workspaceId, status)

      deps?.logger?.debug(`[workspace-status-registry] ${workspaceId} -> ${status}`)
      flushWaiters(workspaceId, status)
    } catch {
      // Never throw from event handling
    }
  }

  function getStatus(workspaceId: string): WorkspaceStatus | undefined {
    return statusCache.get(workspaceId)
  }

  function awaitConnected(
    workspaceId: string,
    options?: { timeoutMs?: number; logger?: Logger },
  ): Promise<AwaitConnectedResult> {
    const cached = statusCache.get(workspaceId)
    if (cached === 'connected') {
      return Promise.resolve({ connected: true, elapsedMs: 0, source: 'cached' })
    }

    const timeoutMs = options?.timeoutMs ?? 5000
    const start = Date.now()

    return new Promise<AwaitConnectedResult>((resolve) => {
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const lastStatus = statusCache.get(workspaceId)
        const elapsedMs = Date.now() - start
        resolve({
          connected: false,
          source: 'timeout',
          reason: 'timeout',
          lastStatus,
          elapsedMs,
        })
      }, timeoutMs)

      const resolver: WaiterResolver = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      const resolverSet = waiters.get(workspaceId) ?? new Set()
      resolverSet.add(resolver)
      waiters.set(workspaceId, resolverSet)
    })
  }

  function primeFromSnapshot(snapshot: Array<{ workspaceID: string; status: string }>): void {
    try {
      for (const entry of snapshot) {
        if (!entry.workspaceID || !VALID_STATUSES.has(entry.status)) continue
        const status = entry.status as WorkspaceStatus
        statusCache.set(entry.workspaceID, status)
        flushWaiters(entry.workspaceID, status)
      }
    } catch {
      // Never throw from snapshot priming
    }
  }

  return { recordEvent, getStatus, awaitConnected, primeFromSnapshot }
}
