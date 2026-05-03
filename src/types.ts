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
 * Configuration for ast-grep native tools (powered by @ast-grep/napi).
 */
export interface AstGrepConfig {
  /** Enable ast-grep plugin tools. Defaults to true. */
  enabled?: boolean
  /** Subset of ast-grep tool names to expose. Defaults to all tools. */
  allowedTools?: string[]
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
  /** Keyboard shortcut overrides for Forge commands. */
  keybinds?: {
    /** View plan dialog. Default: Meta+Shift+P */
    viewPlan?: string
    /** Execute plan dialog. Default: Meta+Shift+E */
    executePlan?: string
    /** Show loops dialog. Default: Meta+Shift+L */
    showLoops?: string
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
  /** TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days. */
  completedLoopTtlMs?: number
  /** TUI display configuration. */
  tui?: TuiConfig
  /** Per-agent configuration overrides. */
  agents?: Record<string, AgentOverrideConfig>
  /** Sandbox execution configuration. */
  sandbox?: SandboxConfig
  /** ast-grep native tool configuration. */
  astGrep?: AstGrepConfig
}
