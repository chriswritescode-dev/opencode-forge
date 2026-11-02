import { describe, test, expect } from 'vitest'
import { buildArchitectAgent } from '../src/agents/architect'
import { buildCodeAgent } from '../src/agents/code'
import { buildAuditorAgent, buildAuditorLoopAgent } from '../src/agents/auditor'
import { buildMinionAgent } from '../src/agents/minion'
import { buildAgents } from '../src/agents'

describe('Agent definitions', () => {
  const architectAgent = buildArchitectAgent()
  const codeAgent = buildCodeAgent()
  const auditorAgent = buildAuditorAgent()
  const auditorLoopAgent = buildAuditorLoopAgent()
  const minionAgent = buildMinionAgent()

  describe('metadata stability', () => {
    test('architect agent has stable metadata', () => {
      expect(architectAgent.role).toBe('architect')
      expect(architectAgent.id).toBe('opencode-architect')
      expect(architectAgent.displayName).toBe('architect')
      expect(architectAgent.mode).toBe('primary')
    })

    test('architect agent excludes mutation and subagent tools', () => {
      expect(architectAgent.tools?.exclude).toEqual(['edit', 'write', 'patch', 'task', 'loop-handoff', 'loop-complete'])
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
      expect(auditorAgent.tools?.exclude).toContain('edit')
      expect(auditorAgent.tools?.exclude).toContain('write')
      expect(auditorAgent.tools?.exclude).toContain('execute-plan')
      expect(auditorAgent.tools?.exclude).toContain('question')
      expect(auditorAgent.tools?.exclude).toContain('loop-cancel')
      expect(auditorAgent.tools?.exclude).toContain('loop-status')
      expect(auditorAgent.tools?.exclude).toContain('loop-complete')
      expect(auditorAgent.tools?.exclude).toContain('loop-handoff')
    })

    test('code agent has expected tool exclusions', () => {
      expect(codeAgent.tools?.exclude).toBeDefined()
      expect(codeAgent.tools?.exclude).toContain('review-delete')
      expect(codeAgent.tools?.exclude).toContain('plan-write')
      expect(codeAgent.tools?.exclude).toContain('plan-edit')
      expect(codeAgent.tools?.exclude).not.toContain('execute-plan')
      expect(codeAgent.tools?.exclude).not.toContain('loop-cancel')
      expect(codeAgent.tools?.exclude).not.toContain('loop-status')
    })

    test("code agent appends to OpenCode's default prompt instead of replacing it", () => {
      expect(codeAgent.systemPrompt).toBeUndefined()
      const addendum = codeAgent.systemAddendum ?? ''
      expect(codeAgent.systemAddendum).toBeDefined()
      expect(addendum).not.toContain('You are an AI agent running in OpenCode')
      expect(addendum).not.toContain('# Harness')
      expect(addendum).not.toContain('${OPENCODE_TOOL_GUIDANCE}')
      expect(addendum).not.toContain('TodoWrite')
      expect(addendum).not.toContain('Task tool')
      expect(addendum).not.toContain('Bash')
    })

    test('code agent prompt preserves scope, minion, and Forge protections', () => {
      const prompt = codeAgent.systemAddendum
      expect(prompt).toContain('completing the requested scope')
      expect(prompt).toContain('minion')
      expect(prompt).toContain('explicit instruction to delegate')
      expect(prompt).toContain('identify bounded implementation tasks')
      expect(prompt).toContain('Delegate a single task even when no parallel work exists')
      expect(prompt).toContain('up to four minions concurrently')
      expect(prompt).toContain('target files do not overlap')
      expect(prompt).toContain('inspect and reconcile')
      expect(prompt).toContain('files changed, behavior implemented, validation run')
      expect(prompt).toContain('execute-plan')
      expect(prompt).toContain('loop-cancel')
      expect(prompt).toContain('unless the user explicitly asks you to')
      expect(prompt).toContain('Never attempt to remove, delete, or clear review findings')
    })

    test('architect prompt requires TDD-aware behavior-first planning', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).toContain('use the `tdd` skill before finalizing')
      expect(prompt).toContain('behavior-first verification through public interfaces')
      expect(prompt).toContain('vertical phases')
      expect(prompt).toContain('targeted failing test')
      expect(prompt).toContain('Do not default to a separate horizontal test-only phase')
    })

    test('auditor-loop agent has stable metadata and primary mode', () => {
      expect(auditorLoopAgent.role).toBe('auditor-loop')
      expect(auditorLoopAgent.id).toBe('opencode-auditor-loop')
      expect(auditorLoopAgent.displayName).toBe('auditor-loop')
      expect(auditorLoopAgent.mode).toBe('primary')
      expect(auditorLoopAgent.hidden).toBe(true)
    })

    test('auditor-loop shares the base auditor exclusions but keeps loop-handoff', () => {
      const loopExcluded = auditorLoopAgent.tools?.exclude ?? []
      const auditorExcluded = auditorAgent.tools?.exclude ?? []
      for (const tool of auditorExcluded) {
        if (tool === 'loop-handoff') continue
        expect(loopExcluded).toContain(tool)
      }
      expect(loopExcluded).not.toContain('loop-handoff')
      expect(auditorExcluded).toContain('loop-handoff')
      expect(loopExcluded).toContain('loop-complete')
    })

    test('auditor-loop prompt extends the base auditor prompt with loop context', () => {
      expect(auditorLoopAgent.systemPrompt).toContain('isolated audit session')
      expect(auditorLoopAgent.systemPrompt).toContain('Loop Audit Context')
      expect(auditorLoopAgent.systemPrompt).toContain('primary agent')
    })

    test('auditor-loop prompt requires conditional, non-overlapping delegation after finding reconciliation', () => {
      const prompt = auditorLoopAgent.systemPrompt
      expect(prompt).toContain('Delegation is optional, never a task checklist')
      expect(prompt).toContain('review-finding flow')
      expect(prompt).toContain('keep the existing review-finding order unchanged')
      expect(prompt).toContain('Zero subtasks is always acceptable')
      expect(prompt).toContain('Never ask multiple subtasks to re-review the entire diff')
      expect(prompt).toContain('independently rerun full verification')
      expect(prompt).toContain('redundant broad rediscovery is prohibited, evidence checking is not')
      expect(prompt).not.toContain('use short-lived Task subtasks')
    })

    test('auditor-loop prompt includes the loop addendum content', () => {
      const prompt = auditorLoopAgent.systemPrompt
      expect(prompt).toContain('<!-- forge-section -->')
      expect(prompt).toContain('loop-handoff')
      expect(prompt).toContain('summary` { done, deviations, followUps }')
      expect(prompt).toContain('never parses your response text')
      expect(prompt.toLowerCase()).toContain('deviation acceptance')
    })

    test('auditor-loop system prompt does not hand-roll a section marker protocol', () => {
      expect(auditorLoopAgent.systemPrompt).not.toContain('<!-- section')
    })

    test('auditor-loop prompt blocks a section on bugs at or before it, uniformly for every section', () => {
      const prompt = auditorLoopAgent.systemPrompt
      expect(prompt).toContain('A clean section means no outstanding bugs at or before it')
      expect(prompt).toContain('attributed to this section or any earlier section')
      expect(prompt).toContain('later, not-yet-started section do not block')
      expect(prompt).toContain('`review-read` returns the current and earlier sections')
      expect(prompt).toContain('Every section, including the last, follows this same rule')
      expect(prompt).toContain('post-action phase')
      expect(prompt).not.toContain('Last open section')
      expect(prompt).not.toContain("Confirm the master plan's top-level Verification commands")
      expect(prompt).not.toContain('Final Audit Rules')
      expect(prompt).not.toContain('Whole-Change Impact Analysis')
      expect(prompt).not.toContain('AUDIT_SCOPE:1')
    })

    test('auditor-loop prompt documents session continuation for same-section retries', () => {
      const prompt = auditorLoopAgent.systemPrompt
      expect(prompt).toContain('**Follow-up turns.**')
      expect(prompt).toContain('possibly stale')
      expect(prompt).toContain('Re-read every changed file')
      expect(prompt).toContain('audit the delta plus anything it affects')
      expect(prompt).toContain('apply to every turn')
      expect(prompt).not.toContain('single-iteration')
      expect(prompt).not.toContain('deleted by the loop runner')
    })

    test('auditor-loop combined prompt does not reference impact-reviewer or a separate impact agent', () => {
      const prompt = auditorLoopAgent.systemPrompt
      expect(prompt).not.toContain('impact-reviewer')
      expect(prompt).not.toMatch(/impact.?agent/i)
    })

    test('composed auditor-loop prompt reuses reliable current-state evidence without unconditional reruns', () => {
      const prompt = buildAgents()['auditor-loop'].systemPrompt
      // Base Verification policy owns evidence reuse: reliable evidence is accepted
      // only when command, outcome, configuration/environment, and code state align.
      expect(prompt).toContain('passing result applicable to the current reviewed state')
      expect(prompt).toContain('exact command')
      expect(prompt).toContain('pass/fail outcome')
      expect(prompt).toContain('relevant configuration or environment')
      expect(prompt).toContain('commit hash alone')
      expect(prompt).toContain('missing, stale, ambiguous, or invalidated')
      // The last open section audit confirms top-level verification through evidence
      // reuse, never an unconditional second full run.
      expect(prompt).not.toContain("Run the master plan's top-level verification commands against the final state")
      // Current-code proof conditions must remain for finding deletion.
      expect(prompt).toContain('current code plus')
      expect(prompt).toContain('reliable verification')
    })

    test('auditor-loop recurring-findings policy demands exact-scenario proof and forbids duplicate-as-update', () => {
      const prompt = auditorLoopAgent.systemPrompt
      expect(prompt).toContain('## Recurring Findings')
      expect(prompt).toContain('open until proven resolved')
      expect(prompt).toContain('exact reported scenario')
      expect(prompt).toContain('passing unrelated command never deletes a finding')
      expect(prompt).toContain('regression coverage')
      expect(prompt).toContain('current code plus reproduced or reliable verification')
      expect(prompt).toContain('Do not blindly rewrite an unchanged finding')
      expect(prompt).toContain('duplicates are not an update mechanism')
      expect(prompt).toContain('stay open')
    })

    test('architect agent retains plan-authoring tools', () => {
      expect(architectAgent.tools?.exclude).not.toContain('plan-write')
      expect(architectAgent.tools?.exclude).not.toContain('plan-edit')
    })

    test('minion agent has stable metadata', () => {
      expect(minionAgent.role).toBe('minion')
      expect(minionAgent.id).toBe('opencode-minion')
      expect(minionAgent.displayName).toBe('minion')
      expect(minionAgent.mode).toBe('subagent')
      expect(minionAgent.description).toContain('batches of up to four')
    })

    test('minion agent replaces the default prompt with a full system prompt', () => {
      const prompt = minionAgent.systemPrompt ?? ''
      expect(minionAgent.systemPrompt).toBeDefined()
      expect(minionAgent.systemAddendum).toBeUndefined()
      expect(prompt).toContain('You are Minion')
      expect(prompt).toContain('Preserve unrelated worktree changes: leave every file outside your scope')
      expect(prompt).not.toContain('Other work is in progress')
    })

    test('minion agent excludes plan, loop, review, question, and nested subagent tools', () => {
      const excluded = minionAgent.tools?.exclude ?? []
      for (const tool of [
        'plan-write',
        'plan-edit',
        'execute-plan',
        'question',
        'loop-cancel',
        'loop-status',
        'loop-handoff',
        'loop-complete',
        'review-write',
        'review-delete',
        'task',
      ]) {
        expect(excluded).toContain(tool)
      }
    })

    test('minion agent runs on the configured execution model and variant', () => {
      const configured = buildAgents(undefined, { model: 'p/m', variant: 'max' }).minion
      expect(configured.defaultModel).toBe('p/m')
      expect(configured.variant).toBe('max')

      const unconfigured = buildAgents().minion
      expect(unconfigured.defaultModel).toBeUndefined()
      expect(unconfigured.variant).toBeUndefined()

      const variantOnly = buildAgents(undefined, { variant: 'max' }).minion
      expect(variantOnly.variant).toBeUndefined()
    })

    test('buildAgents returns all 5 agent roles', () => {
      const agents = buildAgents()
      const roles = Object.keys(agents)
      expect(roles).toHaveLength(5)
      expect(roles).toContain('code')
      expect(roles).toContain('architect')
      expect(roles).toContain('auditor')
      expect(roles).toContain('auditor-loop')
      expect(roles).toContain('minion')
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
      expect(prompt).toContain('exactly one')
      expect(prompt).toContain('immediately before')
      expect(prompt).toContain('## Phase')
      expect(prompt).toContain('and nowhere else')
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

    test('architect.systemPrompt defines the stored-plan workflow and verification boundary', () => {
      const prompt = architectAgent.systemPrompt
      for (const contract of [
        'source-backed',
        'Restate the requested goal in chat',
        'the intended outcome',
        'scope boundaries',
        'do not emit the full plan',
        '`plan-read`',
        '`plan-write`',
        '`plan-edit`',
        'use `plan-read` like Read',
        '`plan-edit` like Edit',
        'one phase or a small related phase group per call',
        'Do not send the entire multi-phase plan in one tool call',
        'at most 24 executable phases',
        'repository-mandated full check',
        'final report is warning-free',
      ]) {
        expect(prompt).toContain(contract)
      }
      expect(prompt).toContain('repo-relative paths')
      expect(prompt).not.toContain('Do NOT use `pnpm build`')
      expect(prompt).not.toContain('marked plan')
      expect(prompt).not.toContain('<!-- forge-plan:start -->')
      expect(prompt).not.toContain('<!-- forge-plan:end -->')
    })

    test('architect prompt requires source-backed impact planning contracts', () => {
      const prompt = architectAgent.systemPrompt
      for (const contract of [
        'existing helpers, utilities, types, constants, and platform features',
        'all callers and references',
        'Name the one existing or planned owner for each shared behavior',
        'prohibit parallel implementations across phases',
        'every affected caller and companion update',
        'every obsolete or superseded code path to remove, with exact files/symbols',
        'never a vague "update related code"',
        'callers converge on the single point of truth',
        'targeted reference/search assertions',
        'searching for a stale symbol',
        'current repository directory as the complete execution boundary',
        'execution sandbox will not expose them',
        'unattended coding agent inside an isolated sandbox',
        'Docker for local services',
        '`chromium` headless browser (Playwright)',
        'Not available: host environment variables, API keys, credentials, secrets, cloud or SaaS accounts',
        'authenticates to or mutates a system outside the sandbox',
        'applying Terraform or other infrastructure-as-code against a cloud provider',
        'never as an acceptance criterion or verification command',
        'Never include manual checks or commands that depend on external services, credentials, or host environment variables',
      ]) {
        expect(prompt).toContain(contract)
      }
      expect(prompt).not.toContain('unless the task explicitly requires them')
      expect(prompt).not.toContain('unless explicitly required')
    })

    test('architect.systemPrompt concludes without dispatching execution', () => {
      const prompt = architectAgent.systemPrompt
      expect(prompt).toContain('summarizing the plan in chat')
      expect(prompt).toContain('do not emit the full plan')
      expect(prompt).toContain('do not call `execute-plan`')
      expect(prompt).toContain('do not ask how to launch')
      expect(prompt).toContain('The user decides whether and how to execute')
      expect(prompt).not.toContain('"New session", "Execute here", and "Loop"')
      expect(prompt).not.toContain('uses the stored plan automatically')
    })

    test('architect.systemPrompt narrows the goal with grouped question rounds after research', () => {
      const prompt = architectAgent.systemPrompt
      for (const contract of [
        '**Capture the goal**',
        '**Narrow**',
        'Always, before designing, call the `question` tool',
        'one grouped set of questions that settles the route',
        'one question per decision group',
        'Make no silent route decisions',
        'repeat until every route decision is settled',
        '`(Recommended)`',
        'record every route decision with its source',
        'do not call the `question` tool again',
      ]) {
        expect(prompt).toContain(contract)
      }
      expect(prompt.indexOf('**Research**')).toBeLessThan(prompt.indexOf('**Narrow**'))
      expect(prompt.indexOf('**Narrow**')).toBeLessThan(prompt.indexOf('**Design**'))
    })
  })

  describe('agent prompt hygiene', () => {
    test('prompts do not contain legacy graph tool names', () => {
      expect(architectAgent.systemPrompt).not.toContain('graph-query')
      expect(architectAgent.systemPrompt).not.toContain('graph-symbols')
      expect(architectAgent.systemPrompt).not.toContain('graph-analyze')
      expect(codeAgent.systemAddendum).not.toContain('graph-query')
      expect(codeAgent.systemAddendum).not.toContain('graph-symbols')
      expect(codeAgent.systemAddendum).not.toContain('graph-analyze')
      expect(auditorAgent.systemPrompt).not.toContain('graph-query')
      expect(auditorAgent.systemPrompt).not.toContain('graph-symbols')
      expect(auditorAgent.systemPrompt).not.toContain('graph-analyze')
    })

    test('agent prompts avoid deprecated graph tooling names', () => {
      for (const agent of [architectAgent, auditorAgent, auditorLoopAgent, minionAgent]) {
        expect(agent.systemPrompt).not.toContain('graph-query')
        expect(agent.systemPrompt).not.toContain('graph-symbols')
        expect(agent.systemPrompt).not.toContain('graph-analyze')
      }
    })
  })
})
