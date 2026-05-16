import type { AgentRole, AgentDefinition } from './types'
import { buildCodeAgent } from './code'
import { buildArchitectAgent } from './architect'
import { buildAuditorAgent, buildAuditorLoopAgent } from './auditor'

export function buildAgents(): Record<AgentRole, AgentDefinition> {
  return {
    code: buildCodeAgent(),
    architect: buildArchitectAgent(),
    auditor: buildAuditorAgent(),
    'auditor-loop': buildAuditorLoopAgent(),
  }
}

export { type AgentRole, type AgentDefinition, type AgentConfig } from './types'
