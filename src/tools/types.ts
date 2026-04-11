import type { Database } from 'bun:sqlite'
import type { PluginConfig, Logger } from '../types'
import type { createKvService } from '../services/kv'
import type { createLoopService } from '../services/loop'
import type { createLoopEventHandler } from '../hooks'
import type { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2'
import type { PluginInput } from '@opencode-ai/plugin'
import type { createSandboxManager } from '../sandbox/manager'
import type { GraphService } from '../graph/service'

export interface ToolContext {
  projectId: string
  directory: string
  config: PluginConfig
  logger: Logger
  db: Database
  dataDir: string
  kvService: ReturnType<typeof createKvService>
  loopService: ReturnType<typeof createLoopService>
  loopHandler: ReturnType<typeof createLoopEventHandler>
  v2: ReturnType<typeof createV2Client>
  cleanup: () => Promise<void>
  input: PluginInput
  sandboxManager: ReturnType<typeof createSandboxManager> | null
  graphService: GraphService | null
}


