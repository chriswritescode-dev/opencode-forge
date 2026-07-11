import { describe, test, expect } from 'vitest'
import {
  buildContinuationPrompt,
  buildAuditPrompt,
  buildSectionInitialPrompt,
  buildSectionAuditPrompt,
  buildSectionContinuationPrompt,
  buildFinalAuditPrompt,
  buildFinalAuditFixPrompt,
  buildPostActionPrompt,
} from '../../src/loop/prompts'
import { SECTION_SUMMARY_START_MARKER, SECTION_SUMMARY_END_MARKER } from '../../src/loop/section-summary'
import type { PromptContext, SectionDigestEntry } from '../../src/loop/prompts'
import type { ReviewFindingRow } from '../../src/storage/repos/review-findings-repo'

const defaultState = {
  active: true,
  sessionId: 'session-1',
  loopName: 'test-loop',
  worktreeDir: '/tmp/test-worktree',
  projectDir: '/tmp/project',
  iteration: 1,
  maxIterations: 5,
  startedAt: '2025-01-01T00:00:00Z',
  phase: 'coding' as const,
  errorCount: 0,
  auditCount: 0,
  currentSectionIndex: 0,
  totalSections: 0,
  finalAuditDone: false,
}

const goalState = {
  ...defaultState,
  kind: 'goal' as const,
  goal: 'Add a /health endpoint that returns {"status":"ok"} and a test covering it.',
}

const sectionState = {
  ...defaultState,
  totalSections: 2,
  currentSectionIndex: 0,
}

function makeCtx(overrides?: Partial<PromptContext>): PromptContext {
  return {
    getPlanTextForState: () => 'Mock plan content',
    getOutstandingFindings: () => [],
    formatReviewFindings: () => 'No existing review findings.',
    getSectionPlan: (_state, index) => ({
      projectId: 'p', loopName: _state.loopName, sectionIndex: index,
      title: `Section ${index + 1}`, content: `Section plan for ${index + 1}`,
      status: 'pending' as const, attempts: 0,
      summaryDone: null, summaryDeviations: null, summaryFollowUps: null,
      startedAt: null, completedAt: null, createdAt: Date.now(),
    }),
    getCompletedSectionDigest: () => [],
    getCoderDecisions: () => null,
    getFindingRecurrence: () => new Map(),
    ...overrides,
  }
}

describe('prompt builders (src/loop/prompts)', () => {

  describe('buildContinuationPrompt', () => {
    test('continuation without findings - basic iteration info', () => {
      const ctx = makeCtx()
      const result = buildContinuationPrompt(ctx, { ...defaultState })
      expect(result).toContain('[Loop iteration 1 / 5]')
      expect(result).toContain('coder-decisions:start')
    })

    test('continuation without findings - no max iterations', () => {
      const ctx = makeCtx()
      const result = buildContinuationPrompt(ctx, { ...defaultState, maxIterations: 0 })
      expect(result).toContain('No max iterations set')
    })

    test('continuation with findings', () => {
      const ctx = makeCtx({
        getOutstandingFindings: () => [
          { file: 'src/foo.ts', line: 10, severity: 'bug', description: 'Bug', scenario: null, loopName: 'test-loop', sectionIndex: null, projectId: 'p', createdAt: 0 },
          { file: 'src/bar.ts', line: 20, severity: 'warning', description: 'Warning', scenario: null, loopName: 'test-loop', sectionIndex: null, projectId: 'p', createdAt: 0 },
        ],
      })
      const result = buildContinuationPrompt(ctx, { ...defaultState })
      expect(result).toContain('Outstanding Review Findings (2)')
      expect(result).toContain('`src/foo.ts:10`')
      expect(result).toContain('`src/bar.ts:20`')
    })

    test('continuation with audit findings text', () => {
      const ctx = makeCtx()
      const result = buildContinuationPrompt(ctx, { ...defaultState }, 'Fix the bug!')
      expect(result).toContain('code auditor reviewed your changes')
      expect(result).toContain('Fix the bug!')
    })

    test('sectioned continuation delegates to buildSectionContinuationPrompt', () => {
      const ctx = makeCtx()
      const result = buildContinuationPrompt(ctx, { ...sectionState }, 'Audit feedback')
      expect(result).toContain('[Loop section 1/2 -- iteration 1/5 (continuation)]')
      expect(result).toContain('Auditor feedback from previous attempt')
      expect(result).toContain('Audit feedback')
    })

    test('includes recurring-findings escalation when count >= threshold (coder)', () => {
      const findings: ReviewFindingRow[] = [
        { file: 'src/bug.ts', line: 5, severity: 'bug', description: 'Recurring bug', scenario: null, loopName: 'test-loop', sectionIndex: null, projectId: 'p', createdAt: 0 },
      ]
      const recurrence = new Map<string, number>([['x:src/bug.ts:5', 3]])
      const ctx = makeCtx({
        getOutstandingFindings: (_loopName, severity) => severity === 'bug' ? findings : [],
        getFindingRecurrence: () => recurrence,
      })
      const result = buildContinuationPrompt(ctx, { ...defaultState })
      expect(result).toContain('Recurring blocking findings')
      expect(result).toContain('src/bug.ts:5')
      expect(result).toContain('recurred 3×')
    })

    test('omits recurring-findings escalation when count < threshold', () => {
      const findings: ReviewFindingRow[] = [
        { file: 'src/bug.ts', line: 5, severity: 'bug', description: 'Recurring bug', scenario: null, loopName: 'test-loop', sectionIndex: null, projectId: 'p', createdAt: 0 },
      ]
      const recurrence = new Map<string, number>([['x:src/bug.ts:5', 2]])
      const ctx = makeCtx({
        getOutstandingFindings: (_loopName, severity) => severity === 'bug' ? findings : [],
        getFindingRecurrence: () => recurrence,
      })
      const result = buildContinuationPrompt(ctx, { ...defaultState })
      expect(result).not.toContain('Recurring blocking findings')
    })

    test('omits recurring-findings escalation when no findings', () => {
      const ctx = makeCtx({
        getFindingRecurrence: () => new Map([['x:src/other.ts:1', 5]]),
      })
      const result = buildContinuationPrompt(ctx, { ...defaultState })
      expect(result).not.toContain('Recurring blocking findings')
    })
  })

  describe('buildAuditPrompt', () => {
    test('non-sectioned audit prompt', () => {
      const ctx = makeCtx()
      const result = buildAuditPrompt(ctx, { ...defaultState, iteration: 2 })
      expect(result).toContain('Post-iteration 2 code review')
      expect(result).toContain('Implementation plan:')
      expect(result).toContain('Mock plan content')
      expect(result).toContain('Existing review findings:')
      expect(result).toContain('Plan completeness check:')
    })

    test('non-sectioned audit with branch info', () => {
      const ctx = makeCtx()
      const result = buildAuditPrompt(ctx, { ...defaultState, worktreeBranch: 'main' })
      expect(result).toContain('(branch: main)')
    })

    test('sectioned audit delegates to section audit', () => {
      const ctx = makeCtx()
      const result = buildAuditPrompt(ctx, { ...sectionState, phase: 'auditing' })
      expect(result).toContain('[Loop section audit 1/2]')
      expect(result).toContain('Section under audit')
      expect(result).toContain(SECTION_SUMMARY_START_MARKER)
      expect(result).toContain(SECTION_SUMMARY_END_MARKER)
    })

    test('final-auditing phase delegates to final audit', () => {
      const ctx = makeCtx()
      const result = buildAuditPrompt(ctx, { ...sectionState, phase: 'final_auditing' })
      expect(result).toContain('[Final integration audit]')
    })

    test('includes coder decisions block when present (non-section)', () => {
      const ctx = makeCtx({
        getCoderDecisions: () => '### Decisions\n- Chose X over Y\n### Verification\n- `pnpm test`\n### Notes\n- None',
      })
      const result = buildAuditPrompt(ctx, { ...defaultState, iteration: 2 })
      expect(result).toContain('Coder decisions & verification notes')
      expect(result).toContain('Chose X over Y')
      expect(result).toContain('DELETE that finding with review-delete')
    })

    test('omits coder decisions block when null (non-section)', () => {
      const ctx = makeCtx()
      const result = buildAuditPrompt(ctx, { ...defaultState, iteration: 2 })
      expect(result).not.toContain('Coder decisions & verification notes')
      expect(result).not.toContain('DELETE that finding with review-delete')
    })

    test('includes recurring-findings escalation when count >= threshold (auditor)', () => {
      const findings: ReviewFindingRow[] = [
        { file: 'src/bug.ts', line: 5, severity: 'bug', description: 'Recurring bug', scenario: null, loopName: 'test-loop', sectionIndex: null, projectId: 'p', createdAt: 0 },
      ]
      const recurrence = new Map<string, number>([['x:src/bug.ts:5', 3]])
      const ctx = makeCtx({
        getOutstandingFindings: (_loopName, severity) => severity === 'bug' ? findings : [],
        getFindingRecurrence: () => recurrence,
      })
      const result = buildAuditPrompt(ctx, { ...defaultState, iteration: 2 })
      expect(result).toContain('Recurring findings — re-evaluate')
      expect(result).toContain('src/bug.ts:5')
    })

    test('omits recurring-findings escalation when count < threshold (auditor)', () => {
      const findings: ReviewFindingRow[] = [
        { file: 'src/bug.ts', line: 5, severity: 'bug', description: 'Recurring bug', scenario: null, loopName: 'test-loop', sectionIndex: null, projectId: 'p', createdAt: 0 },
      ]
      const recurrence = new Map<string, number>([['x:src/bug.ts:5', 2]])
      const ctx = makeCtx({
        getOutstandingFindings: (_loopName, severity) => severity === 'bug' ? findings : [],
        getFindingRecurrence: () => recurrence,
      })
      const result = buildAuditPrompt(ctx, { ...defaultState, iteration: 2 })
      expect(result).not.toContain('Recurring findings — re-evaluate')
    })
  })

  describe('buildSectionInitialPrompt', () => {
    test('section initial with no prior sections', () => {
      const ctx = makeCtx()
      const result = buildSectionInitialPrompt(ctx, { ...sectionState })
      expect(result).toContain('[Loop section 1/2 -- iteration 1/5]')
      expect(result).toContain('## Section plan')
      expect(result).toContain('Section plan for 1')
    })

    test('section initial with prior sections digest', () => {
      const ctx = makeCtx({
        getCompletedSectionDigest: (): SectionDigestEntry[] => [
          { index: 0, title: 'First section', summaryDone: 'Done something', summaryDeviations: 'none', summaryFollowUps: 'deferred to s2' },
        ],
      })
      const state = { ...sectionState, currentSectionIndex: 1 }
      const result = buildSectionInitialPrompt(ctx, state)
      expect(result).toContain('[Loop section 2/2 -- iteration 1/5]')
      expect(result).toContain("Prior Sections' Summaries")
      expect(result).toContain('## Section 1: First section')
      expect(result).toContain('### Done\nDone something')
      expect(result).toContain('### Deviations\nnone')
      expect(result).toContain('### Follow-ups\ndeferred to s2')
    })
  })

  describe('buildSectionAuditPrompt', () => {
    test('section audit without prior sections', () => {
      const ctx = makeCtx()
      const result = buildSectionAuditPrompt(ctx, { ...sectionState })
      expect(result).toContain('[Loop section audit 1/2]')
      expect(result).toContain('## Section under audit')
      expect(result).toContain('Section plan for 1')
      expect(result).toContain('Audit instructions:')
      expect(result).toContain(SECTION_SUMMARY_START_MARKER)
      expect(result).toContain(SECTION_SUMMARY_END_MARKER)
    })

    test('section audit with prior sections digest', () => {
      const ctx = makeCtx({
        getCompletedSectionDigest: (): SectionDigestEntry[] => [
          { index: 0, title: 'Previous', summaryDone: 'Completed', summaryDeviations: 'None', summaryFollowUps: 'none' },
        ],
      })
      const result = buildSectionAuditPrompt(ctx, { ...sectionState })
      expect(result).toContain("Prior Sections' Summaries")
      expect(result).toContain('## Section 1: Previous')
      expect(result).toContain('### Done\nCompleted')
    })

    test('section audit includes coder decisions block when present', () => {
      const ctx = makeCtx({
        getCoderDecisions: () => '### Decisions\n- Used caching',
      })
      const result = buildSectionAuditPrompt(ctx, { ...sectionState })
      expect(result).toContain('Coder decisions & verification notes')
      expect(result).toContain('Used caching')
    })

    test('section audit omits coder decisions block when null', () => {
      const ctx = makeCtx()
      const result = buildSectionAuditPrompt(ctx, { ...sectionState })
      expect(result).not.toContain('Coder decisions & verification notes')
    })
  })

  describe('buildSectionContinuationPrompt', () => {
    test('section continuation with audit feedback', () => {
      const ctx = makeCtx()
      const result = buildSectionContinuationPrompt(ctx, { ...sectionState }, 'Please fix the bug.')
      expect(result).toContain('[Loop section 1/2 -- iteration 1/5 (continuation)]')
      expect(result).toContain('## Section plan')
      expect(result).toContain('Auditor feedback from previous attempt')
      expect(result).toContain('Please fix the bug.')
    })

    test('section continuation with outstanding findings', () => {
      const findings: ReviewFindingRow[] = [
        { file: 'src/index.ts', line: 5, severity: 'bug', description: 'Bug in code', scenario: null, loopName: 'test-loop', sectionIndex: 0, projectId: 'p', createdAt: 0 },
      ]
      const ctx = makeCtx({
        getOutstandingFindings: (_loopName, severity) => severity === 'bug' ? findings : [],
      })
      const result = buildSectionContinuationPrompt(ctx, { ...sectionState }, '')
      expect(result).toContain('## Outstanding findings')
      expect(result).toContain('`src/index.ts:5`')
    })

    test('section continuation filters by sectionIndex', () => {
      const findings: ReviewFindingRow[] = [
        { file: 'src/a.ts', line: 1, severity: 'bug', description: 'A', scenario: null, loopName: 'test-loop', sectionIndex: 0, projectId: 'p', createdAt: 0 },
        { file: 'src/b.ts', line: 2, severity: 'bug', description: 'B', scenario: null, loopName: 'test-loop', sectionIndex: 1, projectId: 'p', createdAt: 0 },
      ]
      const ctx = makeCtx({
        getOutstandingFindings: (_loopName, severity) => severity === 'bug' ? findings : [],
      })
      const result = buildSectionContinuationPrompt(ctx, { ...sectionState }, '')
      expect(result).toContain('`src/a.ts:1`')
      expect(result).not.toContain('`src/b.ts:2`')
    })
  })

  describe('buildFinalAuditPrompt', () => {
    test('final audit includes plan and completion summary', () => {
      const ctx = makeCtx()
      const result = buildFinalAuditPrompt(ctx, { ...sectionState })
      expect(result).toContain('[Final integration audit]')
      expect(result).toContain('Master Plan')
      expect(result).toContain('Mock plan content')
      expect(result).toContain('Final audit instructions')
    })

    test('final audit with completed sections digest', () => {
      const ctx = makeCtx({
        getCompletedSectionDigest: (): SectionDigestEntry[] => [
          { index: 0, title: 'Section A', summaryDone: 'Implemented X', summaryDeviations: 'none', summaryFollowUps: 'none' },
        ],
      })
      const result = buildFinalAuditPrompt(ctx, { ...sectionState })
      expect(result).toContain("Completed Sections' Summaries")
      expect(result).toContain('## Section 1: Section A')
      expect(result).toContain('### Done\nImplemented X')
    })

    test('includes coder decisions when present', () => {
      const ctx = makeCtx({
        getCoderDecisions: () => '### Decisions\n- Chose Y\n### Verification\n- FOO=bar pnpm test',
      })
      const result = buildFinalAuditPrompt(ctx, { ...sectionState })
      expect(result).toContain('Coder decisions & verification notes')
      expect(result).toContain('Chose Y')
      expect(result).toContain('FOO=bar pnpm test')
    })

    test('omits coder decisions section when null', () => {
      const ctx = makeCtx({
        getCoderDecisions: () => null,
      })
      const result = buildFinalAuditPrompt(ctx, { ...sectionState })
      expect(result).not.toContain('Coder decisions & verification notes')
    })
  })

  describe('buildPostActionPrompt', () => {
    test('includes skill name, plan, branch, prompt text, and autonomy instruction when skill provided', () => {
      const ctx = makeCtx()
      const state = { ...defaultState, worktreeBranch: 'feat/my-branch', phase: 'post_action' as const }
      const result = buildPostActionPrompt(ctx, state, { skill: 'pr-review', prompt: 'extra notes' })
      expect(result).toContain('[Post-implementation action]')
      expect(result).toContain('## Master Plan')
      expect(result).toContain('Mock plan content')
      expect(result).toContain('pr-review')
      expect(result).toContain('Load the `pr-review` skill with the Skill tool')
      expect(result).toContain('feat/my-branch')
      expect(result).toContain('extra notes')
      expect(result).toContain('do NOT use the question tool')
      expect(result).toContain('Auto-defer any finding')
    })

    test('omits Skill-tool line when no skill is configured but includes prompt and autonomy instruction', () => {
      const ctx = makeCtx()
      const state = { ...defaultState, worktreeBranch: 'feat/my-branch', phase: 'post_action' as const }
      const result = buildPostActionPrompt(ctx, state, { prompt: 'just review' })
      expect(result).toContain('[Post-implementation action]')
      expect(result).toContain('just review')
      expect(result).toContain('do NOT use the question tool')
      expect(result).not.toContain('Load the')
      expect(result).not.toContain('Skill tool')
    })
  })

  describe('buildFinalAuditFixPrompt', () => {
    test('includes plan, audit feedback, and fix instructions', () => {
      const ctx = makeCtx()
      const result = buildFinalAuditFixPrompt(ctx, { ...sectionState }, 'Bug: missing null check at foo.ts:10')
      expect(result).toContain('[Final-audit fix -- iteration 1/5]')
      expect(result).toContain('## Master Plan')
      expect(result).toContain('Mock plan content')
      expect(result).toContain('## Final auditor feedback')
      expect(result).toContain('Bug: missing null check at foo.ts:10')
      expect(result).toContain('Fix the reported bugs')
      expect(result).toContain('Scope your changes to what the findings require')
    })

    test('lists outstanding bug findings', () => {
      const findings: ReviewFindingRow[] = [
        { file: 'src/a.ts', line: 12, severity: 'bug', description: 'A', scenario: null, loopName: 'test-loop', sectionIndex: 0, projectId: 'p', createdAt: 0 },
        { file: 'src/b.ts', line: 34, severity: 'bug', description: 'B', scenario: null, loopName: 'test-loop', sectionIndex: 1, projectId: 'p', createdAt: 0 },
      ]
      const ctx = makeCtx({
        getOutstandingFindings: (_loopName, severity) => severity === 'bug' ? findings : [],
      })
      const result = buildFinalAuditFixPrompt(ctx, { ...sectionState }, 'audit text')
      expect(result).toContain('## Outstanding findings (2)')
      expect(result).toContain('`src/a.ts:12`')
      expect(result).toContain('`src/b.ts:34`')
    })

    test('omits outstanding-findings section when there are none', () => {
      const ctx = makeCtx({
        getOutstandingFindings: () => [],
      })
      const result = buildFinalAuditFixPrompt(ctx, { ...sectionState }, 'audit text')
      expect(result).not.toContain('## Outstanding findings')
    })
  })

  describe('goal-loop prompts', () => {
    test('continuation/recovery restates the exact goal and forbids planning/approval flows', () => {
      const ctx = makeCtx()
      const result = buildContinuationPrompt(ctx, { ...goalState })
      expect(result).toContain('## Goal')
      expect(result).toContain(goalState.goal)
      expect(result).toContain('Implement the goal above directly')
      expect(result).toContain('Do not create a plan, decompose the goal into sections, or ask for approval')
      expect(result).toContain('coder-decisions:start')
      // Goal prompts must not include plan/section machinery
      expect(result).not.toContain('## Master Plan')
      expect(result).not.toContain('## Section plan')
      expect(result).not.toContain('Prior Sections')
      expect(result).not.toContain(SECTION_SUMMARY_START_MARKER)
      expect(result).not.toContain('Implementation plan:')
      expect(result).not.toContain('Plan completeness check:')
    })

    test('continuation includes auditor feedback and requires direct remediation', () => {
      const ctx = makeCtx()
      const result = buildContinuationPrompt(ctx, { ...goalState }, 'Bug: /health returns 500. Fix null check.')
      expect(result).toContain('## Goal')
      expect(result).toContain(goalState.goal)
      expect(result).toContain('code auditor reviewed your changes')
      expect(result).toContain('Bug: /health returns 500. Fix null check.')
      expect(result).toContain('Fix them directly without creating a plan or asking for approval')
    })

    test('continuation lists outstanding review findings blocking completion', () => {
      const ctx = makeCtx({
        getOutstandingFindings: () => [
          { file: 'src/health.ts', line: 12, severity: 'bug', description: 'Missing null check', scenario: null, loopName: 'test-loop', sectionIndex: null, projectId: 'p', createdAt: 0 },
        ],
      })
      const result = buildContinuationPrompt(ctx, { ...goalState })
      expect(result).toContain('Outstanding Review Findings (1)')
      expect(result).toContain('`src/health.ts:12`')
    })

    test('continuation preserves recurring-findings escalation block', () => {
      const findings: ReviewFindingRow[] = [
        { file: 'src/bug.ts', line: 5, severity: 'bug', description: 'Recurring bug', scenario: null, loopName: 'test-loop', sectionIndex: null, projectId: 'p', createdAt: 0 },
      ]
      const recurrence = new Map<string, number>([['x:src/bug.ts:5', 3]])
      const ctx = makeCtx({
        getOutstandingFindings: (_loopName, severity) => severity === 'bug' ? findings : [],
        getFindingRecurrence: () => recurrence,
      })
      const result = buildContinuationPrompt(ctx, { ...goalState })
      expect(result).toContain('Recurring blocking findings')
      expect(result).toContain('src/bug.ts:5')
    })

    test('audit prompt restates the goal, requires both goal completion and correctness', () => {
      const ctx = makeCtx()
      const result = buildAuditPrompt(ctx, { ...goalState, iteration: 2, phase: 'auditing' })
      expect(result).toContain('Post-iteration 2 goal review')
      expect(result).toContain('Goal:')
      expect(result).toContain(goalState.goal)
      expect(result).toContain('Goal completion:')
      expect(result).toContain('Code correctness:')
      expect(result).toContain('Existing review findings:')
    })

    test('audit prompt requires goal-incomplete bug findings on GOAL pseudo-path with line 1', () => {
      const ctx = makeCtx()
      const result = buildAuditPrompt(ctx, { ...goalState, phase: 'auditing' })
      expect(result).toContain('severity: "bug"')
      expect(result).toContain('`GOAL`')
      expect(result).toContain('`line` = 1')
      expect(result).toContain('delete it with review-delete')
      expect(result).toContain('Zero remaining findings authorizes termination')
      expect(result).toContain('Outstanding findings block loop termination')
    })

    test('audit prompt includes coder decisions block when present', () => {
      const ctx = makeCtx({
        getCoderDecisions: () => '### Decisions\n- Used existing route helper\n### Verification\n- `pnpm test`',
      })
      const result = buildAuditPrompt(ctx, { ...goalState, phase: 'auditing' })
      expect(result).toContain('Coder decisions & verification notes')
      expect(result).toContain('Used existing route helper')
      expect(result).toContain('DELETE that finding with review-delete')
    })

    test('audit prompt omits coder decisions block when null', () => {
      const ctx = makeCtx()
      const result = buildAuditPrompt(ctx, { ...goalState, phase: 'auditing' })
      expect(result).not.toContain('Coder decisions & verification notes')
    })

    test('audit prompt omits plan/section/final-audit machinery', () => {
      const ctx = makeCtx()
      const result = buildAuditPrompt(ctx, { ...goalState, phase: 'auditing' })
      expect(result).not.toContain('Implementation plan:')
      expect(result).not.toContain('Plan completeness check:')
      expect(result).not.toContain('## Section')
      expect(result).not.toContain('Section under audit')
      expect(result).not.toContain('Master Plan')
      expect(result).not.toContain('[Final integration audit]')
      expect(result).not.toContain(SECTION_SUMMARY_START_MARKER)
    })

    test('audit prompt includes branch info when present', () => {
      const ctx = makeCtx()
      const result = buildAuditPrompt(ctx, { ...goalState, worktreeBranch: 'goal/health', phase: 'auditing' })
      expect(result).toContain('(branch: goal/health)')
    })

    test('final_auditing phase on a goal loop does not route to final-audit prompt', () => {
      const ctx = makeCtx()
      const result = buildAuditPrompt(ctx, { ...goalState, phase: 'final_auditing' })
      expect(result).toContain('Post-iteration 1 goal review')
      expect(result).not.toContain('[Final integration audit]')
      expect(result).not.toContain('Master Plan')
    })
  })
})
