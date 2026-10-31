import { describe, test, expect, vi } from 'vitest'
import {
  buildContinuationPrompt,
  buildAuditPrompt,
  buildSectionInitialPrompt,
  buildSectionInitialPromptText,
  buildSectionAuditPrompt,
  buildSectionContinuationPrompt,
  buildPostActionPrompt,
  buildAttemptHistoryBlock,
  ATTEMPT_HISTORY_LIMIT,
} from '../../src/loop/prompts'
import { SECTION_SUMMARY_START_MARKER, SECTION_SUMMARY_END_MARKER } from '../../src/loop/section-summary'
import { CODER_DECISIONS_START_MARKER } from '../../src/utils/coder-decisions'
import type { PromptContext, SectionDigestEntry } from '../../src/loop/prompts'
import type { ReviewFindingRow } from '../../src/storage/repos/review-findings-repo'
import type { LoopAttemptRow } from '../../src/storage/repos/loop-attempts-repo'
import { blockingBugFindings } from '../../src/loop/section-scope'

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
}

const sectionState = {
  ...defaultState,
  totalSections: 2,
  currentSectionIndex: 0,
}

function makeCtx(overrides?: Partial<PromptContext>): PromptContext {
  const ctx = {
    getPlanTextForState: () => 'Mock plan content',
    getOutstandingFindings: () => [],
    getSectionPlan: (_state, index) => makeSectionPlanRow(index, `Section ${index + 1}`, `Section plan for ${index + 1}`),
    getSectionPlans: () => [],
    getCompletedSectionDigest: () => [],
    getCoderDecisions: () => null,
    getFindingRecurrence: () => new Map(),
    ...overrides,
  } as PromptContext
  ctx.getBlockingBugFindings ??= (state) => blockingBugFindings(ctx.getOutstandingFindings(state.loopName, 'bug'), state)
  return ctx
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

    test('section audit states the section-wide blocking scope', () => {
      const ctx = makeCtx()
      const result = buildSectionAuditPrompt(ctx, { ...sectionState, totalSections: 3, currentSectionIndex: 1 })
      expect(result).toContain('This section is clean only when this section, every earlier section, and the cross-section findings are free of outstanding bugs')
      expect(result).toContain('Findings attributed to a later, not-yet-started section do not block this audit')
      expect(result).toContain('`review-read` returns exactly that scope')
      expect(result).not.toContain('Last open section:')
    })

    test('section audit rewrites plan-adjust guidance without implying the objective shifts', () => {
      const ctx = makeCtx()
      const result = buildSectionAuditPrompt(ctx, { ...sectionState })
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

    test('section continuation includes earlier-section and cross-section findings, excluding later sections', () => {
      const findings: ReviewFindingRow[] = [
        { file: 'src/a.ts', line: 1, severity: 'bug', description: 'A', scenario: null, loopName: 'test-loop', sectionIndex: 0, projectId: 'p', createdAt: 0 },
        { file: 'src/b.ts', line: 2, severity: 'bug', description: 'B', scenario: null, loopName: 'test-loop', sectionIndex: 1, projectId: 'p', createdAt: 0 },
        { file: 'src/c.ts', line: 3, severity: 'bug', description: 'C', scenario: null, loopName: 'test-loop', sectionIndex: 2, projectId: 'p', createdAt: 0 },
        { file: 'src/d.ts', line: 4, severity: 'bug', description: 'D', scenario: null, loopName: 'test-loop', sectionIndex: null, projectId: 'p', createdAt: 0 },
      ]
      const ctx = makeCtx({
        getOutstandingFindings: (_loopName, severity) => severity === 'bug' ? findings : [],
      })
      const result = buildSectionContinuationPrompt(ctx, { ...sectionState, totalSections: 3, currentSectionIndex: 1 }, '')
      expect(result).toContain('## Outstanding review findings (3)')
      expect(result).toContain('`src/a.ts:1`')
      expect(result).toContain('`src/b.ts:2`')
      expect(result).toContain('`src/d.ts:4`')
      expect(result).not.toContain('`src/c.ts:3`')
    })

    test('section continuation excludes later-section findings', () => {
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

  describe('buildPostActionPrompt', () => {
    test('includes skill name, plan, branch, prompt text, and unattended skill instruction when skill provided', () => {
      const ctx = makeCtx()
      const state = { ...defaultState, worktreeBranch: 'feat/my-branch', phase: 'post_action' as const }
      const result = buildPostActionPrompt(ctx, state, { skill: 'pr-review', prompt: 'extra notes' })
      expect(result).toContain('[Post-implementation action]')
      expect(result).toContain('## Master Plan')
      expect(result).toContain('Mock plan content')
      expect(result).toContain('pr-review')
      expect(result).toContain('Load the `pr-review` skill with the Skill tool')
      expect(result).toContain('unattended or non-interactive mode')
      expect(result).toContain('feat/my-branch')
      expect(result).toContain('extra notes')
      expect(result).toContain('do NOT use the question tool')
      expect(result).toContain('Auto-defer any finding')
      expect(result).not.toContain('Apply only safe, scoped fixes')
    })

    test('omits Skill-tool line when no skill is configured but includes prompt, safe-fix instruction, and question-tool line', () => {
      const ctx = makeCtx()
      const state = { ...defaultState, worktreeBranch: 'feat/my-branch', phase: 'post_action' as const }
      const result = buildPostActionPrompt(ctx, state, { prompt: 'just review' })
      expect(result).toContain('[Post-implementation action]')
      expect(result).toContain('just review')
      expect(result).toContain('Apply only safe, scoped fixes')
      expect(result).toContain('do NOT use the question tool')
      expect(result).not.toContain('Load the')
      expect(result).not.toContain('Skill tool')
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

    test('section continuation renders the shared policy and every blocking finding', () => {
      const findings = [
        bug('src/a.ts', 12, 'A'),
        bug('src/b.ts', 34, 'B', 1),
        bug('src/c.ts', 7, 'C'),
      ]
      const ctx = makeCtx({
        getOutstandingFindings: (_loopName, severity) => severity === 'bug' ? findings : [],
        getBlockingBugFindings: () => findings,
      })
      const result = buildSectionContinuationPrompt(ctx, { ...sectionState, totalSections: 3, currentSectionIndex: 1 }, '')
      expect(result).toContain('## Outstanding review findings (3)')
      for (const f of findings) expect(result).toContain(`\`${f.file}:${f.line}\` (bug)`)
      expectReproductionFirstPolicy(result)
    })

    test('section continuation prefers the explicit outstandingBugs input over the repository lookup', () => {
      const repoFindings = [bug('src/repo.ts', 1, 'repo')]
      const explicit = [bug('src/explicit.ts', 2, 'explicit'), bug('src/explicit.ts', 3, 'explicit two')]
      const ctx = makeCtx({ getOutstandingFindings: () => repoFindings, getBlockingBugFindings: () => repoFindings })
      const result = buildSectionContinuationPrompt(ctx, { ...sectionState }, '', explicit)
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

    test('no findings renders neither the block nor the policy', () => {
      const ctx = makeCtx({ getBlockingBugFindings: () => [] })
      expect(buildSectionContinuationPrompt(ctx, { ...sectionState }, '')).not.toContain('Remediation policy')
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
        getBlockingBugFindings: () => findings,
      })
    }

    test('at threshold the coder block demands a revisited causal hypothesis and a reproducer', () => {
      const result = buildSectionContinuationPrompt(ctxWithRecurrence(3), { ...sectionState }, '')
      expect(result).toContain('Recurring blocking findings')
      expect(result).toContain('`src/bug.ts:5`')
      expect(result).toContain('recurred 3×')
      expect(result).toContain('revisit the causal hypothesis')
      expect(result).toContain('reproducer or counterexample')
      expect(result).toContain('Do not repeat the previous patch')
    })

    test('below threshold the coder escalation block is absent', () => {
      const result = buildSectionContinuationPrompt(ctxWithRecurrence(2), { ...sectionState }, '')
      expect(result).not.toContain('Recurring blocking findings')
      expect(result).not.toContain('revisit the causal hypothesis')
    })

    test('escalation changes the requested diagnostic method only, not gates or authority', () => {
      const withRecurrence = buildSectionContinuationPrompt(ctxWithRecurrence(3), { ...sectionState }, '')
      const withoutRecurrence = buildSectionContinuationPrompt(makeCtx(), { ...sectionState }, '')
      for (const result of [withRecurrence, withoutRecurrence]) {
        expect(result).not.toContain('review-delete')
        expect(result).toContain('coder-decisions:start')
        expect(result).toContain('## Section plan')
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

    test('all three coder consumers retain exactly one decisions block with the evidence template', () => {
      const ctx = makeCtx()
      const legacyContinuation = buildContinuationPrompt(ctx, { ...defaultState })
      const sectionInitial = buildSectionInitialPrompt(ctx, { ...sectionState })
      const sectionContinuation = buildSectionContinuationPrompt(ctx, { ...sectionState })

      for (const [label, prompt] of [
        ['legacy continuation', legacyContinuation],
        ['section initial', sectionInitial],
        ['section continuation', sectionContinuation],
      ] as const) {
        expect(startMarkerCount(prompt), label).toBe(1)
        expect(prompt, label).toContain('the exact command, the worktree-relative working directory, and the pass/fail/not-run outcome')
        expect(prompt, label).toContain('do not paste credentials or huge logs')
        expect(prompt, label).toContain('whether any source/test/config changes occurred after those commands ran')
        expect(prompt, label).toContain('which regression check covers each fixed finding')
      }
    })

    test('both auditor paths share the coder decisions renderer and its evidence policy', () => {
      const ctx = makeCtx({
        getCoderDecisions: () => '### Decisions\n- documented choice\n### Verification\n- FOO=bar pnpm test — pass',
      })
      const legacyAudit = buildAuditPrompt(ctx, { ...defaultState, iteration: 2 })
      const sectionAudit = buildSectionAuditPrompt(ctx, { ...sectionState })

      for (const [label, prompt] of [
        ['legacy audit', legacyAudit],
        ['section audit', sectionAudit],
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
      const result = buildSectionAuditPrompt(ctx, { ...sectionState })
      expect(result).toContain('A documented decision alone, or a different test passing, is not proof')
    })

    test('missing coder decisions provide no evidence and render no waiver language', () => {
      const ctx = makeCtx({ getCoderDecisions: () => null })
      const result = buildSectionAuditPrompt(ctx, { ...sectionState })
      expect(result).not.toContain('Coder decisions & verification notes')
      expect(result).not.toContain('never an automatic waiver')
    })
  })

  describe('attempt history handoff (durable audit attempts)', () => {
    const DELTA_PREV = 'b'.repeat(40)
    const DELTA_CUR = 'a'.repeat(40)
    const LONG_NOTE_BODY = 'y'.repeat(900)

    function makeAttemptRow(overrides: Partial<LoopAttemptRow> & Pick<LoopAttemptRow, 'id' | 'attemptNumber'>): LoopAttemptRow {
      return {
        projectId: 'p',
        loopName: 'test-loop',
        scope: 'section:0',
        sourceSessionId: 'coder-session',
        completionKey: `key-${String(overrides.id)}`,
        auditorSessionId: null,
        iteration: 1,
        worktreeDir: '/tmp/test-worktree',
        planHash: 'plan-hash',
        coderDecisions: null,
        snapshotCommit: null,
        snapshotRef: null,
        previousCommit: null,
        diffSummary: null,
        fallbackReason: null,
        findingsBefore: [],
        findingsAfter: null,
        outcome: null,
        createdAt: 0,
        auditedAt: null,
        ...overrides,
      }
    }

    function finding(file: string, line: number, description: string, sectionIndex: number | null = null): ReviewFindingRow {
      return { file, line, severity: 'bug', description, scenario: null, loopName: 'test-loop', sectionIndex, projectId: 'p', createdAt: 0 }
    }

    function ctxWithAttempts(attempts: LoopAttemptRow[], extra?: Partial<PromptContext>): PromptContext {
      return makeCtx({
        getAttemptHistory: () => attempts,
        ...extra,
      })
    }

    test('coder continuation includes latest coder decisions in full plus older excerpts bounded', () => {
      const newestBody = 'z'.repeat(900)
      const attempts = [
        makeAttemptRow({ id: 2, attemptNumber: 2, scope: 'plan', coderDecisions: `NEWEST ${newestBody}`, outcome: 'dirty', findingsAfter: [finding('src/a.ts', 5, 'Historical bug')] }),
        makeAttemptRow({ id: 1, attemptNumber: 1, scope: 'plan', coderDecisions: `OLD ${LONG_NOTE_BODY}`, outcome: 'clean' }),
      ]
      const result = buildContinuationPrompt(ctxWithAttempts(attempts), { ...defaultState })
      expect(result).toContain('## Audit attempt history (scope: plan)')
      expect(result).toContain(`NEWEST ${newestBody}`)
      expect(result).toContain('OLD ' + 'y'.repeat(316))
      expect(result).not.toContain('y'.repeat(400))
      expect(result).toContain('Attempt 2 (scope plan, iteration 1) — outcome: dirty; findings after: x:src/a.ts:5')
      expect(result).toContain('Attempt 1 (scope plan, iteration 1) — outcome: clean')
    })

    test('auditor history omits the latest coder notes and renders prior fixes as excerpts', () => {
      const attempts = [
        makeAttemptRow({ id: 2, attemptNumber: 2, coderDecisions: 'LATEST-ONLY-MARKER decisions', outcome: 'dirty' }),
        makeAttemptRow({ id: 1, attemptNumber: 1, coderDecisions: 'PRIOR-FIX-MARKER decisions', outcome: 'dirty' }),
      ]
      const result = buildSectionAuditPrompt(ctxWithAttempts(attempts, { getCoderDecisions: () => null }), { ...sectionState })
      expect(result).not.toContain('LATEST-ONLY-MARKER')
      expect(result).toContain('Prior attempted coder decisions (bounded excerpts)')
      expect(result).toContain('PRIOR-FIX-MARKER')
    })

    test('historical findings render as location identifiers, not auditor prose', () => {
      const attempts = [
        makeAttemptRow({ id: 1, attemptNumber: 1, outcome: 'dirty', findingsAfter: [finding('src/a.ts', 5, 'SECRET-AUDITOR-PROSE'), finding('src/b.ts', 9, 'Another prose detail', 1)] }),
      ]
      const result = buildAttemptHistoryBlock(ctxWithAttempts(attempts), { ...defaultState }, 'coder')
      expect(result).toContain('x:src/a.ts:5')
      expect(result).toContain('1:src/b.ts:9')
      expect(result).not.toContain('SECRET-AUDITOR-PROSE')
      expect(result).not.toContain('Another prose detail')
    })

    test('history policy states records are not current tasks and carry no correctness guarantee', () => {
      const result = buildAttemptHistoryBlock(ctxWithAttempts([makeAttemptRow({ id: 1, attemptNumber: 1 })]), { ...defaultState }, 'coder')
      expect(result).toContain('not current tasks')
      expect(result).toContain('current outstanding findings')
      expect(result).toContain('does not guarantee correctness')
    })

    test('first audit renders no history block and no delta commands', () => {
      const ctx = makeCtx()
      for (const result of [
        buildSectionAuditPrompt(ctx, { ...sectionState }),
        buildAuditPrompt(ctx, { ...defaultState, iteration: 2 }),
      ]) {
        expect(result).not.toContain('Audit attempt history')
        expect(result).not.toContain('git diff --no-ext-diff')
      }
    })

    test('missing getAttemptHistory on the context renders nothing', () => {
      const result = buildContinuationPrompt(makeCtx(), { ...defaultState })
      expect(result).not.toContain('Audit attempt history')
    })

    test('delta-eligible pending attempt renders the exact diff command and full obligations', () => {
      const attempts = [
        makeAttemptRow({ id: 3, attemptNumber: 3, scope: 'section:0', iteration: 2, outcome: null, snapshotCommit: DELTA_CUR, previousCommit: DELTA_PREV, diffSummary: 'src/a.ts | 2 ++' }),
      ]
      const result = buildSectionAuditPrompt(ctxWithAttempts(attempts), { ...sectionState })
      expect(result).toContain(`git diff --no-ext-diff --no-textconv ${DELTA_PREV} ${DELTA_CUR} --`)
      expect(result).toContain('src/a.ts | 2 ++')
      expect(result).toContain('Delta audit ordering (delta-first, not delta-only)')
      expect(result).toContain('verify ALL outstanding findings')
      expect(result).toContain('affected callers/contracts')
      expect(result).toContain('acceptance criteria in scope')
      expect(result).toContain('Rerun any verification the delta invalidated')
      expect(result).toContain('explicit plan checks')
      expect(result).toContain('Expand beyond the delta')
      expect(result).toContain('fall back to the full established scope')
      expect(result).toContain('last known previously audited span')
    })

    test('malformed snapshot SHA renders no git command and falls back to full scope', () => {
      const attempts = [
        makeAttemptRow({ id: 2, attemptNumber: 2, scope: 'section:0', outcome: null, snapshotCommit: 'deadbeef-short', previousCommit: DELTA_PREV }),
      ]
      const result = buildSectionAuditPrompt(ctxWithAttempts(attempts), { ...sectionState })
      expect(result).not.toContain('git diff --no-ext-diff')
      expect(result).toContain('No usable snapshot delta')
    })

    test('fallbackReason on the latest attempt renders full-scope fallback without a diff command', () => {
      const attempts = [
        makeAttemptRow({ id: 2, attemptNumber: 2, scope: 'section:0', outcome: null, snapshotCommit: DELTA_CUR, previousCommit: DELTA_PREV, fallbackReason: 'snapshot ref pruned' }),
      ]
      const result = buildSectionAuditPrompt(ctxWithAttempts(attempts), { ...sectionState })
      expect(result).not.toContain('git diff --no-ext-diff')
      expect(result).toContain('No usable snapshot delta')
      expect(result).toContain('snapshot ref pruned')
      expect(result).toContain('full established scope')
    })

    test('section initial wrapper includes history; standalone Text builder does not', () => {
      const attempts = [makeAttemptRow({ id: 1, attemptNumber: 1, outcome: 'dirty' })]
      const wrapper = buildSectionInitialPrompt(ctxWithAttempts(attempts), { ...sectionState })
      expect(wrapper).toContain('Audit attempt history')
      const standalone = buildSectionInitialPromptText({
        currentSectionIndex: 0,
        totalSections: 2,
        iteration: 1,
        maxIterations: 5,
        sectionContent: 'Section plan for 1',
      })
      expect(standalone).not.toContain('Audit attempt history')
    })

    test('history requests use the shared limit of 4 attempts', () => {
      const getAttemptHistory = vi.fn(() => [])
      const ctx = makeCtx({ getAttemptHistory })
      buildContinuationPrompt(ctx, { ...defaultState })
      expect(getAttemptHistory).toHaveBeenCalledWith(expect.objectContaining({ loopName: 'test-loop' }), ATTEMPT_HISTORY_LIMIT)
    })

    test('section audit retains the full acceptance scope and clarifies repeat ordering', () => {
      const result = buildSectionAuditPrompt(makeCtx(), { ...sectionState })
      expect(result).toContain("this section's work is all uncommitted changes plus any commits made after the most recent")
      expect(result).toContain('full scope is the acceptance scope on every section audit')
      expect(result).toContain('the delta orders the review, it does not replace the full scope')
    })

    test('audit prompts point to the attempts pagination usage of review-read', () => {
      for (const result of [
        buildSectionAuditPrompt(makeCtx(), { ...sectionState }),
        buildAuditPrompt(makeCtx(), { ...defaultState, iteration: 2 }),
      ]) {
        expect(result).toContain('{attempts: true, beforeId: <id>, limit: <n>}')
      }
    })
  })
})

describe('audit prompts use the exact base commit', () => {
  const SHA = 'c'.repeat(40)

  test('non-sectioned plan audit states the base commit when set', () => {
    const result = buildAuditPrompt(makeCtx(), { ...defaultState, iteration: 2, baseCommit: SHA })
    expect(result).toContain(`Review scope: every commit since base commit \`${SHA}\``)
  })

  test('non-sectioned plan audit omits base-commit wording when unset', () => {
    const result = buildAuditPrompt(makeCtx(), { ...defaultState, iteration: 2 })
    expect(result).not.toContain('base commit')
    expect(result).not.toContain('Review scope:')
  })
})
