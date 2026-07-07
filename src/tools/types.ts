import type { Database } from 'bun:sqlite'
import type { PluginConfig, Logger } from '../types'
import type { createLoopEventHandler } from '../hooks'
import type { createSandboxManager } from '../sandbox/manager'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../storage/repos/review-findings-repo'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { SectionPlansRepo } from '../storage/repos/section-plans-repo'
import type { LoopSessionUsageRepo } from '../storage/repos/loop-session-usage-repo'
import type { FeatureGroupsRepo } from '../storage/repos/feature-groups-repo'
import type { GroupOrchestrator } from '../services/group-orchestrator'
import type { Loop } from '../loop'
import type { ForgeClient } from '../client/port'

/**
 * Context passed to all tool implementations providing access to plugin services.
 */
export interface ToolContext {
  /** The current project ID. */
  projectId: string
  /** The working directory of the project. */
  directory: string
  /** The plugin configuration. */
  config: PluginConfig
  /** Logger instance for the plugin. */
  logger: Logger
  /** Bun SQLite database instance. */
  db: Database
  /** Data directory path for plugin storage. */
  dataDir: string
  /** Loop event handler for triggering loop lifecycle events. */
  loopHandler: ReturnType<typeof createLoopEventHandler>
  /** Loop runtime interface for state management and lifecycle operations. */
  loop: Loop
  /** Forge client port wrapping the SDK v2 adapter. */
  client: ForgeClient
  /** Cleanup function to call on plugin shutdown. */
  cleanup: () => Promise<void>
  /** Sandbox manager instance, null if sandboxing is disabled. */
  sandboxManager: ReturnType<typeof createSandboxManager> | null
  /** Plans repo for plan storage. */
  plansRepo: PlansRepo
  /** Review findings repo for review findings storage. */
  reviewFindingsRepo: ReviewFindingsRepo
  /** Loops repo for loop storage. */
  loopsRepo: LoopsRepo
  /** Section plans repo for section-scoped plan storage. */
  sectionPlansRepo: SectionPlansRepo
  /** Loop session usage repo for usage tracking. */
  loopSessionUsageRepo?: LoopSessionUsageRepo
  /** Feature groups repo for group-launch feature tracking. */
  featureGroupsRepo: FeatureGroupsRepo
  /** Group orchestrator for managing feature groups. */
  groupOrchestrator: GroupOrchestrator
  /** Workspace status registry for tracking workspace readiness. */
  workspaceStatusRegistry: import('../utils/workspace-status-registry').WorkspaceStatusRegistry
  /** Pending teardown registry for workspace removal context. */
  pendingTeardowns: import('../workspace/pending-teardown').PendingTeardownRegistry
  /**
   * Resolves the active loop owning a session, following parent-session hops.
   * This is the single canonical loop-resolution utility shared by hooks and
   * tools so a finding written from any descendant session (e.g. an audit
   * subagent) is correctly scoped to its loop.
   */
  resolveActiveLoopForSession: (sessionID: string) => Promise<import('../services/session-loop-resolver').ResolvedLoop | null>
}
