import type { WorkspaceStatusRegistry } from '../../src/utils/workspace-status-registry'

/**
 * Creates a workspace status registry where awaitConnected resolves
 * immediately. Avoids 5s timeouts when the execution service waits for
 * workspace connection events that mock clients never fire.
 */
export function createNoWaitWorkspaceStatusRegistry(): WorkspaceStatusRegistry {
  return {
    recordEvent: () => {},
    getStatus: () => 'connected' as const,
    awaitConnected: async () => ({ connected: true, elapsedMs: 0, source: 'cached' as const }),
    primeFromSnapshot: () => {},
  }
}
