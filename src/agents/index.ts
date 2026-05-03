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

export function buildAgents(): Record<AgentRole, AgentDefinition> {
  return {
    code: buildCodeAgent(),
    architect: buildArchitectAgent(),
    auditor: buildAuditorAgent(),
    'auditor-loop': buildAuditorLoopAgent(),
  }
}

export { type AgentRole, type AgentDefinition, type AgentConfig } from './types'
