import type { Database } from 'bun:sqlite'
import type { PluginConfig, Logger } from '../types'
import type { createLoopService } from '../services/loop'
import type { createLoopEventHandler } from '../hooks'
import type { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2'
import type { PluginInput } from '@opencode-ai/plugin'
import type { createSandboxManager } from '../sandbox/manager'
import type { GraphService } from '../graph/service'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../storage/repos/review-findings-repo'
import type { GraphStatusRepo } from '../storage/repos/graph-status-repo'
import type { LoopsRepo } from '../storage/repos/loops-repo'

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
  /** Loop service for managing autonomous loops. */
  loopService: ReturnType<typeof createLoopService>
  /** Loop event handler for triggering loop lifecycle events. */
  loopHandler: ReturnType<typeof createLoopEventHandler>
  /** OpenCode v2 API client. */
  v2: ReturnType<typeof createV2Client>
  /** Cleanup function to call on plugin shutdown. */
  cleanup: () => Promise<void>
  /** Original plugin input from OpenCode. */
  input: PluginInput
  /** Sandbox manager instance, null if sandboxing is disabled. */
  sandboxManager: ReturnType<typeof createSandboxManager> | null
  /** Graph service instance, null if graph is disabled. */
  graphService: GraphService | null
  /** Plans repo for plan storage. */
  plansRepo: PlansRepo
  /** Review findings repo for review findings storage. */
  reviewFindingsRepo: ReviewFindingsRepo
  /** Graph status repo for graph status storage. */
  graphStatusRepo: GraphStatusRepo
  /** Loops repo for loop storage. */
  loopsRepo: LoopsRepo
}


