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

    test('architect agent excludes plan and plan_exit tools', () => {
      expect(architectAgent.tools?.exclude).toBeDefined()
      expect(architectAgent.tools?.exclude).toContain('plan')
      expect(architectAgent.tools?.exclude).toContain('plan_exit')
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
    })

    test('auditor agent has expected tool exclusions', () => {
      expect(auditorAgent.tools?.exclude).toBeDefined()
      expect(auditorAgent.tools?.exclude).toContain('apply_patch')
      expect(auditorAgent.tools?.exclude).toContain('edit')
      expect(auditorAgent.tools?.exclude).toContain('write')
      expect(auditorAgent.tools?.exclude).toContain('multiedit')
      expect(auditorAgent.tools?.exclude).toContain('plan')
      expect(auditorAgent.tools?.exclude).toContain('plan_exit')
      expect(auditorAgent.tools?.exclude).toContain('loop')
      expect(auditorAgent.tools?.exclude).toContain('loop-cancel')
      expect(auditorAgent.tools?.exclude).toContain('loop-status')
    })

    test('code agent has expected tool exclusions', () => {
      expect(codeAgent.tools?.exclude).toBeDefined()
      expect(codeAgent.tools?.exclude).toContain('review-delete')
      expect(codeAgent.tools?.exclude).toContain('plan')
      expect(codeAgent.tools?.exclude).toContain('plan_exit')
      expect(codeAgent.tools?.exclude).not.toContain('loop-cancel')
      expect(codeAgent.tools?.exclude).not.toContain('loop-status')
    })

    test('code agent prompt requires two-at-a-time code subagents for todo implementation', () => {
      const prompt = codeAgent.systemPrompt
      expect(prompt).toContain('Each `code` subagent must receive exactly one focused todo task')
      expect(prompt).toContain('inspect and reconcile its changes before marking the todo complete')
      expect(prompt).toContain('files changed, behavior implemented, validation run, results')
      expect(prompt).toContain('Do not launch more than two code subagents at the same time')
    })

    test('architect prompt requires TDD-aware behavior-first planning', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).toContain('# TDD-aware planning')
      expect(prompt).toContain('use the `tdd` skill before finalizing the plan')
      expect(prompt).toContain('behavior-first verification through public interfaces')
      expect(prompt).toContain('vertical tracer-bullet phases')
      expect(prompt).toContain('Do not plan horizontal slices')
      expect(prompt).toContain('name the exact test file')
    })

    test('auditor-loop agent has stable metadata and primary mode', () => {
      expect(auditorLoopAgent.role).toBe('auditor-loop')
      expect(auditorLoopAgent.id).toBe('opencode-auditor-loop')
      expect(auditorLoopAgent.displayName).toBe('auditor-loop')
      expect(auditorLoopAgent.mode).toBe('primary')
      expect(auditorLoopAgent.hidden).toBe(true)
    })

    test('auditor-loop agent shares tool exclusions with auditor', () => {
      expect(auditorLoopAgent.tools?.exclude).toEqual(auditorAgent.tools?.exclude)
    })

    test('auditor-loop prompt extends the base auditor prompt with loop context', () => {
      expect(auditorLoopAgent.systemPrompt).toContain('isolated audit session')
      expect(auditorLoopAgent.systemPrompt).toContain('Loop Audit Context')
      expect(auditorLoopAgent.systemPrompt).toContain('primary agent')
    })

    test('auditor-loop prompt encourages short-lived subtasks after finding checks', () => {
      const prompt = auditorLoopAgent.systemPrompt
      expect(prompt).toContain('review-finding flow has completed')
      expect(prompt).toContain('short-lived Task subtasks')
      expect(prompt).toContain('Keep the existing review-finding order unchanged')
    })

    test('auditor-loop prompt includes LOOP_ADDENDUM and FINAL_AUDIT_ADDENDUM content', () => {
      const prompt = auditorLoopAgent.systemPrompt
      expect(prompt).toContain('forge-section')
      expect(prompt).toContain('section-summary:start')
      expect(prompt).toContain('### Done')
      expect(prompt).toContain('### Deviations')
      expect(prompt).toContain('### Follow-ups')
      expect(prompt.toLowerCase()).toContain('deviation acceptance')
    })
  })

  describe('architect prompt', () => {
    test('architect.systemPrompt instructs section marker wrapping', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).toContain('<!-- forge-section:start -->')
      expect(prompt).toContain('<!-- forge-section:end -->')
      expect(prompt.toLowerCase()).toContain('wrap each phase')
      expect(prompt.toLowerCase()).toContain('inside the outer plan markers')
    })

    test('architect.systemPrompt forbids nested forge-section markers', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).toContain('nested')
      expect(prompt).toContain('forge-section')
    })
  })

  describe('agent prompt hygiene', () => {
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
