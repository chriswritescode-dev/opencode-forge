import type { ForgeExecutionMode, ForgeLoopDefaults, ForgeLoopRestartInput } from '../host/forge-rpc'
import type { LoopSandboxSettings } from '../types'
import type { ExecutionPreferences } from '../utils/tui-execution-preferences'
import type { LoopInfo, SessionForRecents, WorkspaceForRecents } from '../utils/tui-models'

export interface ExecutionContext {
  preferences: ExecutionPreferences | null
  models: {
    providers: unknown[]
    connectedProviderIds?: string[]
    configuredProviderIds?: string[]
    error?: string
  }
  /** Sessions for the current project, supplied to `deriveRecentModels`. */
  sessions: SessionForRecents[]
  /**
   * Forge loops for the current project in workspace shape, supplied to both
   * `deriveExecutionPreferencesFromWorkspaces` and (as the auditor-model layer)
   * `deriveRecentModels`.
   */
  workspaces: WorkspaceForRecents[]
  /** OpenCode favorite model fullnames. */
  openCodeFavorites: string[]
  /** The user's default model, surfaced last in the layered recents list. */
  openCodeDefault: string | undefined
  /** Server-side loop-setting defaults; absent when the server could not report them. */
  loopDefaults?: ForgeLoopDefaults
}

export interface ExecutePlanRequest {
  mode: ForgeExecutionMode
  title: string
  loopName?: string
  plan: string
  executionModel?: string
  auditorModel?: string
  executionVariant?: string
  auditorVariant?: string
  targetSessionId?: string
  /** Loop mode only: overrides the server's `loop.defaultMaxIterations`. */
  maxIterations?: number
  /** Loop mode only: per-loop sandbox overrides. */
  sandbox?: LoopSandboxSettings
}

export interface ForgeProjectClient {
  readonly projectId: string

  plan: {
    /**
     * Forwards the user's chosen mode, models, and plan to the server. For loop
     * mode the model selection is persisted with the loop, which is the source
     * of truth for "last used preferences" and "recent models".
     */
    execute(
      sessionId: string,
      req: ExecutePlanRequest,
    ): Promise<{ sessionId?: string; loopName?: string; worktreeDir?: string; workspaceId?: string } | { error: string } | null>
  }

  /** Navigate the TUI to a session. */
  selectSession(sessionId: string): Promise<void>

  /** Read the latest stored plan for a session, or `null` when none is found. */
  loadLatestPlan(sessionId: string): Promise<string | null>

  /** List loops for the current project through the Forge server RPC. */
  loadLoops(): Promise<{ loops: LoopInfo[] } | { error: string }>

  /** Read preferences and list models. */
  loadExecutionContext(): Promise<ExecutionContext>

  restartLoop(request: ForgeLoopRestartInput): Promise<{ sessionId: string }>
}
