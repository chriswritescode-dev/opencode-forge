export type MemoryScope = 'convention' | 'decision' | 'context'

export interface Memory {
  id: number
  projectId: string
  scope: MemoryScope
  content: string
  filePath: string | null
  accessCount: number
  lastAccessedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface CreateMemoryInput {
  projectId: string
  scope: MemoryScope
  content: string
  filePath?: string
}

export interface UpdateMemoryInput {
  content?: string
  scope?: MemoryScope
}

export interface MemorySearchResult {
  memory: Memory
  distance: number
}

export interface MemoryStats {
  projectId: string
  total: number
  byScope: Record<MemoryScope, number>
}



export interface LoggingConfig {
  enabled: boolean
  file: string
  debug?: boolean
}

export interface Logger {
  log: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
  debug: (message: string, ...args: unknown[]) => void
}

export interface LoopConfig {
  enabled?: boolean
  defaultMaxIterations?: number
  cleanupWorktree?: boolean
  defaultAudit?: boolean
  model?: string
  stallTimeoutMs?: number
  minAudits?: number
}

export interface SandboxConfig {
  mode: 'off' | 'docker'
  image?: string
}

export interface ListMemoriesFilter {
  scope?: MemoryScope
  limit?: number
  offset?: number
}

export interface CompactionConfig {
  customPrompt?: boolean
  maxContextTokens?: number
}

export interface MemoryInjectionConfig {
  enabled?: boolean
  maxResults?: number
  distanceThreshold?: number
  maxTokens?: number
  /** @deprecated Use defaultKvTtlMs in root config instead */
  cacheTtlMs?: number
  debug?: boolean
}

export interface MessagesTransformConfig {
  enabled?: boolean
  debug?: boolean
}

export interface TuiConfig {
  sidebar?: boolean
  showLoops?: boolean
  showVersion?: boolean
}

export interface AgentOverrideConfig {
  temperature?: number
}

export interface GraphConfig {
  enabled?: boolean
  autoScan?: boolean
  maxFiles?: number
  watch?: boolean
  debounceMs?: number
}

export interface PluginConfig {
  dataDir?: string
  logging?: LoggingConfig
  compaction?: CompactionConfig
  messagesTransform?: MessagesTransformConfig
  executionModel?: string
  auditorModel?: string
  loop?: LoopConfig
  /** @deprecated Use `loop` instead */
  ralph?: LoopConfig
  defaultKvTtlMs?: number
  tui?: TuiConfig
  agents?: Record<string, AgentOverrideConfig>
  sandbox?: SandboxConfig
  graph?: GraphConfig
}



export type ExportFormat = 'json' | 'markdown'

export interface ExportOptions {
  format?: ExportFormat
  output?: string
  projectId?: string
  scope?: MemoryScope
  limit?: number
  offset?: number
  dbPath?: string
}

export interface ImportOptions {
  format?: ExportFormat
  projectId: string
  force?: boolean
  dbPath?: string
}
