/**
 * Inter-plugin bridge that lets the TUI plugin dispatch audited new-session
 * executions through the same {@link createForgeExecutionService} flow used by
 * the execute-plan tool and the plan-approval hook.
 *
 * The server plugin (src/index.ts) owns the {@link ForgeLoopExtra} runtime and
 * the persistent loop state; the TUI plugin (src/tui.tsx) only owns presentation
 * and SDK calls. They are bundled as separate opencode plugins and do not
 * import each other's runtime state directly. When loaded in the same opencode
 * process, however, they share `globalThis`, so the server plugin publishes its
 * execution dispatch into the global registry defined here and the TUI plugin
 * retrieves it by directory — keeping the audited handler as the single source
 * of truth for `plan.execute.newSession` and avoiding duplicated goal-loop
 * persistence/runtime logic on the TUI side.
 *
 * Cross-process deployments (TUI attached to a separate `opencode serve`
 * process) do not share `globalThis`, so no bridge is registered in the TUI's
 * realm. In that case the TUI does not error: it falls back to driving the
 * server-side `execute-plan` tool over the standard `session.promptAsync` RPC
 * (see `src/utils/tui-client.ts`), which dispatches `plan.execute.newSession`
 * inside the server plugin — the same `handlePlanNewSession` implementation.
 *
 * The bridge is intentionally narrow: it only exposes the `new-session` path
 * (the audited goal-loop flow). All other execution modes (execute-here, loop)
 * keep their existing TUI-side implementations.
 */

import type {
  ForgeExecutionRequestContext,
  ExecutePlanNewSessionCommand,
  ForgeExecutionResponse,
  PlanExecutionStartedResult,
} from './execution'

/** Input handed to the bridge by the TUI side. */
export interface ForgeNewSessionBridgeInput {
  directory: string
  sourceSessionId?: string
  title?: string
  loopName?: string
  planText: string
  executionModel?: string
  auditorModel?: string
  executionVariant?: string
  auditorVariant?: string
  lifecycle?: ExecutePlanNewSessionCommand['lifecycle']
  /**
   * Per-launch correlation nonce the co-located bridge forwards into
   * {@link ForgeExecutionRequestContext.requestId} so `handlePlanNewSession`
   * records an authoritative `loop_new_session_outcomes` row keyed by it.
   * Minted by the TUI caller for every new-session launch; the cross-process
   * path threads the same nonce through the `execute-plan` tool arg.
   */
  requestNonce?: string
}

/** Result envelope returned by the bridge. */
export type ForgeNewSessionBridgeResult =
  | {
      ok: true
      sessionId: string
      title: string
      loopName?: string
      maxIterations?: number
      modelUsed: string | null
    }
  | { ok: false; errorCode: string; message: string }

/**
 * Dispatch entry registered by the server plugin. Wraps `service.dispatch` for
 * the `plan.execute.newSession` command against the server-side execution
 * context that already has all {@link ForgeExecutionServiceDeps} wired.
 */
export type ForgeNewSessionBridge = (input: ForgeNewSessionBridgeInput) => Promise<ForgeNewSessionBridgeResult>

interface ForgeExecutionBridgeRegistry {
  readonly bridges: Map<string, ForgeNewSessionBridge>
}

const REGISTRY_KEY = '__forgeExecutionBridges'

function getRegistry(): ForgeExecutionBridgeRegistry {
  const existing = (globalThis as unknown as Record<string, unknown>)[REGISTRY_KEY] as
    | ForgeExecutionBridgeRegistry
    | undefined
  if (existing) return existing
  const created: ForgeExecutionBridgeRegistry = { bridges: new Map() }
  ;(globalThis as unknown as Record<string, unknown>)[REGISTRY_KEY] = created
  return created
}

/** Stable registry key. Uses the absolute directory path resolved by the caller; trailing slashes are normalised so bare-directory vs trailing-slash lookups hit the same entry. */
function forgeBridgeKey(directory: string): string {
  return directory.replace(/\/+$/, '')
}

/** Register a bridge for the given directory. Overwrites any prior bridge for that key. */
export function registerForgeExecutionBridge(directory: string, bridge: ForgeNewSessionBridge): void {
  getRegistry().bridges.set(forgeBridgeKey(directory), bridge)
}

/**
 * Unregister the bridge for the given directory.
 *
 * When `bridge` is supplied, the entry is removed only if it is referentially
 * identical to the currently-registered bridge. This guards against a stale
 * plugin (reloaded or overlapping initialization) clobbering a newer plugin's
 * bridge: an old cleanup handler must not uninstall its replacement.
 *
 * Returns true when a bridge was removed.
 */
export function unregisterForgeExecutionBridge(directory: string, bridge?: ForgeNewSessionBridge): boolean {
  const key = forgeBridgeKey(directory)
  if (bridge) {
    const existing = getRegistry().bridges.get(key)
    if (existing !== bridge) return false
  }
  return getRegistry().bridges.delete(key)
}

/** Look up the bridge registered for the given directory (best-effort path match). */
export function getForgeExecutionBridge(directory: string): ForgeNewSessionBridge | undefined {
  return getRegistry().bridges.get(forgeBridgeKey(directory))
}

/** Clear every registered bridge. Intended for test isolation only. */
export function clearForgeExecutionBridges(): void {
  getRegistry().bridges.clear()
}

/**
 * Build a bridge backed by a `ForgeExecutionService` dispatch. Used by the
 * server plugin (and integration tests) — the service closure captures all
 * server-side deps already wired by the plugin entrypoint.
 */
export function forgeBridgeFromDispatch(
  makeContext: (input: ForgeNewSessionBridgeInput) => ForgeExecutionRequestContext,
  dispatch: (
    ctx: ForgeExecutionRequestContext,
    command: ExecutePlanNewSessionCommand,
  ) => Promise<ForgeExecutionResponse<PlanExecutionStartedResult>>,
): ForgeNewSessionBridge {
  return async (input) => {
    const ctx = makeContext(input)
    if (input.requestNonce) {
      ctx.requestId = input.requestNonce
    }
    const result = await dispatch(ctx, {
      type: 'plan.execute.newSession',
      source: { kind: 'inline', planText: input.planText },
      title: input.title,
      loopName: input.loopName,
      executionModel: input.executionModel,
      auditorModel: input.auditorModel,
      executionVariant: input.executionVariant,
      auditorVariant: input.auditorVariant,
      lifecycle: input.lifecycle,
    })
    if (!result.ok) {
      return { ok: false, errorCode: result.error.code, message: result.error.message }
    }
    return {
      ok: true,
      sessionId: result.data.sessionId,
      title: result.data.title,
      loopName: result.data.loopName,
      maxIterations: result.data.maxIterations,
      modelUsed: result.data.modelUsed,
    }
  }
}
