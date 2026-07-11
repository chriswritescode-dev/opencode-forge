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

/** Post-completion action run inside the worktree before teardown (review, audit, doc-gen, etc.). */
export interface PostActionConfig {
  /** Enable the post-completion action phase. Defaults to false. */
  enabled?: boolean
  /** Name of a skill to load via the Skill tool at action time (e.g. "pr-review"). Must be installed host-side. */
  skill?: string
  /** Optional extra instruction text appended to the action prompt. Used standalone when no skill is set. */
  prompt?: string
  /** Override the model used for the post-action prompt (format: "provider/model"). Defaults to the auditor model chain. */
  model?: string
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
  /** Optional post-completion action (skill and/or prompt) run in-worktree before teardown. */
  postAction?: PostActionConfig
  /** Maximum consecutive stalls before loop is terminated. 0 = disabled (default: 5). */
  maxConsecutiveStalls?: number
  /**
   * Absolute directory paths that loop, audit, and post-action sessions may read despite
   * worktree isolation (e.g. an Obsidian vault). Each entry is granted via `external_directory`
   * allow rules layered over the default deny. Provide the path as the session sees it on the
   * host (governs host-side Read/Glob/Grep); for sandboxed loops, host-side tools still resolve
   * host paths, so use the host path here rather than a container mount path.
   */
  allowExternalDirectories?: string[]
  /**
   * Absolute path of a shared scratch/temp directory granted to loop sessions in BOTH modes.
   * It is added to the `external_directory` allowlist and, for sandboxed loops, bind-mounted
   * read-write at the identical container path so absolute temp paths match host↔container.
   * Defaults to `/tmp/oc-forge`. The directory is created on startup if missing.
   */
  tmpDir?: string
  /**
   * Inline opencode config object written as `opencode.jsonc` at the root of each freshly created
   * loop worktree, enabling per-loop opencode customization (primarily MCP servers). The
   * `{{FORGE_SANDBOX_CONTAINER}}` token is replaced in string values for sandboxed loops; MCP
   * entries containing it are omitted when no sandbox exists. Existing project configs are never
   * overwritten, and the generated file is excluded from loop commits. An empty object or
   * omission disables the behavior.
   */
  worktreeOpencodeConfig?: Record<string, unknown>
}

/**
 * Network access configuration for the sandbox container.
 * Controls host gateway access, environment passthrough, and project `.env` file mounting.
 */
export interface SandboxNetworkConfig {
  /** Enable host.docker.internal gateway. Defaults to true. Set false to disable. */
  hostGateway?: boolean
  /** Environment variable names to pass through from host process into the container. */
  env?: string[]
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
 * A single custom bind-mount for the sandbox container.
 */
export interface SandboxMountConfig {
  /** Absolute host directory (or file) path to bind-mount into the container. */
  host: string
  /** Absolute container path where the host path is mounted. */
  container: string
  /** Mount read-only. Defaults to true (read-only); set false for read-write access. */
  readonly?: boolean
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
  /** Mount the source project directory as a read-only volume. Defaults to true. */
  mountProjectReadonly?: boolean
  /** Container path for the read-only project mount. Defaults to '/project'. */
  projectMountPath?: string
  /** Additional host directories to bind-mount into the sandbox container. */
  mounts?: SandboxMountConfig[]
  /** Network access configuration (host gateway, env passthrough). */
  network?: SandboxNetworkConfig
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
 * Configuration for group launch behavior.
 */
export interface GroupLaunchConfig {
  /** Max loops from one group running concurrently. Also bounds concurrent planning passes. Default 3. */
  maxConcurrentLoops?: number
}

/** A remote opencode server that can host forge loops. */
export interface RemoteServerConfig {
  /** Unique display name used in the TUI target picker. */
  name: string
  /** Base URL of the remote opencode server, e.g. "http://192.168.1.20:4096". */
  url: string
  /** Basic-auth password (OPENCODE_SERVER_PASSWORD on the remote). Omit when the remote runs without auth. */
  password?: string
  /** Basic-auth username. Defaults to "opencode" (OPENCODE_SERVER_USERNAME default). */
  username?: string
  /** Git remote name (shared by both machines) used for code sync. Defaults to "origin". */
  gitRemote?: string
  /** Whether the remote loop should run sandboxed. Mirrors the remote's sandbox capability. Defaults to true. */
  sandbox?: boolean
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
  /** Default reasoning/thinking variant for the execution model. */
  executionVariant?: string
  /** Default reasoning/thinking variant for the auditor model. */
  auditorVariant?: string
  /** Loop behavior configuration. */
  loop?: LoopConfig
  /** Group launch configuration. */
  groupLaunch?: GroupLaunchConfig
  /** Remote opencode servers available as loop launch targets. */
  remotes?: RemoteServerConfig[]
  /** TTL for completed/cancelled/errored/stalled loops before sweep. Default 7 days. */
  completedLoopTtlMs?: number
  /** TUI display configuration. */
  tui?: TuiConfig
  /** Per-agent configuration overrides. */
  agents?: Record<string, AgentOverrideConfig>
  /** Sandbox execution configuration. */
  sandbox?: SandboxConfig
}
