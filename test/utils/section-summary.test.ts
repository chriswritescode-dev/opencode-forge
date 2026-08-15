import { describe, test, expect } from 'vitest'
import { SECTION_SUMMARY_START_MARKER, SECTION_SUMMARY_END_MARKER } from '../../src/utils/section-summary'
import { buildSectionAuditPrompt } from '../../src/loop/prompts'
import type { PromptContext } from '../../src/loop/prompts'
import type { LoopState } from '../../src/loop/state'

describe('section-summary markers', () => {
  test('constants are HTML comment markers', () => {
    expect(SECTION_SUMMARY_START_MARKER).toBe('<!-- section-summary:start -->')
    expect(SECTION_SUMMARY_END_MARKER).toBe('<!-- section-summary:end -->')
  })

  test('buildSectionAuditPrompt is the single owner of the summary template', () => {
    const ctx: PromptContext = {
      getPlanTextForState: () => null,
      getOutstandingFindings: () => [],
      formatReviewFindings: () => 'No review findings found.',
      getSectionPlan: () => ({
        projectId: 'p', loopName: 'l', sectionIndex: 0, title: 'S1', content: 'Section plan',
        status: 'in_progress', attempts: 0, summaryDone: null, summaryDeviations: null,
        summaryFollowUps: null, startedAt: null, completedAt: null, createdAt: 0,
      }),
      getCompletedSectionDigest: () => [],
      getCoderDecisions: () => null,
      getFindingRecurrence: () => new Map(),
    }
    const state = {
      loopName: 'l', sessionId: 's', active: true, phase: 'auditing',
      iteration: 1, maxIterations: 5, errorCount: 0,
      currentSectionIndex: 0, totalSections: 2,
    } as unknown as LoopState

    const prompt = buildSectionAuditPrompt(ctx, state)
    expect(prompt).toContain(SECTION_SUMMARY_START_MARKER)
    expect(prompt).toContain(SECTION_SUMMARY_END_MARKER)
  })
})
