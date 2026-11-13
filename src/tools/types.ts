import type { Database } from 'bun:sqlite'
import type { PluginConfig, Logger } from '../types'
import type { createLoopEventHandler } from '../hooks'
import type { createSandboxManager } from '../sandbox/manager'
import type { PlansRepo } from '../storage/repos/plans-repo'
import type { ReviewFindingsRepo } from '../storage/repos/review-findings-repo'
import type { LoopsRepo } from '../storage/repos/loops-repo'
import type { SectionPlansRepo } from '../storage/repos/section-plans-repo'
import type { LoopSessionUsageRepo } from '../storage/repos/loop-session-usage-repo'
import type { Loop } from '../loop'
import type { ForgeClient } from '../client/port'

export interface ToolContext {
  projectId: string
  directory: string
  config: PluginConfig
  logger: Logger
  db: Database
  dataDir: string
  loopHandler: ReturnType<typeof createLoopEventHandler>
  loop: Loop
  client: ForgeClient
  cleanup: () => Promise<void>
  sandboxManager: ReturnType<typeof createSandboxManager> | null
  plansRepo: PlansRepo
  reviewFindingsRepo: ReviewFindingsRepo
  loopsRepo: LoopsRepo
  sectionPlansRepo: SectionPlansRepo
  loopSessionUsageRepo?: LoopSessionUsageRepo
  pendingTeardowns: import('../workspace/pending-teardown').PendingTeardownRegistry
  resolveActiveLoopForSession: (sessionID: string) => Promise<import('../services/session-loop-resolver').ResolvedLoop | null>
}
