import type { AgentDefinition } from './types'
import { buildCodeAgent } from './code'
import { buildArchitectAgent } from './architect'
import { buildAuditorAgent, buildAuditorLoopAgent } from './auditor'
import { buildMinionAgent } from './minion'

export interface AgentDefinitionsByRole {
  code: AgentDefinition
  architect: AgentDefinition
  auditor: AgentDefinition
  'auditor-loop': AgentDefinition
  minion: AgentDefinition
}

export function buildAgents(
  promptsDir?: string,
  minionModel?: { model?: string; variant?: string },
): AgentDefinitionsByRole {
  return {
    code: buildCodeAgent(promptsDir),
    architect: buildArchitectAgent(promptsDir),
    auditor: buildAuditorAgent(promptsDir),
    'auditor-loop': buildAuditorLoopAgent(promptsDir),
    minion: buildMinionAgent(promptsDir, minionModel),
  }
}

export { type AgentRole, type AgentDefinition, type AgentConfig } from './types'
