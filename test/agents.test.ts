import { describe, test, expect } from 'bun:test'
import { architectAgent, buildArchitectAgent } from '../src/agents/architect'
import { codeAgent, buildCodeAgent } from '../src/agents/code'
import { auditorAgent, auditorLoopAgent, buildAuditorAgent, buildAuditorLoopAgent } from '../src/agents/auditor'
import { buildAgents } from '../src/agents'

describe('Agent definitions', () => {
  describe('metadata stability', () => {
    test('architect agent has stable metadata', () => {
      expect(architectAgent.role).toBe('architect')
      expect(architectAgent.id).toBe('opencode-architect')
      expect(architectAgent.displayName).toBe('architect')
      expect(architectAgent.mode).toBe('primary')
    })

    test('code agent has stable metadata', () => {
      expect(codeAgent.role).toBe('code')
      expect(codeAgent.id).toBe('opencode-code')
      expect(codeAgent.displayName).toBe('code')
      expect(codeAgent.mode).toBe('all')
    })

    test('auditor agent has stable metadata', () => {
      expect(auditorAgent.role).toBe('auditor')
      expect(auditorAgent.id).toBe('opencode-auditor')
      expect(auditorAgent.displayName).toBe('auditor')
      expect(auditorAgent.mode).toBe('subagent')
      expect(auditorAgent.temperature).toBe(0.0)
    })

    test('auditor agent has expected tool exclusions', () => {
      expect(auditorAgent.tools?.exclude).toBeDefined()
      expect(auditorAgent.tools?.exclude).toContain('plan-execute')
      expect(auditorAgent.tools?.exclude).toContain('loop')
      expect(auditorAgent.tools?.exclude).toContain('loop-cancel')
      expect(auditorAgent.tools?.exclude).toContain('loop-status')
    })

    test('code agent has expected tool exclusions', () => {
      expect(codeAgent.tools?.exclude).toBeDefined()
      expect(codeAgent.tools?.exclude).toContain('review-delete')
      expect(codeAgent.tools?.exclude).toContain('plan-execute')
      expect(codeAgent.tools?.exclude).not.toContain('loop-cancel')
      expect(codeAgent.tools?.exclude).not.toContain('loop-status')
    })

    test('code agent prompt requires two-at-a-time code subagents for todo implementation', () => {
      const prompt = codeAgent.systemPrompt
      expect(prompt).toContain('use the Task tool to run code subagents in fixed batches of two')
      expect(prompt).toContain('launch tasks 1 and 2 in parallel')
      expect(prompt).toContain('then launch tasks 3 and 4')
      expect(prompt).toContain('Do not launch more than two code subagents at the same time')
    })

    test('auditor-loop agent has stable metadata and primary mode', () => {
      expect(auditorLoopAgent.role).toBe('auditor-loop')
      expect(auditorLoopAgent.id).toBe('opencode-auditor-loop')
      expect(auditorLoopAgent.displayName).toBe('auditor-loop')
      expect(auditorLoopAgent.mode).toBe('primary')
      expect(auditorLoopAgent.hidden).toBe(true)
      expect(auditorLoopAgent.temperature).toBe(0.0)
    })

    test('auditor-loop agent shares tool exclusions with auditor', () => {
      expect(auditorLoopAgent.tools?.exclude).toEqual(auditorAgent.tools?.exclude)
    })

    test('auditor-loop prompt extends the base auditor prompt with loop context', () => {
      expect(auditorLoopAgent.systemPrompt).toContain('isolated audit session')
      expect(auditorLoopAgent.systemPrompt).toContain('Loop Audit Context')
      expect(auditorLoopAgent.systemPrompt).toContain('primary agent')
    })

    test('auditor-loop prompt requires parallel subtasks after finding checks', () => {
      const prompt = auditorLoopAgent.systemPrompt
      expect(prompt).toContain('review-finding flow has completed')
      expect(prompt).toContain('launch at least two Task subtasks in parallel')
      expect(prompt).toContain('Keep the existing review-finding order unchanged')
    })
  })

  describe('fallow policy in system prompts', () => {
    test('architect prompt contains "fallow"', () => {
      expect(architectAgent.systemPrompt).toContain('fallow')
    })

    test('code prompt contains "fallow"', () => {
      expect(codeAgent.systemPrompt).toContain('fallow')
    })

    test('auditor prompt contains "fallow"', () => {
      expect(auditorAgent.systemPrompt).toContain('fallow')
    })
  })
})
