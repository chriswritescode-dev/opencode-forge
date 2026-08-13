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

/** A single user-supplied loop permission rule: a bare tool name (shorthand for pattern `*`),
 *  or an explicit `{ permission, pattern }` object. */
export type LoopPermissionRuleConfig = string | { permission: string; pattern?: string }

/** User-configured permission rules layered over Forge's structural denies for loop, audit, and
 *  post-action sessions. Only `deny` entries are supported: an `allow` entry can never grant
 *  anything the blanket allow-all does not already grant, so it would be dead config. */
export interface LoopPermissionsConfig {
  /** Rules denied to the session, layered before Forge's structural denies (which always win). */
  deny?: LoopPermissionRuleConfig[]
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
  /** Time in ms a loop session may stay busy with no tool activity before the watchdog aborts the wedged message and sends a continue prompt. 0 = disabled (default: 900000). */
  busyStallTimeoutMs?: number
  /**
   * Absolute directory paths that loop, audit, and post-action sessions may read despite
   * worktree isolation (e.g. an Obsidian vault). Each entry is granted via `external_directory`
   * allow rules layered over the default deny, and is additionally bind-mounted read-only into
   * the sandbox so in-container `bash`/`glob`/`grep` resolve the same tree host `read` does.
   * Always an absolute host path: msb mounts every workspace at its identical host path, so the
   * same value is correct on both sides. Use `sandbox.mounts` for read-write container access.
   */
  allowExternalDirectories?: string[]
  /**
   * Inline opencode config object written as `opencode.jsonc` at the root of each freshly created
   * loop worktree, enabling per-loop opencode customization (primarily MCP servers). The
   * `{{FORGE_SANDBOX_CONTAINER}}` token is replaced in string values for sandboxed loops; MCP
   * entries containing it are omitted when no sandbox exists. Existing project configs are never
   * overwritten, and the generated file is excluded from loop commits. An empty object or
   * omission disables the behavior.
   */
  worktreeOpencodeConfig?: Record<string, unknown>
  /**
   * Extra `deny` rules layered over Forge's structural denies for loop, audit, and post-action
   * sessions. Entries are applied before Forge's structural denies, so a user rule for a permission
   * that Forge manages is rejected, as is a blanket (`*`) deny of a permission the loop requires;
   * scoped denies remain honored. Use `allowExternalDirectories` for `external_directory` grants,
   * which Forge manages for every session.
   */
  permissions?: LoopPermissionsConfig
}

/**
 * A host-held credential bound to a sandbox at create time. The real value stays on the host:
 * msb keeps a source reference to the environment variable, exposes a `$MSB_<env>` placeholder
 * inside the sandbox, and substitutes the real value only for the listed hosts at the network
 * boundary — the value never enters the guest.
 */
export interface SandboxSecretConfig {
  /** Host environment variable name that holds the secret value. */
  env: string
  /** Hostnames allowed to receive the real value at the network boundary. */
  hosts: string[]
}

/**
 * Network access configuration for the sandbox.
 * Controls egress allow-listing and credential delivery.
 */
export interface SandboxNetworkConfig {
  /** Environment variable names to pass through from the host process into the sandbox at
   *  create time. Only names that are set in the host process are injected, as plain guest
   *  environment variables (msb resolves a bare name from its own environment, so values
   *  never appear on forge's command line). */
  env?: string[]
  /** Hostnames to allow through msb's per-sandbox egress proxy via `--net-rule allow@<host>`. */
  allow?: string[]
  /** Host-held credentials exposed to the sandbox only as `$MSB_<env>` placeholders. The real
   *  value never enters the guest: msb substitutes it only for the listed hosts at the network
   *  boundary. */
  secrets?: SandboxSecretConfig[]
}

/**
 * Resource limits for the sandbox. Maps directly to `msb create` flags.
 * msb defaults are often too tight for many real projects — `pnpm install`
 * gets OOM-killed (exit 137) and shell commands run slowly.
 */
export interface SandboxResources {
  /** Memory allocated at boot, e.g. '8g', '1024m'. Maps to `msb create -m`. */
  memory?: string
  /** Boot-time ceiling for hotpluggable memory, e.g. '16g'. Maps to `msb create --max-memory`.
   *  Omit to pin the sandbox at `memory`. msb requires it to be >= `memory`. */
  maxMemory?: string
  /** Number of CPUs allocated at boot. `msb create -c` is integer-only. */
  cpus?: string
  /** Boot-time ceiling for virtual CPUs. Maps to `msb create --max-cpus`, integer-only.
   *  Omit to pin the sandbox at `cpus`. msb requires it to be >= `cpus`. */
  maxCpus?: string
  /** Size of the dedicated disk backing the sandbox's Docker Engine data dir (`/var/lib/docker`),
   *  e.g. '16g'. Maps to the `--mount-named ...:kind=disk,size=<size>` volume. Defaults to '16g'. */
  dockerDisk?: string
}

/**
 * A single custom mount for the msb sandbox. `msb` always mounts a workspace
 * at its identical host path, so only the host path is specified.
 */
export interface SandboxMountConfig {
  /** Absolute host directory (or file) path mounted into the sandbox. */
  host: string
  /** Mount read-only. Defaults to true (read-only); set false for read-write access. */
  readonly?: boolean
}

export interface SandboxImageFeaturesConfig {
  browserControl?: boolean
}

/**
 * Configuration for the sandbox execution environment (msb).
 */
export interface SandboxConfig {
  /** Sandbox mode. Currently only 'msb' is supported. Reserved for future modes. */
  mode?: 'msb'
  /** Enable sandboxed execution. When false, loops run in worktree-only mode even if msb is available. Default: true. */
  enabled?: boolean
  /** msb image reference (tag) to use for sandboxed execution. */
  image?: string
  imageFeatures?: SandboxImageFeaturesConfig
  /** Resource limits. Defaults to memory=8g, cpus=4. */
  resources?: SandboxResources
  /** Mount the source project directory read-only. Defaults to true. */
  mountProjectReadonly?: boolean
  /** Additional host directories to mount into the msb sandbox. */
  mounts?: SandboxMountConfig[]
  /** Network access configuration (egress allow-list, env passthrough, host-held secrets). */
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
 * Configuration for the read-only observability dashboard HTTP server.
 * The dashboard is unauthenticated: binding to a non-loopback address exposes
 * every loop plan, goal, audit result, finding, and cost to anyone who can reach
 * the port. Protect it with a firewall or VPN. See `DASHBOARD_EXPOSED_WARNING`
 * for the canonical warning text rendered by launch surfaces.
 */
export interface DashboardConfig {
  /** Bind hostname or IP. Defaults to "localhost". Use "0.0.0.0" to listen on all interfaces. */
  host?: string
  /** Base bind port. Defaults to 4747. Consecutive ports are tried when busy. */
  port?: number
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
 * A fallback auditor model entry with its own reasoning/thinking variant.
 * Used when a fallback needs a different variant than the primary auditor model,
 * which never inherits its variant to fallbacks.
 */
export interface AuditorFallbackModel {
  /** Model in "provider/model" format. */
  model: string
  /** Reasoning/thinking variant applied when this fallback is selected. */
  variant?: string
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
  /** Ordered entries tried, in order, when the current auditor model hits a provider usage/auth limit mid-loop. Use a `"provider/model"` string, or `{ model, variant }` to pin a variant to that fallback; the primary `auditorVariant` is **not** inherited by fallback entries. */
  auditorFallbackModels?: Array<string | AuditorFallbackModel>
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
  /** Dashboard HTTP server bind configuration. */
  dashboard?: DashboardConfig
  /** Per-agent configuration overrides. */
  agents?: Record<string, AgentOverrideConfig>
  /** Sandbox execution configuration. */
  sandbox?: SandboxConfig
}
