import type { AgentRole, AgentDefinition } from './types'
import { buildCodeAgent } from './code'
import { buildArchitectAgent } from './architect'
import { buildAuditorAgent, buildAuditorLoopAgent } from './auditor'
import { buildDecomposerAgent } from './decomposer'

export function buildAgents(): Record<AgentRole, AgentDefinition> {
  return {
    code: buildCodeAgent(),
    architect: buildArchitectAgent(),
    auditor: buildAuditorAgent(),
    'auditor-loop': buildAuditorLoopAgent(),
    decomposer: buildDecomposerAgent(),
  }
}

export { type AgentRole, type AgentDefinition, type AgentConfig } from './types'
