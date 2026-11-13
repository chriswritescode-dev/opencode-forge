export type AgentRole = 'code' | 'architect' | 'auditor' | 'auditor-loop' | 'minion'

export type PermissionEffect = 'allow' | 'deny' | 'ask'

export interface PermissionResourceMap {
  [resource: string]: string
}

export type PermissionValue = string | PermissionResourceMap

export interface AgentPermissionMap {
  [permission: string]: PermissionValue
}

export interface AgentDefinition {
  role: AgentRole
  id: string
  displayName: string
  description?: string
  defaultModel?: string
  systemPrompt?: string
  systemAddendum?: string
  mode?: 'primary' | 'subagent' | 'all'
  hidden?: boolean
  color?: string
  tools?: {
    include?: string[]
    exclude?: string[]
  }
  variant?: string
  temperature?: number
  steps?: number
  permission?: AgentPermissionMap
}

export interface AgentConfig {
  description?: string
  model: string
  prompt?: string
  mode?: 'primary' | 'subagent' | 'all'
  tools?: Record<string, boolean>
  variant?: string
  temperature?: number
  steps?: number
  hidden?: boolean
  color?: string
  permission?: AgentPermissionMap
}
