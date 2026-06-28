import type { AgentRole, AgentDefinition } from './types'
import { buildCodeAgent } from './code'
import { buildArchitectAgent } from './architect'
import { buildAuditorAgent, buildAuditorLoopAgent } from './auditor'
import { buildArchitectAutoAgent } from './architect-auto'
import { buildFeatureSplitterAgent } from './feature-splitter'

export function buildAgents(promptsDir?: string): Record<AgentRole, AgentDefinition> {
  return {
    code: buildCodeAgent(promptsDir),
    architect: buildArchitectAgent(promptsDir),
    auditor: buildAuditorAgent(promptsDir),
    'auditor-loop': buildAuditorLoopAgent(promptsDir),
    'architect-auto': buildArchitectAutoAgent(promptsDir),
    'feature-splitter': buildFeatureSplitterAgent(promptsDir),
  }
}

export { type AgentRole, type AgentDefinition, type AgentConfig } from './types'
