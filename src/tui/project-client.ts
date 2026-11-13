import type { ForgeExecutionMode, ForgeLoopDefaults, ForgeLoopRestartInput } from '../host/forge-rpc'
import type { LoopSandboxSettings } from '../types'
import type { ExecutionPreferences } from '../utils/tui-execution-preferences'
import type { LoopInfo, ProviderInfo, SessionForRecents, WorkspaceForRecents } from '../utils/tui-models'

export interface ExecutionContext {
  preferences: ExecutionPreferences | null
  models: {
    providers: ProviderInfo[]
    connectedProviderIds?: string[]
    configuredProviderIds?: string[]
    error?: string
  }
  sessions: SessionForRecents[]
  workspaces: WorkspaceForRecents[]
  openCodeFavorites: string[]
  openCodeDefault: string | undefined
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
  maxIterations?: number
  sandbox?: LoopSandboxSettings
}

export interface ForgeProjectClient {
  readonly projectId: string

  plan: {
    execute(
      sessionId: string,
      req: ExecutePlanRequest,
    ): Promise<{ sessionId?: string; loopName?: string; worktreeDir?: string; workspaceId?: string } | { error: string } | null>
  }

  selectSession(sessionId: string): Promise<void>

  loadLatestPlan(sessionId: string): Promise<string | null>

  loadLoops(): Promise<{ loops: LoopInfo[] } | { error: string }>

  loadExecutionContext(): Promise<ExecutionContext>

  restartLoop(request: ForgeLoopRestartInput): Promise<{ sessionId: string }>
}
