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

  /** Model to use for loop iterations. */
  model?: string
  /** Timeout in ms before considering a loop stalled. */
  stallTimeoutMs?: number
  /** Worktree loop completion logging configuration. */
  worktreeLogging?: WorktreeLoggingConfig
  /** Maximum consecutive stalls before loop is terminated. 0 = disabled (default: 5). */
  maxConsecutiveStalls?: number
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
 * Configuration for session compaction behavior.
 */
export interface CompactionConfig {
  /** Use a custom compaction prompt. */
  customPrompt?: boolean
  /** Maximum context tokens for compaction. */
  maxContextTokens?: number
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
  /** Auto-save captured plans to disk under <dataDir>/plans/<projectId>/. Default false. */
  autoSavePlans?: boolean
  /** TTL in ms for archived plans before pruning. 0 disables pruning. Default: 604800000 (7 days). */
  planArchiveTtlMs?: number
  /** Keyboard shortcut overrides for Forge commands. */
  keybinds?: {
    /** View plan dialog. Default: <leader>v */
    viewPlan?: string
    /** Execute plan dialog. Default: <leader>e */
    executePlan?: string
    /** Show loops dialog. Default: <leader>w */
    showLoops?: string
    /** Load archived plans dialog. Default: <leader>i */
    loadPlan?: string
  }
}

/**
 * Per-agent configuration overrides.
 */
export interface AgentOverrideConfig {
  /** Override default model temperature. */
  temperature?: number
}

/**
 * Configuration for plan decomposition into sections.
 */
export interface DecomposerConfig {
  /** Enable decomposition. Defaults to true. */
  enabled?: boolean
  /** Decomposition mode: 'agent' (LLM) or 'deterministic' (parser). Defaults to 'agent'. */
  mode?: 'agent' | 'deterministic'
  /** Model override for the decomposer agent. Ignored in deterministic mode. */
  model?: string
  /** Fallback when deterministic parse fails: 'legacy' (skip decomposition) or 'agent' (try agent mode). Defaults to 'legacy'. */
  onParseFailure?: 'legacy' | 'agent'
  /** Maximum number of sections. Defaults to 12. */
  maxSections?: number
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
  /** TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days. */
  completedLoopTtlMs?: number
  /** TUI display configuration. */
  tui?: TuiConfig
  /** Per-agent configuration overrides. */
  agents?: Record<string, AgentOverrideConfig>
  /** Sandbox execution configuration. */
  sandbox?: SandboxConfig
  /** Decomposer configuration for plan section decomposition. */
  decomposer?: DecomposerConfig
}
