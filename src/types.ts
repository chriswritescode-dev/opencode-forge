import type { JsonObject } from './utils/json-schema'

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

export interface WorktreeLoggingConfig {
  enabled?: boolean
  directory?: string
}

export interface PostActionConfig {
  enabled?: boolean
  skill?: string
  prompt?: string
  model?: string
}

export interface CodeGraphConfig {
  install?: boolean
  enabled?: boolean
}

export interface LoopSessionReuseConfig {
  coderContextPercent?: number
  auditorContextPercent?: number
}

export type LoopPermissionRuleConfig = string | { permission: string; pattern?: string }

export interface LoopPermissionsConfig {
  deny?: LoopPermissionRuleConfig[]
}

export interface LoopConfig {
  enabled?: boolean
  defaultMaxIterations?: number
  cleanupWorktree?: boolean
  stallTimeoutMs?: number
  worktreeLogging?: WorktreeLoggingConfig
  postAction?: PostActionConfig
  maxConsecutiveStalls?: number
  busyStallTimeoutMs?: number
  sessionReuse?: LoopSessionReuseConfig
  allowExternalDirectories?: string[]
  worktreeOpencodeConfig?: JsonObject
  permissions?: LoopPermissionsConfig
}

export interface SandboxSecretConfig {
  env: string
  hosts: string[]
}

export interface SandboxNetworkConfig {
  env?: string[]
  allow?: string[]
  secrets?: SandboxSecretConfig[]
  allowLan?: boolean
}

export interface SandboxResources {
  memory?: string
  cpus?: string
  dockerDisk?: string
  cacheDisk?: string
}

export interface SandboxOverrides {
  resources?: SandboxResources
  allowLan?: boolean
}

export interface LoopSandboxSettings extends SandboxOverrides {
  enabled?: boolean
}

export interface SandboxMountConfig {
  host: string
  readonly?: boolean
}

export interface SandboxConfig {
  mode?: 'msb'
  enabled?: boolean
  image?: string
  resources?: SandboxResources
  mountProjectReadonly?: boolean
  mounts?: SandboxMountConfig[]
  network?: SandboxNetworkConfig
  autoApprovePermissions?: boolean
}

export interface AutoApproveDenyRule {
  action: string
  resource: string
}

export interface AutoApproveConfig {
  deny?: AutoApproveDenyRule[]
}

export interface CompactionConfig {
  customPrompt?: boolean
  maxContextTokens?: number
}

export interface MessagesTransformConfig {
  enabled?: boolean
  debug?: boolean
}

export interface TuiConfig {
  sidebar?: boolean
  showVersion?: boolean
  keybinds?: Record<string, string>
}

export interface AgentOverrideConfig {
  temperature?: number
}

export interface AuditorFallbackModel {
  model: string
  variant?: string
}

export interface PluginConfig {
  dataDir?: string
  logging?: LoggingConfig
  compaction?: CompactionConfig
  messagesTransform?: MessagesTransformConfig
  executionModel?: string
  auditorModel?: string
  executionVariant?: string
  auditorVariant?: string
  auditorFallbackModels?: Array<string | AuditorFallbackModel>
  loop?: LoopConfig
  completedLoopTtlMs?: number
  tui?: TuiConfig
  agents?: Record<string, AgentOverrideConfig>
  sandbox?: SandboxConfig
  codeGraph?: CodeGraphConfig
  autoApprove?: AutoApproveConfig
}
