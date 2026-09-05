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
import { CODER_DECISIONS_START_MARKER } from '../../src/utils/coder-decisions'
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
    getSectionPlan: (_state, index) => makeSectionPlanRow(index, `Section ${index + 1}`, `Section plan for ${index + 1}`),
    getSectionPlans: () => [],
    getCompletedSectionDigest: () => [],
    getCoderDecisions: () => null,
    getFindingRecurrence: () => new Map(),
    ...overrides,
  }
}

function makeSectionPlanRow(index: number, title: string, content: string) {
  return {
    projectId: 'p', loopName: 'test-loop', sectionIndex: index, title, content,
    status: 'pending' as const, attempts: 0,
    summaryDone: null, summaryDeviations: null, summaryFollowUps: null,
    startedAt: null, completedAt: null, createdAt: Date.now(),
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
          { file: 'src/foo.ts', line: 10, severity: 'bug', description: 'Missing null check on user input', scenario: null, loopName: 'test-loop', sectionIndex: null, projectId: 'p', createdAt: 0 },
          { file: 'src/bar.ts', line: 20, severity: 'warning', description: 'Unhandled promise rejection', scenario: 'called without await', loopName: 'test-loop', sectionIndex: null, projectId: 'p', createdAt: 0 },
        ],
      })
      const result = buildContinuationPrompt(ctx, { ...defaultState })
      expect(result).toContain('## Outstanding review findings (2)')
      expect(result).toContain('These block loop completion')
      expect(result).toContain('`src/foo.ts:10` (bug)')
      expect(result).toContain('  - Description: Missing null check on user input')
      expect(result).toContain('`src/bar.ts:20` (warning)')
      expect(result).toContain('  - Description: Unhandled promise rejection')
      expect(result).toContain('  - Scenario: called without await')
      expect(result).not.toContain('Auditor feedback from previous attempt')
    })

    test('continuation with runtime notice renders under ## Loop notice', () => {
      const ctx = makeCtx()
      const result = buildContinuationPrompt(ctx, { ...defaultState }, 'Fix the bug!'.replace('Fix the bug!', 'Auditor session could not run; retrying.'))
      expect(result).toContain('## Loop notice')
      expect(result).toContain('Auditor session could not run; retrying.')
      expect(result).not.toContain('code auditor reviewed your changes')
      expect(result).not.toContain('Auditor feedback from previous attempt')
    })

    test('sectioned continuation delegates to buildSectionContinuationPrompt', () => {
      const ctx = makeCtx()
      const result = buildContinuationPrompt(ctx, { ...sectionState }, 'Auditor session could not run; retrying.')
      expect(result).toContain('[Loop section 1/2 -- iteration 1/5 (continuation)]')
      expect(result).toContain('## Loop notice')
      expect(result).toContain('Auditor session could not run; retrying.')
      expect(result).not.toContain('Auditor feedback from previous attempt')
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
      expect(result).toContain('Use review-read to load the existing findings for this loop.')
      expect(result).toContain('For each existing finding, verify whether it has been resolved')
      expect(result).not.toContain('Existing review findings:')
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
      expect(result).toContain('never an automatic waiver')
      expect(result).toContain('specific scenario and acceptance criterion')
    })

    test('omits coder decisions block when null (non-section)', () => {
      const ctx = makeCtx()
      const result = buildAuditPrompt(ctx, { ...defaultState, iteration: 2 })
      expect(result).not.toContain('Coder decisions & verification notes')
      expect(result).not.toContain('never an automatic waiver')
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

    test('section audit instructs exact 0-based next-section read when a next section exists', () => {
      const ctx = makeCtx()
      const result = buildSectionAuditPrompt(ctx, { ...sectionState, totalSections: 3, currentSectionIndex: 1 })
      expect(result).toContain('run the proactive next-section check')
      expect(result).toContain('call `section-read` with `section_index: 2`')
      expect(result).not.toContain('skip the proactive next-section check')
    })

    test('section audit on the last section explicitly skips the proactive next-section check', () => {
      const ctx = makeCtx()
      const result = buildSectionAuditPrompt(ctx, { ...sectionState, totalSections: 2, currentSectionIndex: 1 })
      expect(result).toContain('this is the last section, so skip the proactive next-section check')
      expect(result).not.toContain('`section-read` with `section_index:')
    })

    test('section audit rewrites plan-adjust guidance without implying the objective shifts', () => {
      const ctx = makeCtx()
      const result = buildSectionAuditPrompt(ctx, { ...sectionState })
      expect(result).toContain('unavailable in the final audit')
      expect(result).toContain('stored master plan row is unchanged')
      expect(result).toContain('confirm both with `plan-read`')
      expect(result).toContain('does not enforce this semantically')
      expect(result).toContain('pending_suffix: true')
      expect(result).toContain('omissions delete milestones')
      expect(result).not.toContain('can no longer achieve its objective')
      expect(result).not.toContain('the objective is immutable')
    })
  })

  describe('buildSectionContinuationPrompt', () => {
    test('section prompts keep section content inline and never render the effective-plan block or titles', () => {
      const ctx = makeCtx({
        getSectionPlans: () => [
          makeSectionPlanRow(0, 'Base', 'original instructions'),
          makeSectionPlanRow(1, 'Amended', 'amended live instructions'),
        ],
      })
      expect(buildSectionInitialPrompt(ctx, { ...sectionState })).not.toContain('Effective section plan')
      expect(buildSectionAuditPrompt(ctx, { ...sectionState })).not.toContain('Effective section plan')
      expect(buildSectionContinuationPrompt(ctx, { ...sectionState })).not.toContain('Effective section plan')
      expect(buildSectionInitialPrompt(ctx, { ...sectionState })).not.toContain('Section 1: Base')
    })

    test('section continuation with runtime notice renders under ## Loop notice', () => {
      const ctx = makeCtx()
      const result = buildSectionContinuationPrompt(ctx, { ...sectionState }, 'Please fix the bug.')
      expect(result).toContain('[Loop section 1/2 -- iteration 1/5 (continuation)]')
      expect(result).toContain('## Section plan')
      expect(result).toContain('## Loop notice')
      expect(result).toContain('Please fix the bug.')
      expect(result).not.toContain('Auditor feedback from previous attempt')
    })

    test('section continuation with outstanding findings', () => {
      const findings: ReviewFindingRow[] = [
        { file: 'src/index.ts', line: 5, severity: 'bug', description: 'Bug in code', scenario: null, loopName: 'test-loop', sectionIndex: 0, projectId: 'p', createdAt: 0 },
      ]
      const ctx = makeCtx({
        getOutstandingFindings: (_loopName, severity) => severity === 'bug' ? findings : [],
      })
      const result = buildSectionContinuationPrompt(ctx, { ...sectionState }, '')
      expect(result).toContain('## Outstanding review findings (1)')
      expect(result).toContain('`src/index.ts:5` (bug)')
      expect(result).toContain('  - Description: Bug in code')
      expect(result).not.toContain('## Outstanding findings')
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

    test('final audit includes the effective ordered section plan after the Master Plan', () => {
      const ctx = makeCtx({
        getSectionPlans: () => [
          makeSectionPlanRow(0, 'Base', 'original instructions'),
          makeSectionPlanRow(1, 'Amended', 'amended live instructions'),
        ],
      })
      const result = buildFinalAuditPrompt(ctx, { ...sectionState })
      const masterPos = result.indexOf('## Master Plan')
      const effectivePos = result.indexOf('## Effective section plan')
      expect(effectivePos).toBeGreaterThan(masterPos)
      expect(result).toContain('supersede the master plan\'s original per-section instructions')
      expect(result).toContain('master objective and top-level Verification remain authoritative')
      expect(result).toContain('Titles are display labels')
      expect(result).toContain('### Section 2 (index 1): Amended')
      expect(result).toContain('amended live instructions')
      expect(result).toContain('verify the requirements in the Effective section plan')
    })

    test('final audit omits the effective section plan when no section rows exist', () => {
      const ctx = makeCtx()
      const result = buildFinalAuditPrompt(ctx, { ...sectionState })
      expect(result).not.toContain('Effective section plan')
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
    test('includes plan and fix instructions without findings block when none outstanding', () => {
      const ctx = makeCtx()
      const result = buildFinalAuditFixPrompt(ctx, { ...sectionState })
      expect(result).toContain('[Final-audit fix -- iteration 1/5]')
      expect(result).toContain('## Master Plan')
      expect(result).toContain('Mock plan content')
      expect(result).toContain('Fix the reported bugs')
      expect(result).toContain('Scope your changes to what the findings require')
      expect(result).not.toContain('## Final auditor feedback')
      expect(result).not.toContain('## Outstanding review findings')
    })

    test('includes the effective ordered section plan after the Master Plan', () => {
      const ctx = makeCtx({
        getSectionPlans: () => [
          makeSectionPlanRow(0, 'Base', 'original instructions'),
          makeSectionPlanRow(1, 'Amended', 'amended live instructions'),
        ],
      })
      const result = buildFinalAuditFixPrompt(ctx, { ...sectionState })
      const masterPos = result.indexOf('## Master Plan')
      const effectivePos = result.indexOf('## Effective section plan')
      expect(effectivePos).toBeGreaterThan(masterPos)
      expect(result).toContain('supersede the master plan\'s original per-section instructions')
      expect(result).toContain('master objective and top-level Verification remain authoritative')
      expect(result).toContain('### Section 2 (index 1): Amended')
      expect(result).toContain('amended live instructions')
    })

    test('omits the effective section plan when no section rows exist', () => {
      const ctx = makeCtx()
      const result = buildFinalAuditFixPrompt(ctx, { ...sectionState })
      expect(result).not.toContain('Effective section plan')
    })

    test('lists outstanding bug findings', () => {
      const findings: ReviewFindingRow[] = [
        { file: 'src/a.ts', line: 12, severity: 'bug', description: 'A', scenario: null, loopName: 'test-loop', sectionIndex: 0, projectId: 'p', createdAt: 0 },
        { file: 'src/b.ts', line: 34, severity: 'bug', description: 'B', scenario: null, loopName: 'test-loop', sectionIndex: 1, projectId: 'p', createdAt: 0 },
      ]
      const ctx = makeCtx({
        getOutstandingFindings: (_loopName, severity) => severity === 'bug' ? findings : [],
      })
      const result = buildFinalAuditFixPrompt(ctx, { ...sectionState })
      expect(result).toContain('## Outstanding review findings (2)')
      expect(result).toContain('`src/a.ts:12` (bug)')
      expect(result).toContain('`src/b.ts:34` (bug)')
      expect(result).not.toContain('## Final auditor feedback')
    })

    test('omits outstanding-findings section when there are none', () => {
      const ctx = makeCtx({
        getOutstandingFindings: () => [],
      })
      const result = buildFinalAuditFixPrompt(ctx, { ...sectionState })
      expect(result).not.toContain('## Outstanding review findings')
    })

    test('states the real re-audit contract instead of promising an entire-codebase re-run', () => {
      const ctx = makeCtx()
      const result = buildFinalAuditFixPrompt(ctx, { ...sectionState })
      expect(result).toContain("the loop's full accumulated changes")
      expect(result).toContain('merge-base')
      expect(result).toContain('all uncommitted and untracked changes')
      expect(result).toContain('affected integration paths')
      expect(result).not.toContain('entire codebase')
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

    test('continuation renders runtime notice under ## Loop notice', () => {
      const ctx = makeCtx()
      const result = buildContinuationPrompt(ctx, { ...goalState }, 'Auditor session could not run; retrying.')
      expect(result).toContain('## Goal')
      expect(result).toContain(goalState.goal)
      expect(result).toContain('## Loop notice')
      expect(result).toContain('Auditor session could not run; retrying.')
      expect(result).not.toContain('code auditor reviewed your changes')
      expect(result).not.toContain('## Auditor feedback from previous attempt')
      expect(result).not.toContain('Fix them directly without creating a plan or asking for approval')
    })

    test('continuation lists outstanding review findings blocking completion', () => {
      const ctx = makeCtx({
        getOutstandingFindings: () => [
          { file: 'src/health.ts', line: 12, severity: 'bug', description: 'Missing null check', scenario: null, loopName: 'test-loop', sectionIndex: null, projectId: 'p', createdAt: 0 },
        ],
      })
      const result = buildContinuationPrompt(ctx, { ...goalState })
      expect(result).toContain('## Outstanding review findings (1)')
      expect(result).toContain('These block loop completion')
      expect(result).toContain('`src/health.ts:12` (bug)')
      expect(result).toContain('  - Description: Missing null check')
      expect(result).not.toContain('Outstanding Review Findings')
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
      expect(result).toContain('Use review-read to load the existing findings for this loop.')
      expect(result).toContain('For each existing finding, verify whether it has been resolved. Delete resolved findings with review-delete and keep any unresolved finding that still applies.')
      expect(result).not.toContain('Existing review findings:')
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
      expect(result).toContain('never an automatic waiver')
      expect(result).toContain('specific scenario and acceptance criterion')
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

  describe('reproduction-first remediation policy (shared outstanding-findings block)', () => {
    const bug = (file: string, line: number, description: string, sectionIndex: number | null = null): ReviewFindingRow => ({
      file, line, severity: 'bug', description, scenario: null, loopName: 'test-loop', sectionIndex, projectId: 'p', createdAt: 0,
    })

    const POLICY_ASSERTIONS = [
      'Read every finding',
      'shared root causes',
      'dependency order',
      'through one owner',
      'one implementation owner',
      'failing test or reproducer through the affected public interface',
      'smallest complete fix',
      'ordering, competing operations, or repeated delivery',
      'concrete source or contract evidence',
      'targeted verification after each root-cause fix',
      'full checks once after the fix batch',
      'coder-decisions block',
      'Never delete findings',
    ]

    function expectReproductionFirstPolicy(prompt: string) {
      for (const fragment of POLICY_ASSERTIONS) {
        expect(prompt).toContain(fragment)
      }
    }

    test('final fix with section-owned and cross-section bugs renders the shared policy and every finding', () => {
      const findings = [
        bug('src/a.ts', 12, 'A'),
        bug('src/b.ts', 34, 'B', 1),
        bug('src/c.ts', 7, 'C'),
      ]
      const ctx = makeCtx({
        getOutstandingFindings: (_loopName, severity) => severity === 'bug' ? findings : [],
      })
      const result = buildFinalAuditFixPrompt(ctx, { ...sectionState, totalSections: 2 })
      expect(result).toContain('## Outstanding review findings (3)')
      for (const f of findings) expect(result).toContain(`\`${f.file}:${f.line}\` (bug)`)
      expectReproductionFirstPolicy(result)
    })

    test('final fix prefers the explicit outstandingBugs input over the repository lookup', () => {
      const repoFindings = [bug('src/repo.ts', 1, 'repo')]
      const explicit = [bug('src/explicit.ts', 2, 'explicit'), bug('src/explicit.ts', 3, 'explicit two')]
      const ctx = makeCtx({ getOutstandingFindings: () => repoFindings })
      const result = buildFinalAuditFixPrompt(ctx, { ...sectionState }, explicit)
      expect(result).toContain('## Outstanding review findings (2)')
      expect(result).toContain('`src/explicit.ts:2` (bug)')
      expect(result).toContain('`src/explicit.ts:3` (bug)')
      expect(result).not.toContain('src/repo.ts')
      expectReproductionFirstPolicy(result)
    })

    test('legacy continuation renders the shared policy alongside the findings', () => {
      const ctx = makeCtx({
        getOutstandingFindings: () => [bug('src/legacy.ts', 4, 'legacy')],
      })
      const result = buildContinuationPrompt(ctx, { ...defaultState })
      expectReproductionFirstPolicy(result)
      expect(result).toContain('`src/legacy.ts:4` (bug)')
    })

    test('section continuation renders the shared policy for section-owned findings', () => {
      const ctx = makeCtx({
        getOutstandingFindings: (_loopName, severity) => severity === 'bug' ? [bug('src/sec.ts', 9, 'sec', 0)] : [],
      })
      const result = buildSectionContinuationPrompt(ctx, { ...sectionState }, '')
      expectReproductionFirstPolicy(result)
      expect(result).toContain('`src/sec.ts:9` (bug)')
    })

    test('goal continuation renders the shared policy alongside the findings', () => {
      const ctx = makeCtx({
        getOutstandingFindings: () => [bug('src/goal.ts', 2, 'goal')],
      })
      const result = buildContinuationPrompt(ctx, { ...goalState })
      expectReproductionFirstPolicy(result)
      expect(result).toContain('`src/goal.ts:2` (bug)')
    })

    test('no findings renders neither the block nor the policy', () => {
      const ctx = makeCtx()
      expect(buildFinalAuditFixPrompt(ctx, { ...sectionState })).not.toContain('Remediation policy')
      expect(buildContinuationPrompt(ctx, { ...defaultState })).not.toContain('Remediation policy')
      expect(buildSectionContinuationPrompt(ctx, { ...sectionState }, '')).not.toContain('Remediation policy')
    })
  })

  describe('recurrence escalation diagnostic policy', () => {
    function ctxWithRecurrence(count: number) {
      const findings: ReviewFindingRow[] = [
        { file: 'src/bug.ts', line: 5, severity: 'bug', description: 'Recurring bug', scenario: null, loopName: 'test-loop', sectionIndex: null, projectId: 'p', createdAt: 0 },
      ]
      return makeCtx({
        getOutstandingFindings: (_loopName, severity) => severity === 'bug' ? findings : [],
        getFindingRecurrence: () => new Map([['x:src/bug.ts:5', count]]),
      })
    }

    test('at threshold the coder block demands a revisited causal hypothesis and a reproducer', () => {
      const result = buildFinalAuditFixPrompt(ctxWithRecurrence(3), { ...sectionState })
      expect(result).toContain('Recurring blocking findings')
      expect(result).toContain('`src/bug.ts:5`')
      expect(result).toContain('recurred 3×')
      expect(result).toContain('revisit the causal hypothesis')
      expect(result).toContain('reproducer or counterexample')
      expect(result).toContain('Do not repeat the previous patch')
    })

    test('below threshold the coder escalation block is absent', () => {
      const result = buildFinalAuditFixPrompt(ctxWithRecurrence(2), { ...sectionState })
      expect(result).not.toContain('Recurring blocking findings')
      expect(result).not.toContain('revisit the causal hypothesis')
    })

    test('escalation changes the requested diagnostic method only, not gates or authority', () => {
      const withRecurrence = buildFinalAuditFixPrompt(ctxWithRecurrence(3), { ...sectionState })
      const withoutRecurrence = buildFinalAuditFixPrompt(makeCtx(), { ...sectionState })
      for (const result of [withRecurrence, withoutRecurrence]) {
        expect(result).not.toContain('review-delete')
        expect(result).toContain('coder-decisions:start')
        expect(result).toContain('Fix the reported bugs')
      }
      expect(withRecurrence).toContain('Recurring blocking findings')
      expect(withoutRecurrence).not.toContain('Recurring blocking findings')
    })

    test('at threshold the auditor block renders locations and counts and defers policy to the addendum', () => {
      const result = buildAuditPrompt(ctxWithRecurrence(3), { ...defaultState, iteration: 2 })
      expect(result).toContain('Recurring findings — re-evaluate')
      expect(result).toContain('Recurring Findings policy')
      expect(result).toContain('`src/bug.ts:5` (3×)')
      expect(result).not.toContain('genuinely, verifiably still broken')
      expect(result).not.toContain('DELETE it with review-delete')
    })
  })

  describe('coder decisions template consumers and auditor renderer', () => {
    const startMarkerCount = (text: string) => text.split(CODER_DECISIONS_START_MARKER).length - 1

    test('all five coder consumers retain exactly one decisions block with the evidence template', () => {
      const ctx = makeCtx()
      const goalCoding = buildContinuationPrompt(ctx, { ...goalState })
      const legacyContinuation = buildContinuationPrompt(ctx, { ...defaultState })
      const sectionInitial = buildSectionInitialPrompt(ctx, { ...sectionState })
      const sectionContinuation = buildSectionContinuationPrompt(ctx, { ...sectionState })
      const finalFix = buildFinalAuditFixPrompt(ctx, { ...sectionState })

      for (const [label, prompt] of [
        ['goal coding', goalCoding],
        ['legacy continuation', legacyContinuation],
        ['section initial', sectionInitial],
        ['section continuation', sectionContinuation],
        ['final fix', finalFix],
      ] as const) {
        expect(startMarkerCount(prompt), label).toBe(1)
        expect(prompt, label).toContain('the exact command, the worktree-relative working directory, and the pass/fail/not-run outcome')
        expect(prompt, label).toContain('do not paste credentials or huge logs')
        expect(prompt, label).toContain('whether any source/test/config changes occurred after those commands ran')
        expect(prompt, label).toContain('which regression check covers each fixed finding')
      }
    })

    test('all four auditor paths share the coder decisions renderer and its evidence policy', () => {
      const ctx = makeCtx({
        getCoderDecisions: () => '### Decisions\n- documented choice\n### Verification\n- FOO=bar pnpm test — pass',
      })
      const goalAudit = buildAuditPrompt(ctx, { ...goalState, phase: 'auditing' })
      const legacyAudit = buildAuditPrompt(ctx, { ...defaultState, iteration: 2 })
      const sectionAudit = buildSectionAuditPrompt(ctx, { ...sectionState })
      const finalAudit = buildFinalAuditPrompt(ctx, { ...sectionState })

      for (const [label, prompt] of [
        ['goal audit', goalAudit],
        ['legacy audit', legacyAudit],
        ['section audit', sectionAudit],
        ['final audit', finalAudit],
      ] as const) {
        expect(prompt, label).toContain('Coder decisions & verification notes')
        expect(prompt, label).toContain('never an automatic waiver')
        expect(prompt, label).toContain('current code plus evidence covering its specific scenario and acceptance criterion')
        expect(prompt, label).not.toContain('DELETE that finding with review-delete')
      }
    })

    test('auditor block does not clear findings on a documented choice or an unrelated passing test', () => {
      const ctx = makeCtx({
        getCoderDecisions: () => '### Decisions\n- documented choice\n### Verification\n- FOO=bar pnpm test — pass',
      })
      const result = buildFinalAuditPrompt(ctx, { ...sectionState })
      expect(result).toContain('A documented decision alone, or a different test passing, is not proof')
    })

    test('missing coder decisions provide no evidence and render no waiver language', () => {
      const ctx = makeCtx({ getCoderDecisions: () => null })
      const result = buildFinalAuditPrompt(ctx, { ...sectionState })
      expect(result).not.toContain('Coder decisions & verification notes')
      expect(result).not.toContain('never an automatic waiver')
    })
  })
})
