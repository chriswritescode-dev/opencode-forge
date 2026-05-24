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
  /** Timeout in ms before considering a loop stalled. */
  stallTimeoutMs?: number
  /** Worktree loop completion logging configuration. */
  worktreeLogging?: WorktreeLoggingConfig
  /** Maximum consecutive stalls before loop is terminated. 0 = disabled (default: 5). */
  maxConsecutiveStalls?: number
}

/**
 * Resource limits for the sandbox container. Maps directly to `docker run` flags.
 * Docker Desktop's defaults (often 2GB / 2 CPUs) are too tight for many real projects
 * — `pnpm install` gets OOM-killed (exit 137) and shell commands run slowly.
 */
export interface SandboxResources {
  /** Memory limit, e.g. '8g', '4096m'. Maps to `--memory`. */
  memory?: string
  /** Memory+swap limit, e.g. '12g'. Maps to `--memory-swap`. */
  memorySwap?: string
  /** Number of CPUs, e.g. '4', '2.5'. Maps to `--cpus`. */
  cpus?: string
  /** Shared memory size, e.g. '512m'. Maps to `--shm-size`. */
  shmSize?: string
}

/**
 * Configuration for sandbox execution environment.
 */
export interface SandboxConfig {
  /** Sandbox mode. Currently only 'docker' is supported. Reserved for future modes. */
  mode: 'docker'
  /** Enable sandboxed execution. When false, loops run in worktree-only mode even if Docker is available. Default: true. */
  enabled?: boolean
  /** Docker image to use for sandboxed execution. */
  image?: string
  /** Container resource limits. Defaults to memory=8g, cpus=4, shmSize=1g. */
  resources?: SandboxResources
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
  /** Show version information. */
  showVersion?: boolean
  /** Keyboard shortcut overrides for Forge commands. */
  keybinds?: Record<string, string>
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
  /** TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days. */
  completedLoopTtlMs?: number
  /** TUI display configuration. */
  tui?: TuiConfig
  /** Per-agent configuration overrides. */
  agents?: Record<string, AgentOverrideConfig>
  /** Sandbox execution configuration. */
  sandbox?: SandboxConfig
}
