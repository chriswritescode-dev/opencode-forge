import type { AgentRole, AgentDefinition } from './types'
import { codeAgent } from './code'
import { architectAgent } from './architect'
import { auditorAgent } from './auditor'

export const agents: Record<AgentRole, AgentDefinition> = {
  code: codeAgent,
  architect: architectAgent,
  auditor: auditorAgent,
}

/**
 * Returns the list of tools that the given agent role is configured to exclude.
 *
 * Callers use this to append the exclusions as deny rules when constructing a
 * loop session's permission ruleset, so the agent cannot invoke those tools
 * regardless of the allow-all worktree rule.
 */
export function getAgentExcludedTools(role: AgentRole = 'code'): string[] {
  return agents[role]?.tools?.exclude ?? []
}

export { type AgentRole, type AgentDefinition, type AgentConfig } from './types'
