import type { AgentRole, AgentDefinition } from './types'
import { buildCodeAgent } from './code'
import { buildArchitectAgent } from './architect'
import { buildAuditorAgent, buildAuditorLoopAgent } from './auditor'
import { buildArchitectAutoAgent } from './architect-auto'
import { buildMinionAgent } from './minion'

export function buildAgents(
  promptsDir?: string,
  minionModel?: { model?: string; variant?: string },
): Record<AgentRole, AgentDefinition> {
  return {
    code: buildCodeAgent(promptsDir),
    architect: buildArchitectAgent(promptsDir),
    auditor: buildAuditorAgent(promptsDir),
    'auditor-loop': buildAuditorLoopAgent(promptsDir),
    'architect-auto': buildArchitectAutoAgent(promptsDir),
    minion: buildMinionAgent(promptsDir, minionModel),
  }
}

export { type AgentRole, type AgentDefinition, type AgentConfig } from './types'
