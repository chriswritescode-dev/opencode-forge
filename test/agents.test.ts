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
      expect(auditorAgent.tools?.exclude).toContain('apply_patch')
      expect(auditorAgent.tools?.exclude).toContain('edit')
      expect(auditorAgent.tools?.exclude).toContain('write')
      expect(auditorAgent.tools?.exclude).toContain('multiedit')
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

  describe('ast-grep policy in system prompts', () => {
    test('architect prompt contains ast-grep CLI guidance', () => {
      expect(architectAgent.systemPrompt).toContain('ast-grep')
      expect(architectAgent.systemPrompt).toContain('ast-grep-search')
      expect(architectAgent.systemPrompt).toContain('@ast-grep/cli')
    })

    test('code prompt contains ast-grep CLI guidance', () => {
      expect(codeAgent.systemPrompt).toContain('ast-grep')
      expect(codeAgent.systemPrompt).toContain('ast-grep-search')
      expect(codeAgent.systemPrompt).toContain('ast-grep-scan')
    })

    test('auditor prompt contains ast-grep CLI guidance', () => {
      expect(auditorAgent.systemPrompt).toContain('ast-grep')
      expect(auditorAgent.systemPrompt).toContain('ast-grep-search')
      expect(auditorAgent.systemPrompt).toContain('ast-grep-scan')
    })

    test('prompts do not contain legacy graph tool names', () => {
      expect(architectAgent.systemPrompt).not.toContain('graph-query')
      expect(architectAgent.systemPrompt).not.toContain('graph-symbols')
      expect(architectAgent.systemPrompt).not.toContain('graph-analyze')
      expect(codeAgent.systemPrompt).not.toContain('graph-query')
      expect(codeAgent.systemPrompt).not.toContain('graph-symbols')
      expect(codeAgent.systemPrompt).not.toContain('graph-analyze')
      expect(auditorAgent.systemPrompt).not.toContain('graph-query')
      expect(auditorAgent.systemPrompt).not.toContain('graph-symbols')
      expect(auditorAgent.systemPrompt).not.toContain('graph-analyze')
    })

    test('agent prompts avoid deprecated graph tooling names', () => {
      for (const agent of [architectAgent, codeAgent, auditorAgent, auditorLoopAgent]) {
        expect(agent.systemPrompt).not.toContain('graph-query')
        expect(agent.systemPrompt).not.toContain('graph-symbols')
        expect(agent.systemPrompt).not.toContain('graph-analyze')
      }
    })
  })
})
