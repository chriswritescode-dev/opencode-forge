import type { LoopState } from './state'
import type { ReviewFindingRow } from '../storage/repos/review-findings-repo'
import type { SectionPlanRow } from '../storage/repos/section-plans-repo'
import { SECTION_SUMMARY_START_MARKER, SECTION_SUMMARY_END_MARKER } from '../utils/section-summary'

export interface SectionDigestEntry {
  index: number
  title: string
  summaryDone: string | null
  summaryDeviations: string | null
  summaryFollowUps: string | null
}

export interface PromptContext {
  getPlanTextForState(state: LoopState): string | null
  getOutstandingFindings(loopName?: string, severity?: 'bug' | 'warning'): ReviewFindingRow[]
  formatReviewFindings(loopName?: string): string
  getSectionPlan(state: LoopState, index: number): SectionPlanRow | null
  getCompletedSectionDigest(state: LoopState): SectionDigestEntry[]
}

function formatSectionsSummary(digest: SectionDigestEntry[]): string {
  return digest.map(s => {
    let parts = `## Section ${s.index + 1}: ${s.title}`
    if (s.summaryDone) parts += `\n### Done\n${s.summaryDone}`
    if (s.summaryDeviations) parts += `\n### Deviations\n${s.summaryDeviations}`
    if (s.summaryFollowUps) parts += `\n### Follow-ups\n${s.summaryFollowUps}`
    return parts
  }).join('\n\n')
}

export function buildContinuationPrompt(ctx: PromptContext, state: LoopState, auditFindings?: string): string {
  if (state.totalSections > 0) {
    return buildSectionContinuationPrompt(ctx, state, auditFindings || '')
  }

  let systemLine = `Loop iteration ${String(state.iteration)}`
  if (state.maxIterations > 0) {
    systemLine += ` / ${String(state.maxIterations)}`
  } else {
    systemLine += ` | No max iterations set - loop runs until auditor all-clear or cancelled`
  }

  let prompt = `[${systemLine}]`

  if (auditFindings) {
    prompt += `\n\n---\nThe code auditor reviewed your changes. You MUST address all bugs and convention violations below — do not dismiss findings as unrelated to the task. Fix them directly without creating a plan or asking for approval.\n\n${auditFindings}`
  }

  const outstandingFindings = ctx.getOutstandingFindings(state.loopName)
  if (outstandingFindings.length > 0) {
    const findingKeys = outstandingFindings.map((f) => `- \`${f.file}:${f.line}\``).join('\n')
    prompt += `\n\n---\n⚠️ Outstanding Review Findings (${String(outstandingFindings.length)})\n\nThese review findings are blocking loop completion. Fix these issues so they pass the next audit review.\n\n${findingKeys}`
  }

  return prompt
}

export function buildAuditPrompt(ctx: PromptContext, state: LoopState): string {
  if (state.totalSections > 0) {
    if (state.phase === 'final_auditing') {
      return buildFinalAuditPrompt(ctx, state)
    }
    return buildSectionAuditPrompt(ctx, state)
  }

  const branchInfo = state.worktreeBranch ? ` (branch: ${state.worktreeBranch})` : ''
  const planText = ctx.getPlanTextForState(state) ?? 'Plan not found in plan store.'
  const reviewFindings = ctx.formatReviewFindings(state.loopName)

  return [
    `Post-iteration ${String(state.iteration)} code review${branchInfo}.`,
    '',
    'Implementation plan:',
    planText,
    '',
    'Existing review findings:',
    reviewFindings,
    '',
    'Review the code changes against the plan phases and verify per-phase acceptance criteria are met.',
    'Review the code changes in this worktree. Focus on bugs, logic errors, missing error handling, and convention violations.',
    'If you find bugs in related code that affect the correctness of this task, report them — even if the buggy code was not directly modified.',
    'For each existing finding above, verify whether it has been resolved. Delete resolved findings with review-delete and report any unresolved findings that still apply.',
    'If everything looks good, state "No issues found." clearly.',
    '',
    'Plan completeness check:',
    '- For every plan phase, verify it is fully implemented and its acceptance criteria are met.',
    '- If any phase is unimplemented, partially implemented, or its acceptance criteria are not met, you MUST write a `severity: "bug"` finding describing exactly which phase and what is missing. Use `file` = the phase\'s target file when possible, otherwise use a stable pseudo-path such as `PLAN:phase-<N>`. Use `line` = 1 when no specific line applies.',
    '- When a previously reported "phase incomplete" finding is now resolved, delete it with review-delete.',
    '- Outstanding `bug` findings block loop termination. The loop cannot complete while any `bug` finding remains.',
    '',
    'This is an automated loop — do not direct the agent to "create a plan" or "present for approval." Just report findings directly.',
  ].join('\n')
}

export function buildDecomposerInitialPrompt(ctx: PromptContext, state: LoopState): string {
  const planText = ctx.getPlanTextForState(state) ?? 'Plan not found in plan store.'
  return `[Decomposing master plan into section plans]\n\n${planText}`
}

export function buildSectionInitialPrompt(ctx: PromptContext, state: LoopState): string {
  const idx = state.currentSectionIndex
  const total = state.totalSections
  const iter = state.iteration
  const maxIter = state.maxIterations
  const section = ctx.getSectionPlan(state, idx)
  if (!section) return ''

  const digest = ctx.getCompletedSectionDigest(state)
  let header = `[Loop section ${idx + 1}/${total} -- iteration ${iter}/${maxIter}]`

  if (digest.length > 0) {
    header += `\n\n### Prior Sections' Summaries\n${formatSectionsSummary(digest)}`
  }

  header += `\n\n## Section plan\n${section.content}`

  return header
}

export function buildSectionAuditPrompt(ctx: PromptContext, state: LoopState): string {
  const idx = state.currentSectionIndex
  const total = state.totalSections
  const section = ctx.getSectionPlan(state, idx)
  if (!section) return ''

  const digest = ctx.getCompletedSectionDigest(state)
  let header = `[Loop section audit ${idx + 1}/${total}]`

  if (digest.length > 0) {
    header += `\n\n### Prior Sections' Summaries\n${formatSectionsSummary(digest)}`
  }

  header += `\n\n## Section under audit\n${section.content}`

  header += `\n\n---\nAudit instructions:\n- Use review-read to see findings for this section.\n- Delete resolved findings.\n- Write severity: bug findings for unmet acceptance criteria or failed verification (defaults to current section_index).\n- When the section is clear, end your response with:\n${SECTION_SUMMARY_START_MARKER}\n### Done\n- bullets describing what was implemented\n### Deviations\n- bullets describing places implementation differs from this section plan, with reasons (or "none")\n### Follow-ups\n- bullets noting items deferred to later sections (or "none")\n${SECTION_SUMMARY_END_MARKER}`

  return header
}

export function buildSectionContinuationPrompt(ctx: PromptContext, state: LoopState, auditText: string): string {
  const idx = state.currentSectionIndex
  const total = state.totalSections
  const iter = state.iteration
  const maxIter = state.maxIterations
  const section = ctx.getSectionPlan(state, idx)
  if (!section) return ''

  const digest = ctx.getCompletedSectionDigest(state)
  let header = `[Loop section ${idx + 1}/${total} -- iteration ${iter}/${maxIter} (continuation)]`

  if (digest.length > 0) {
    header += `\n\n### Prior Sections' Summaries\n${formatSectionsSummary(digest)}`
  }

  header += `\n\n## Section plan\n${section.content}`
  header += `\n\n---\n## Auditor feedback from previous attempt\n${auditText}`

  const outstandingFindings = ctx.getOutstandingFindings(state.loopName, 'bug')
    .filter(f => f.sectionIndex === idx)
  if (outstandingFindings.length > 0) {
    const findingKeys = outstandingFindings.map(f => `- \`${f.file}:${f.line}\``).join('\n')
    header += `\n\n---\n## Outstanding findings\n${findingKeys}`
  }

  return header
}

export function buildFinalAuditPrompt(ctx: PromptContext, state: LoopState): string {
  const planText = ctx.getPlanTextForState(state) ?? 'Plan not found in plan store.'
  const digest = ctx.getCompletedSectionDigest(state)

  let header = `[Final integration audit]`
  header += `\n\n## Master Plan\n${planText}`

  if (digest.length > 0) {
    header += `\n\n### Completed Sections' Summaries\n${formatSectionsSummary(digest)}`
  }

  header += `\n\n---\nFinal audit instructions:\n- Verify the master plan's top-level Verification commands and acceptance criteria.\n- Use the per-section ### Deviations entries to interpret discrepancies. If a discrepancy is explained by a deviation, accept it unless it materially breaks the master plan's top-level Verification.\n- Write findings with sectionIndex pointing to the section you believe contains the bug. Use crossSection: true only when the bug spans multiple sections.\n- The loop terminates automatically when there are no outstanding bug-severity findings. Do not write findings unless they describe real, blocking issues.`

  return header
}
