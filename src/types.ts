/**
 * Scope for memory entries used in RAG-style memory injection.
 */
export type MemoryScope = 'convention' | 'decision' | 'context'

/**
 * A memory entry stored for retrieval-augmented generation.
 */
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

/**
 * Input for creating a new memory entry.
 */
export interface CreateMemoryInput {
  projectId: string
  scope: MemoryScope
  content: string
  filePath?: string
}

/**
 * Input for updating an existing memory entry.
 */
export interface UpdateMemoryInput {
  content?: string
  scope?: MemoryScope
}

/**
 * A memory entry with its similarity distance from a query.
 */
export interface MemorySearchResult {
  memory: Memory
  distance: number
}

/**
 * Statistics about memory usage for a project.
 */
export interface MemoryStats {
  projectId: string
  total: number
  byScope: Record<MemoryScope, number>
}



/**
 * Configuration for plugin logging.
 */
export interface LoggingConfig {
  /** Enable file logging. */
  enabled: boolean
  /** Path to the log file. */
  file: string
  /** Enable verbose debug logging. */
  debug?: boolean
}

/**
 * Logger interface for plugin-wide logging.
 */
export interface Logger {
  log: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
  debug: (message: string, ...args: unknown[]) => void
}

/**
 * Configuration for worktree loop completion logging.
 */
export interface WorktreeLoggingConfig {
  /** Enable worktree loop completion logging. Defaults to false. */
  enabled?: boolean
  /** Directory to write completion logs. Defaults to platform data dir. */
  directory?: string
}

/**
 * Configuration for autonomous loop behavior.
 */
export interface LoopConfig {
  /** Enable autonomous loop execution. Defaults to true. */
  enabled?: boolean
  /** Default maximum iterations per loop. */
  defaultMaxIterations?: number
  /** Clean up worktrees when loops complete. */
  cleanupWorktree?: boolean
  /** Enable automatic code auditing after each iteration. */
  defaultAudit?: boolean
  /** Model to use for loop iterations. */
  model?: string
  /** Timeout in ms before considering a loop stalled. */
  stallTimeoutMs?: number
  /** Minimum number of audits before a loop can complete. */
  minAudits?: number
  /** Worktree loop completion logging configuration. */
  worktreeLogging?: WorktreeLoggingConfig
}

/**
 * Configuration for sandbox execution environment.
 */
export interface SandboxConfig {
  /** Sandbox mode - 'off' disables sandboxing, 'docker' enables it. */
  mode: 'off' | 'docker'
  /** Docker image to use for sandboxed execution. */
  image?: string
}

/**
 * Filter options for listing memories.
 */
export interface ListMemoriesFilter {
  scope?: MemoryScope
  limit?: number
  offset?: number
}

/**
 * Configuration for session compaction behavior.
 */
export interface CompactionConfig {
  /** Use a custom compaction prompt. */
  customPrompt?: boolean
  /** Maximum context tokens for compaction. */
  maxContextTokens?: number
}

/**
 * Configuration for memory injection into context.
 * @deprecated Use defaultKvTtlMs in root config instead
 */
export interface MemoryInjectionConfig {
  /** Enable memory injection. */
  enabled?: boolean
  /** Maximum number of memory results to inject. */
  maxResults?: number
  /** Maximum similarity distance threshold. */
  distanceThreshold?: number
  /** Maximum tokens to inject. */
  maxTokens?: number
  /** @deprecated Use defaultKvTtlMs in root config instead */
  cacheTtlMs?: number
  /** Enable debug logging for memory injection. */
  debug?: boolean
}

/**
 * Configuration for message transformation in architect sessions.
 */
export interface MessagesTransformConfig {
  /** Enable message transformation. Defaults to true. */
  enabled?: boolean
  /** Enable debug logging. */
  debug?: boolean
}

/**
 * Configuration for TUI display options.
 */
export interface TuiConfig {
  /** Show sidebar. */
  sidebar?: boolean
  /** Show active loops in TUI. */
  showLoops?: boolean
  /** Show version information. */
  showVersion?: boolean
}

/**
 * Per-agent configuration overrides.
 */
export interface AgentOverrideConfig {
  /** Override default model temperature. */
  temperature?: number
}

/**
 * Configuration for code graph indexing and queries.
 */
export interface GraphConfig {
  /** Enable graph indexing. Defaults to true. */
  enabled?: boolean
  /** Auto-check existing graph cache on startup and scan only when missing/stale. Defaults to true. */
  autoScan?: boolean
  /** Watch filesystem for changes. */
  watch?: boolean
  /** Debounce delay in ms for file change events. */
  debounceMs?: number
}

/**
 * Complete plugin configuration for opencode-forge.
 */
export interface PluginConfig {
  /** Custom data directory for plugin storage. Defaults to platform data dir. */
  dataDir?: string
  /** Logging configuration. */
  logging?: LoggingConfig
  /** Compaction behavior configuration. */
  compaction?: CompactionConfig
  /** Message transformation for architect agent. */
  messagesTransform?: MessagesTransformConfig
  /** Model to use for code execution. */
  executionModel?: string
  /** Model to use for code auditing. */
  auditorModel?: string
  /** Loop behavior configuration. */
  loop?: LoopConfig
  /** @deprecated Use `loop` instead */
  ralph?: LoopConfig
  /** Default TTL for KV entries in milliseconds. */
  defaultKvTtlMs?: number
  /** TUI display configuration. */
  tui?: TuiConfig
  /** Per-agent configuration overrides. */
  agents?: Record<string, AgentOverrideConfig>
  /** Sandbox execution configuration. */
  sandbox?: SandboxConfig
  /** Graph indexing configuration. */
  graph?: GraphConfig
}



/**
 * Export format for memories and data.
 */
export type ExportFormat = 'json' | 'markdown'

/**
 * Options for exporting memories or other data.
 */
export interface ExportOptions {
  /** Export format. Defaults to 'json'. */
  format?: ExportFormat
  /** Output file path. */
  output?: string
  /** Project ID to export from. */
  projectId?: string
  /** Filter by memory scope. */
  scope?: MemoryScope
  /** Maximum number of entries to export. */
  limit?: number
  /** Offset for pagination. */
  offset?: number
  /** Path to database file. */
  dbPath?: string
}

/**
 * Options for importing data.
 */
export interface ImportOptions {
  /** Import format. Defaults to 'json'. */
  format?: ExportFormat
  /** Target project ID. */
  projectId: string
  /** Overwrite existing entries. */
  force?: boolean
  /** Path to database file. */
  dbPath?: string
}
