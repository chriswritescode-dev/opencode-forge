import type { AgentRole, AgentDefinition } from './types'
import { codeAgent, buildCodeAgent } from './code'
import { architectAgent, buildArchitectAgent } from './architect'
import { auditorAgent, auditorLoopAgent, buildAuditorAgent, buildAuditorLoopAgent } from './auditor'

export const agents: Record<AgentRole, AgentDefinition> = {
  code: codeAgent,
  architect: architectAgent,
  auditor: auditorAgent,
  'auditor-loop': auditorLoopAgent,
}

/**
 * Builds the agent map with prompts tailored to whether graph tooling is enabled.
 * When `graphEnabled` is false, agent system prompts omit graph-tool instructions
 * and substitute standard read/search-based discovery guidance.
 */
export function buildAgents({ graphEnabled }: { graphEnabled: boolean }): Record<AgentRole, AgentDefinition> {
  return {
    code: buildCodeAgent({ graphEnabled }),
    architect: buildArchitectAgent({ graphEnabled }),
    auditor: buildAuditorAgent({ graphEnabled }),
    'auditor-loop': buildAuditorLoopAgent({ graphEnabled }),
  }
}

export { type AgentRole, type AgentDefinition, type AgentConfig } from './types'
