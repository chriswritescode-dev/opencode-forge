import type { AgentRole, AgentDefinition } from './types'
import { codeAgent } from './code'
import { architectAgent } from './architect'
import { auditorAgent, auditorLoopAgent } from './auditor'

export const agents: Record<AgentRole, AgentDefinition> = {
  code: codeAgent,
  architect: architectAgent,
  auditor: auditorAgent,
  'auditor-loop': auditorLoopAgent,
}

export { type AgentRole, type AgentDefinition, type AgentConfig } from './types'
