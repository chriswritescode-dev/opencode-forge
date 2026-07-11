import type { AgentRole, AgentDefinition, AgentConfig } from './agents'
import { loadPrompt } from './prompts/loader'

interface PluginCommand { template: string; description: string; agent: string; subtask: boolean }

const REPLACED_BUILTIN_AGENTS = ['build', 'plan']

function buildPluginCommands(promptsDir?: string): Record<string, PluginCommand> {
  return {
    review: { description: 'Run a code review.', agent: 'auditor', subtask: true,
      template: loadPrompt(['commands','review.md'], promptsDir) },
    'review-plan': { description: 'Review a completed implementation against its original plan.', agent: 'auditor', subtask: true,
      template: loadPrompt(['commands','review-plan.md'], promptsDir) },
    'execute-plan': { description: 'Execute a plan in an iterative development loop, or a fresh standalone session', agent: 'code', subtask: false,
      template: loadPrompt(['commands','execute-plan.md'], promptsDir) },
    'execute-goal': { description: 'Execute a goal in a dedicated session inside an isolated Forge worktree loop', agent: 'code', subtask: false,
      template: loadPrompt(['commands','execute-goal.md'], promptsDir) },
    'launch-group': { description: 'Decompose a request into features and launch them as parallel planning + development loops', agent: 'code', subtask: false,
      template: loadPrompt(['commands','launch-group.md'], promptsDir) },
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

  return async (config: Record<string, unknown>) => {
    const effectiveAgents = { ...agents }
    if (agentOverrides) {
      for (const [name, overrides] of Object.entries(agentOverrides)) {
        const role = Object.keys(effectiveAgents).find(
          (r) => effectiveAgents[r as AgentRole].displayName === name
        ) as AgentRole | undefined
        if (role) {
          effectiveAgents[role] = { ...effectiveAgents[role], ...overrides }
        }
      }
    }

    const agentConfigs = createAgentConfigs(effectiveAgents)

    const userAgentConfigs = config.agent as Record<string, AgentConfig> | undefined
    const mergedAgents = { ...agentConfigs }

    if (userAgentConfigs) {
      for (const [name, userConfig] of Object.entries(userAgentConfigs)) {
        if (mergedAgents[name]) {
          const existing = mergedAgents[name]
          const mergedTools = { ...(existing?.tools ?? {}), ...(userConfig.tools ?? {}) }
          const existingPermission = (existing?.permission as Record<string, unknown> | undefined) ?? {}
          const mergedPermission = {
            ...existingPermission,
            ...((userConfig.permission as Record<string, unknown> | undefined) ?? {}),
          }
          if (userConfig.tools) {
            for (const [tool, enabled] of Object.entries(userConfig.tools)) {
              mergedPermission[tool] = enabled ? 'allow' : 'deny'
            }
          }
          for (const [tool, enabled] of Object.entries(existing?.tools ?? {})) {
            if (enabled === false && existingPermission[tool] === 'deny') {
              mergedTools[tool] = false
              delete mergedPermission[tool]
              mergedPermission[tool] = 'deny'
            }
          }
          mergedAgents[name] = {
            ...existing,
            ...userConfig,
            ...(Object.keys(mergedTools).length ? { tools: mergedTools } : {}),
            ...(Object.keys(mergedPermission).length ? { permission: mergedPermission } : {}),
          }
        } else {
          mergedAgents[name] = userConfig
        }
      }
    }

    for (const name of REPLACED_BUILTIN_AGENTS) {
      mergedAgents[name] = { ...mergedAgents[name], hidden: true }
    }

    config.agent = mergedAgents
    config.default_agent = 'code'

    const userCommands = config.command as Record<string, unknown> | undefined
    const mergedCommands: Record<string, unknown> = { ...pluginCommands }

    if (userCommands) {
      for (const [name, userCommand] of Object.entries(userCommands)) {
        mergedCommands[name] = userCommand
      }
    }

    config.command = mergedCommands
  }
}

function createAgentConfigs(agents: Record<AgentRole, AgentDefinition>): Record<string, AgentConfig> {
  const result: Record<string, AgentConfig> = {}

  for (const agent of Object.values(agents)) {
    const tools: Record<string, boolean> = {}
    // Mirror tools.exclude into a permission map. Opencode's agent loader only
    // reads `value.permission` when merging plugin-provided `cfg.agent` entries
    // (see opencode packages/opencode/src/agent/agent.ts). The legacy `tools`
    // map is only normalized via the zod Info transform at parse time, which
    // does not run on config mutated by the plugin config hook. Without this
    // permission mirror, excluded tools remain callable.
    const permission: Record<string, unknown> = {
      ...((agent.permission as Record<string, unknown> | undefined) ?? {}),
    }
    if (agent.tools?.exclude) {
      for (const tool of agent.tools.exclude) {
        tools[tool] = false
        permission[tool] = 'deny'
      }
    }

    result[agent.displayName] = {
      description: agent.description,
      model: agent.defaultModel ?? '',
      prompt: agent.systemPrompt ?? '',
      mode: agent.mode ?? 'subagent',
      ...(Object.keys(tools).length > 0 ? { tools } : {}),
      ...(agent.variant ? { variant: agent.variant } : {}),
      ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
      ...(agent.steps !== undefined ? { steps: agent.steps } : {}),
      ...(agent.hidden ? { hidden: agent.hidden } : {}),
      ...(agent.color ? { color: agent.color } : {}),
      ...(Object.keys(permission).length > 0 ? { permission } : {}),
    }
  }

  return result
}
