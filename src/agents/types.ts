// Public interface — kept even if unused internally
/**
 * Available agent roles in the plugin.
 */
export type AgentRole = 'code' | 'architect' | 'auditor' | 'auditor-loop'

/**
 * Definition of an agent's capabilities and configuration.
 */
export interface AgentDefinition {
  /** The role this agent fulfills. */
  role: AgentRole
  /** Unique identifier for the agent. */
  id: string
  /** Display name shown in UI. */
  displayName: string
  /** Human-readable description of the agent. */
  description: string
  /** Default model to use if not overridden. */
  defaultModel?: string
  /** System prompt that defines agent behavior. */
  systemPrompt: string
  /** Operating mode of the agent. */
  mode?: 'primary' | 'subagent' | 'all'
  /** Hide this agent from UI. */
  hidden?: boolean
  /** UI color for this agent. */
  color?: string
  /** Tool access configuration. */
  tools?: {
    /** List of tools to include. */
    include?: string[]
    /** List of tools to exclude. */
    exclude?: string[]
  }
  /** Agent variant identifier. */
  variant?: string
  /** Model temperature override. */
  temperature?: number
  /** Maximum steps before requiring re-planning. */
  steps?: number
  /** Permission configuration for the agent. */
  permission?: Record<string, unknown>
}

/**
 * Runtime configuration for an agent instance.
 */
export interface AgentConfig {
  /** Description of this agent configuration. */
  description: string
  /** Model identifier to use. */
  model: string
  /** Prompt override for this instance. */
  prompt: string
  /** Operating mode override. */
  mode?: 'primary' | 'subagent' | 'all'
  /** Tool availability map. */
  tools?: Record<string, boolean>
  /** Agent variant identifier. */
  variant?: string
  /** Model temperature override. */
  temperature?: number
  /** Maximum steps override. */
  steps?: number
  /** Hide from UI. */
  hidden?: boolean
  /** UI color override. */
  color?: string
  /** Permission override. */
  permission?: Record<string, unknown>
}
