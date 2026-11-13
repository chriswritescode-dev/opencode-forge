import { z } from 'zod'
import type { AgentRole, AgentDefinition, AgentConfig } from './agents'
import type { AgentPermissionMap } from './agents/types'
import { loadPrompt } from './prompts/loader'

export interface PluginCommand { template: string; description: string; agent: string; subtask: boolean }

export interface PluginCommandIndex {
  [name: string]: PluginCommand
}

export interface UserCommand {
  template?: string
  description?: string
  agent?: string
  subtask?: boolean
}

export interface CommandEntryIndex {
  [name: string]: PluginCommand | UserCommand
}

export interface AgentConfigIndex {
  [name: string]: AgentConfig
}

export interface ToolEnablementMap {
  [tool: string]: boolean
}

export interface HostConfig {
  agent?: unknown
  command?: unknown
  default_agent?: unknown
}

export const REPLACED_BUILTIN_AGENTS = ['build', 'plan']

export const USER_REPLACEABLE_AGENTS = ['minion']

export const DEFAULT_MODEL_SUBAGENTS = ['minion']

export const DEFAULT_AGENT = 'code'

const agentPermissionSchema = z.record(z.string(), z.union([z.string(), z.record(z.string(), z.string())]))

const agentConfigOverridesSchema = z.looseObject({
  description: z.string().optional().catch(undefined),
  model: z.string().optional().catch(undefined),
  prompt: z.string().optional().catch(undefined),
  mode: z.enum(['primary', 'subagent', 'all']).optional().catch(undefined),
  tools: z.record(z.string(), z.boolean()).optional().catch(undefined),
  variant: z.string().optional().catch(undefined),
  temperature: z.number().optional().catch(undefined),
  steps: z.number().optional().catch(undefined),
  hidden: z.boolean().optional().catch(undefined),
  color: z.string().optional().catch(undefined),
  permission: agentPermissionSchema.optional().catch(undefined),
})

const userCommandSchema = z.looseObject({
  template: z.string().optional().catch(undefined),
  description: z.string().optional().catch(undefined),
  agent: z.string().optional().catch(undefined),
  subtask: z.boolean().optional().catch(undefined),
})

const userCommandIndexSchema = z.record(z.string(), z.unknown())

const userAgentIndexSchema = z.record(z.string(), z.unknown())

export type AgentConfigOverrides = z.infer<typeof agentConfigOverridesSchema>

export type MergedAgentConfig = AgentConfig | AgentConfigOverrides

export interface MergedAgentConfigIndex {
  [name: string]: MergedAgentConfig
}

function buildPluginCommands(promptsDir?: string): PluginCommandIndex {
  return {
    review: { description: 'Run a code review.', agent: 'auditor', subtask: true,
      template: loadPrompt(['commands','review.md'], promptsDir) },
    'review-plan': { description: 'Review a completed implementation against its original plan.', agent: 'auditor', subtask: true,
      template: loadPrompt(['commands','review-plan.md'], promptsDir) },
    'execute-plan': { description: 'Execute a plan in an iterative development loop, or a fresh standalone session', agent: 'code', subtask: false,
      template: loadPrompt(['commands','execute-plan.md'], promptsDir) },
    'loop-status': { description: 'Check status of all active loops', agent: 'code', subtask: false,
      template: loadPrompt(['commands','loop-status.md'], promptsDir) },
    'loop-cancel': { description: 'Cancel the active loop', agent: 'code', subtask: false,
      template: loadPrompt(['commands','loop-cancel.md'], promptsDir) },
  }
}

export function createConfigHandler(
  agents: Record<AgentRole, AgentDefinition>,
  agentOverrides?: Record<string, { temperature?: number }>,
  promptsDir?: string
) {
  const pluginCommands = buildPluginCommands(promptsDir)

  return async (config: HostConfig) => {
    const effectiveAgents: AgentConfigIndex = createAgentConfigs(agents)
    if (agentOverrides) {
      for (const [name, overrides] of Object.entries(agentOverrides)) {
        const role = Object.entries(agents).find(
          ([, agent]) => agent.displayName === name
        )?.[0]
        if (role === undefined) continue
        effectiveAgents[role] = { ...effectiveAgents[role], ...overrides }
      }
    }

    const mergedAgents: MergedAgentConfigIndex = { ...effectiveAgents }

    const userAgentIndex = userAgentIndexSchema.safeParse(config.agent)
    if (userAgentIndex.success) {
      for (const [name, rawUserConfig] of Object.entries(userAgentIndex.data)) {
        const parsed = agentConfigOverridesSchema.safeParse(rawUserConfig)
        if (!parsed.success) continue
        const userConfig = parsed.data
        const existing = mergedAgents[name]
        if (existing) {
          const mergedTools: ToolEnablementMap = { ...existing.tools, ...userConfig.tools }
          const existingPermission: AgentPermissionMap = existing.permission ?? {}
          const mergedPermission: AgentPermissionMap = { ...existingPermission, ...userConfig.permission }
          if (userConfig.tools) {
            for (const [tool, enabled] of Object.entries(userConfig.tools)) {
              mergedPermission[tool] = enabled ? 'allow' : 'deny'
            }
          }
          for (const [tool, enabled] of Object.entries(existing.tools ?? {})) {
            if (enabled === false && existingPermission[tool] === 'deny') {
              mergedTools[tool] = false
              delete mergedPermission[tool]
              mergedPermission[tool] = 'deny'
            }
          }
          const merged: MergedAgentConfig = { ...existing, ...userConfig }
          if (Object.keys(mergedTools).length) merged.tools = mergedTools
          if (Object.keys(mergedPermission).length) merged.permission = mergedPermission
          mergedAgents[name] = merged
        } else {
          mergedAgents[name] = userConfig
        }
      }
    }

    for (const name of REPLACED_BUILTIN_AGENTS) {
      mergedAgents[name] = { ...mergedAgents[name], hidden: true }
    }

    config.agent = mergedAgents
    config.default_agent = DEFAULT_AGENT

    const mergedCommands: CommandEntryIndex = { ...pluginCommands }

    const userCommands = userCommandIndexSchema.safeParse(config.command)
    if (userCommands.success) {
      for (const [name, rawUserCommand] of Object.entries(userCommands.data)) {
        const parsed = userCommandSchema.safeParse(rawUserCommand)
        if (!parsed.success) continue
        mergedCommands[name] = parsed.data
      }
    }

    config.command = mergedCommands
  }
}

function createAgentConfigs(agents: Record<AgentRole, AgentDefinition>): AgentConfigIndex {
  const result: AgentConfigIndex = {}

  for (const agent of Object.values(agents)) {
    const tools: Record<string, boolean> = {}
    const permission: AgentPermissionMap = { ...agent.permission }
    if (agent.tools?.exclude) {
      for (const tool of agent.tools.exclude) {
        tools[tool] = false
        permission[tool] = 'deny'
      }
    }

    const config: AgentConfig = {
      description: agent.description,
      model: agent.defaultModel ?? '',
    }
    if (agent.systemPrompt !== undefined) config.prompt = agent.systemPrompt
    config.mode = agent.mode ?? 'subagent'
    if (Object.keys(tools).length > 0) config.tools = tools
    if (agent.variant) config.variant = agent.variant
    if (agent.temperature !== undefined) config.temperature = agent.temperature
    if (agent.steps !== undefined) config.steps = agent.steps
    if (agent.hidden) config.hidden = agent.hidden
    if (agent.color) config.color = agent.color
    if (Object.keys(permission).length > 0) config.permission = permission
    result[agent.displayName] = config
  }

  return result
}
