import { describe, test, expect } from 'vitest'
import { buildArchitectAgent } from '../src/agents/architect'
import { buildCodeAgent } from '../src/agents/code'
import { buildAuditorAgent, buildAuditorLoopAgent } from '../src/agents/auditor'
import { buildArchitectAutoAgent } from '../src/agents/architect-auto'
import { buildFeatureSplitterAgent } from '../src/agents/feature-splitter'
import { buildGoalAgent } from '../src/agents/goal'
import { buildAgents } from '../src/agents'

describe('Agent definitions', () => {
  const architectAgent = buildArchitectAgent()
  const codeAgent = buildCodeAgent()
  const auditorAgent = buildAuditorAgent()
  const auditorLoopAgent = buildAuditorLoopAgent()
  const architectAutoAgent = buildArchitectAutoAgent()
  const featureSplitterAgent = buildFeatureSplitterAgent()
  const goalAgent = buildGoalAgent()

  describe('metadata stability', () => {
    test('architect agent has stable metadata', () => {
      expect(architectAgent.role).toBe('architect')
      expect(architectAgent.id).toBe('opencode-architect')
      expect(architectAgent.displayName).toBe('architect')
      expect(architectAgent.mode).toBe('primary')
    })

    test('architect agent excludes plan tools', () => {
      expect(architectAgent.tools?.exclude).toBeDefined()
      expect(architectAgent.tools?.exclude).toContain('plan')
      expect(architectAgent.tools?.exclude).toContain('plan_enter')
      expect(architectAgent.tools?.exclude).toContain('plan_exit')
      expect(architectAgent.tools?.exclude).not.toContain('execute-plan')
    })

    test('architect agent allows question tool', () => {
      expect(architectAgent.permission).toBeDefined()
      expect((architectAgent.permission as Record<string, string>)?.question).toBe('allow')
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
      expect(auditorAgent.tools?.exclude).toContain('execute-plan')
      expect(auditorAgent.tools?.exclude).toContain('execute-goal')
      expect(auditorAgent.tools?.exclude).toContain('loop-cancel')
      expect(auditorAgent.tools?.exclude).toContain('loop-status')
    })

    test('code agent has expected tool exclusions', () => {
      expect(codeAgent.tools?.exclude).toBeDefined()
      expect(codeAgent.tools?.exclude).toContain('review-delete')
      expect(codeAgent.tools?.exclude).toContain('plan')
      expect(codeAgent.tools?.exclude).toContain('plan_enter')
      expect(codeAgent.tools?.exclude).toContain('plan_exit')
      expect(codeAgent.tools?.exclude).toContain('plan-write')
      expect(codeAgent.tools?.exclude).toContain('plan-edit')
      expect(codeAgent.tools?.exclude).not.toContain('execute-plan')
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
      expect(prompt).toContain('<!-- forge-section -->')
      expect(prompt).toContain('section-summary:start')
      expect(prompt).toContain('### Done')
      expect(prompt).toContain('### Deviations')
      expect(prompt).toContain('### Follow-ups')
      expect(prompt.toLowerCase()).toContain('deviation acceptance')
    })

    test('architect-auto agent has stable metadata', () => {
      expect(architectAutoAgent.role).toBe('architect-auto')
      expect(architectAutoAgent.id).toBe('opencode-architect-auto')
      expect(architectAutoAgent.displayName).toBe('architect-auto')
      expect(architectAutoAgent.mode).toBe('primary')
      expect(architectAutoAgent.hidden).toBe(true)
    })

    test('architect-auto agent excludes plan and question tools', () => {
      expect(architectAutoAgent.tools?.exclude).toBeDefined()
      expect(architectAutoAgent.tools?.exclude).toContain('plan')
      expect(architectAutoAgent.tools?.exclude).toContain('plan_enter')
      expect(architectAutoAgent.tools?.exclude).toContain('plan_exit')
      expect(architectAutoAgent.tools?.exclude).toContain('question')
    })

    test('feature-splitter agent has stable metadata', () => {
      expect(featureSplitterAgent.role).toBe('feature-splitter')
      expect(featureSplitterAgent.id).toBe('opencode-feature-splitter')
      expect(featureSplitterAgent.displayName).toBe('feature-splitter')
      expect(featureSplitterAgent.mode).toBe('primary')
      expect(featureSplitterAgent.hidden).toBe(true)
    })

    test('feature-splitter agent excludes plan, question, write, edit, and patch tools', () => {
      expect(featureSplitterAgent.tools?.exclude).toBeDefined()
      expect(featureSplitterAgent.tools?.exclude).toContain('plan')
      expect(featureSplitterAgent.tools?.exclude).toContain('plan_enter')
      expect(featureSplitterAgent.tools?.exclude).toContain('plan_exit')
      expect(featureSplitterAgent.tools?.exclude).toContain('question')
      expect(featureSplitterAgent.tools?.exclude).toContain('write')
      expect(featureSplitterAgent.tools?.exclude).toContain('edit')
      expect(featureSplitterAgent.tools?.exclude).toContain('patch')
      expect(featureSplitterAgent.tools?.exclude).toContain('plan-write')
      expect(featureSplitterAgent.tools?.exclude).toContain('plan-edit')
    })

    test('goal agent has stable metadata', () => {
      expect(goalAgent.role).toBe('goal')
      expect(goalAgent.id).toBe('opencode-goal')
      expect(goalAgent.displayName).toBe('goal')
      expect(goalAgent.mode).toBe('primary')
    })

    test('goal agent excludes plan-authoring and file-mutation tools but keeps goal-write, execute-goal, and question', () => {
      expect(goalAgent.tools?.exclude).toBeDefined()
      expect(goalAgent.tools?.exclude).toContain('write')
      expect(goalAgent.tools?.exclude).toContain('edit')
      expect(goalAgent.tools?.exclude).toContain('multiedit')
      expect(goalAgent.tools?.exclude).toContain('apply_patch')
      expect(goalAgent.tools?.exclude).toContain('patch')
      expect(goalAgent.tools?.exclude).toContain('plan')
      expect(goalAgent.tools?.exclude).toContain('plan_enter')
      expect(goalAgent.tools?.exclude).toContain('plan_exit')
      expect(goalAgent.tools?.exclude).toContain('plan-write')
      expect(goalAgent.tools?.exclude).toContain('plan-edit')
      expect(goalAgent.tools?.exclude).toContain('plan-adjust')
      expect(goalAgent.tools?.exclude).toContain('execute-plan')
      expect(goalAgent.tools?.exclude).not.toContain('execute-goal')
      expect(goalAgent.tools?.exclude).not.toContain('question')
      expect(goalAgent.tools?.exclude).not.toContain('goal-write')
    })

    test('goal agent allows the question tool', () => {
      expect(goalAgent.permission).toBeDefined()
      expect((goalAgent.permission as Record<string, string>)?.question).toBe('allow')
    })

    test('architect agents retain plan-authoring tools', () => {
      expect(architectAgent.tools?.exclude).not.toContain('plan-write')
      expect(architectAgent.tools?.exclude).not.toContain('plan-edit')
      expect(architectAutoAgent.tools?.exclude).not.toContain('plan-write')
      expect(architectAutoAgent.tools?.exclude).not.toContain('plan-edit')
    })

    test('hidden group agents preserve overlap-aware planning guidance', () => {
      expect(featureSplitterAgent.systemPrompt).toContain('implementation-coherent features')
      expect(featureSplitterAgent.systemPrompt).toContain('small, independently reviewable plans/PRs')
      expect(featureSplitterAgent.systemPrompt).toContain('Same-file edits alone are not enough to group')
      expect(architectAutoAgent.systemPrompt).toContain('non-trivial implementation coupling')
    })

    test('buildAgents returns all 7 agent roles', () => {
      const agents = buildAgents()
      const roles = Object.keys(agents)
      expect(roles).toHaveLength(7)
      expect(roles).toContain('code')
      expect(roles).toContain('architect')
      expect(roles).toContain('auditor')
      expect(roles).toContain('auditor-loop')
      expect(roles).toContain('architect-auto')
      expect(roles).toContain('feature-splitter')
      expect(roles).toContain('goal')
    })

    test('goal-write is excluded from every non-goal agent and kept only by the goal agent', () => {
      const agents = buildAgents()
      for (const [role, agent] of Object.entries(agents)) {
        const exclude = agent.tools?.exclude ?? []
        if (role === 'goal') {
          expect(exclude).not.toContain('goal-write')
        } else {
          expect(exclude).toContain('goal-write')
        }
      }
    })

    test('architect and architect-auto keep plan-authoring tools but deny goal-write', () => {
      for (const agent of [architectAgent, architectAutoAgent]) {
        expect(agent.tools?.exclude).not.toContain('plan-write')
        expect(agent.tools?.exclude).not.toContain('plan-edit')
        expect(agent.tools?.exclude).toContain('goal-write')
      }
    })
  })

  describe('architect prompt', () => {
    test('architect.systemPrompt no longer requires `## Phase N:` headings', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).not.toContain('## Phase N: <title>')
      expect(prompt).not.toContain('Do not add section marker comments')
    })

    test('architect.systemPrompt instructs section-marker format', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).toContain('<!-- forge-section -->')
      expect(prompt).toContain('### Files')
      expect(prompt).toContain('### Edits')
      expect(prompt).toContain('### Acceptance Criteria')
      expect(prompt).toContain('### Verification')
      // New explicit rules
      expect(prompt).toContain('exactly one')
      expect(prompt).toContain('immediately before')
      expect(prompt).toContain('## Phase')
      expect(prompt).toContain('Never place')
    })

    test('architect.systemPrompt prohibits markers before subsection headings', () => {
      const prompt = architectAgent.systemPrompt
      // The prompt must not say "before each section's heading" without clarifying
      // it means the ## Phase heading, not ### subsection headings
      expect(prompt).not.toMatch(/before each section'?s? heading/i)
    })

    test('architect.systemPrompt does not duplicate marker self-check (moved to reminder)', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).not.toContain('Critical marker self-check before approval')
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
      for (const agent of [architectAgent, codeAgent, auditorAgent, auditorLoopAgent, architectAutoAgent, featureSplitterAgent]) {
        expect(agent.systemPrompt).not.toContain('graph-query')
        expect(agent.systemPrompt).not.toContain('graph-symbols')
        expect(agent.systemPrompt).not.toContain('graph-analyze')
      }
    })
  })
})
