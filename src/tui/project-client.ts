import type { ForgeExecutionMode } from '../host/forge-rpc'
import type { ExecutionPreferences } from '../utils/tui-execution-preferences'
import type { SessionForRecents, WorkspaceForRecents } from '../utils/tui-models'

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

  /** Read preferences and list models. */
  loadExecutionContext(): Promise<ExecutionContext>

  restartLoop(request: { loopName: string; auditorModel: string; auditorVariant: string; executionModel?: string; executionVariant?: string }): Promise<{ sessionId: string }>
}
