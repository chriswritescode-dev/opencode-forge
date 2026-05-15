import type { Database } from 'bun:sqlite'
import type { PluginConfig, Logger } from '../types'
import type { createLoopEventHandler } from '../hooks'
import type { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2'
import type { PluginInput } from '@opencode-ai/plugin'
import type { createSandboxManager } from '../sandbox/manager'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../storage/repos/review-findings-repo'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { SectionPlansRepo } from '../storage/repos/section-plans-repo'
import type { Loop } from '../loop'

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
  /** OpenCode v2 API client. */
  v2: ReturnType<typeof createV2Client>
  /** Cleanup function to call on plugin shutdown. */
  cleanup: () => Promise<void>
  /** Original plugin input from OpenCode. */
  input: PluginInput
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
  /** Workspace status registry for tracking workspace readiness. */
  workspaceStatusRegistry: import('../utils/workspace-status-registry').WorkspaceStatusRegistry
}

